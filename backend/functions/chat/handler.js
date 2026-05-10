"use strict";

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { randomUUID } = require("crypto");

const { putItem, queryPk, queryGsi2 } = require("/opt/nodejs/db");
const {
  listProfessors,
  getMyConsultations,
  cancelConsultation,
  findTopicMatches,
  bookSlotCore,
  joinGroupCore,
  normalizeConsultationType,
  combineSlotInstantUtc,
} = require("/opt/nodejs/consultations");
const {
  joinWaitlist,
  leaveWaitlist,
  listWaitlistForStudent,
} = require("/opt/nodejs/waitlist");
const {
  getCurrentMentorshipForStudent,
  listMentorshipsForStudent,
} = require("/opt/nodejs/mentorship");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION,
});

// ---------- Tool definitions ----------
//
// The chat surface serves two very different audiences:
//   - students: full booking workflow (find professors, slots, book, join,
//     cancel)
//   - professors: a small floating widget that helps them understand their
//     own upcoming reservations
//
// Tool definitions are split into role-specific bundles so a professor can
// never see / call a student-only tool like book_slot through the model,
// even if they were to drop into the chat surface unexpectedly. The role
// gate inside runTool is the second line of defense.

const STUDENT_TOOLS = [
  {
    toolSpec: {
      name: "list_professors",
      description:
        "Find professors. Pass any combination of nameFilter, subjectFilter, " +
        "and departmentFilter to narrow the result set. Server does the " +
        "matching and returns a structured response with status " +
        "single_match / ambiguous / no_match / all. Omit all filters to list everyone. " +
        "Each professor object includes professorId, name, department, " +
        "subjects, and maxMentees (the count of thesis mentees they're " +
        "willing to take on, 0 means they don't accept thesis mentees at all).",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            nameFilter: {
              type: "string",
              description:
                "Partial name the user mentioned, e.g. 'jovanovic'. " +
                "Server does the matching — never match names yourself.",
            },
            subjectFilter: {
              type: "string",
              description:
                "Partial subject the user mentioned, e.g. 'databases', " +
                "'algorithms', 'machine learning'. Use this when the student " +
                "asks for a professor by what they teach (\"I need a math " +
                "professor\", \"someone for SQL\"). Server matches against " +
                "each professor's subject list.",
            },
            departmentFilter: {
              type: "string",
              description:
                "Partial department the user mentioned, e.g. 'computer " +
                "science', 'mathematics'. Use when the student asks by " +
                "department (\"someone from CS\").",
            },
          },
          required: [],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_professor_slots",
      description:
        "Get available slots for a professor in a date range. Returns " +
        "{ slots, joinableMatches }: `slots` is the list of bookable slots; " +
        "`joinableMatches` is a (usually empty) list of EXISTING group " +
        "sessions whose topic is similar enough that the student could join " +
        "them instead of booking a fresh slot. Pass `topic` when you have a " +
        "short phrase the student wants to discuss with THIS professorId " +
        "(so joinableMatches can be computed); omit it on type-discovery " +
        "peek calls. Each slot also " +
        "carries `alreadyBookedByYou: boolean` — true when the current " +
        "student already has an active reservation on that exact slot; " +
        "DO NOT offer those slots as fresh bookings. Each slot AND each " +
        "joinableMatch carries `consultationType` (general | exam_prep | " +
        "thesis) and an optional `subject`; pass the optional " +
        "`consultationType` argument to filter to a specific kind. " +
        "professorId MUST be the UUID returned by list_professors, never a name.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description:
                "EXACT professorId UUID from list_professors. Never a name.",
            },
            dateFrom: { type: "string", description: "YYYY-MM-DD" },
            dateTo: { type: "string", description: "YYYY-MM-DD" },
            topic: {
              type: "string",
              description:
                "What the student wants to discuss with THIS professor, in " +
                "their own words (e.g. 'SQL joins'). Used ONLY to compute " +
                "joinableMatches; it does not filter `slots`. Do NOT pass a " +
                "topic gathered for a different professor unless the user " +
                "just confirmed it applies to this one. Omit on peek calls " +
                "where type is still unknown.",
            },
            consultationType: {
              type: "string",
              description:
                "Optional. One of 'general', 'exam_prep', 'thesis'. When " +
                "set, only slots of that type are returned in `slots`. " +
                "Use 'exam_prep' when the student asks about exam / " +
                "midterm / kolokvijum preparation. Use 'thesis' when the " +
                "student talks about their thesis, mentor, diploma topic, " +
                "or final-year project. Otherwise omit.",
            },
            subject: {
              type: "string",
              description:
                "Optional. Subject / course name to filter slots by " +
                "(e.g. 'Operating Systems'). Useful for exam_prep where " +
                "the subject identifies which exam.",
            },
          },
          required: ["professorId", "dateFrom", "dateTo"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "book_slot",
      description:
        "Book a consultation slot SOLO for the current student. " +
        "Only call after the user explicitly confirmed the chosen slot. " +
        "By this point you must already know what the student wants to " +
        "discuss — the topic is collected up-front in the flow.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description:
                "EXACT professorId UUID from list_professors. Never a name.",
            },
            slotSK: {
              type: "string",
              description:
                "EXACT slotSK from get_professor_slots, e.g. SLOT#2026-05-06T10:00. Do not reformat.",
            },
            note: {
              type: "string",
              description:
                "What the student wants to discuss with THIS professor on " +
                "THIS slot — not a topic from an earlier message about a " +
                "different professor unless the user confirmed it applies here. " +
                "In their own words (e.g. 'SQL joins'). Used as the " +
                "consultation topic and for semantic embedding. Empty string " +
                "only if the student explicitly has nothing specific.",
            },
          },
          required: ["professorId", "slotSK"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_my_consultations",
      description: "Get upcoming consultations for the current user",
      inputSchema: { json: { type: "object", properties: {}, required: [] } },
    },
  },
  {
    toolSpec: {
      name: "cancel_consultation",
      description:
        "Cancel a consultation booking. Pass the optional `reason` when the " +
        "user volunteered one — it gets stamped on the row, included in the " +
        "notification to the other party, and surfaced in analytics.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            consultationId: { type: "string" },
            reason: {
              type: "string",
              description:
                "Optional short free-form reason the user gave for cancelling " +
                "(e.g. 'I'm sick', 'lecture clash'). Empty string when no " +
                "reason was offered.",
            },
          },
          required: ["consultationId"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "join_group_session",
      description:
        "Join an existing consultation that get_professor_slots surfaced in " +
        "joinableMatches as a good topic fit. Only call after the user " +
        "explicitly confirms they want to join. This increases the slot's " +
        "currentParticipants and notifies existing participants. Use the " +
        "EXACT slotSK that came from joinableMatches.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description: "EXACT professorId UUID from list_professors. Never a name.",
            },
            slotSK: {
              type: "string",
              description:
                "EXACT slotSK from get_professor_slots' joinableMatches. " +
                "Do not reformat.",
            },
            note: {
              type: "string",
              description:
                "What the student wants to discuss on THIS slot with THIS " +
                "professor — same scoping as book_slot `note`; not recycled " +
                "from another professor unless the user confirmed.",
            },
          },
          required: ["professorId", "slotSK"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "join_waitlist",
      description:
        "Add the current student to the waitlist for a slot that is full. " +
        "ONLY call this AFTER book_slot or join_group_session returned a " +
        "slot_full / capacity-exceeded error AND the user explicitly opted " +
        "to wait for a seat to open. The waitlist is notify-only: when a " +
        "seat frees up, the longest-waiting student gets a 'seat_opened' " +
        "notification — they still have to manually book the slot. Do NOT " +
        "ask the student for a topic or note before joining the waitlist; " +
        "the waitlist only needs the slot.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description: "EXACT professorId UUID. Never a name.",
            },
            slotSK: {
              type: "string",
              description:
                "EXACT slotSK from get_professor_slots, e.g. SLOT#2026-05-06T10:00.",
            },
          },
          required: ["professorId", "slotSK"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_my_waitlist",
      description:
        "List every slot the current student is on the waitlist for, with " +
        "professor name, date, time, topic, and consultation type. Use this " +
        "to answer 'where am I queued?' style questions or before calling " +
        "leave_waitlist so you can confirm which slot the user means.",
      inputSchema: { json: { type: "object", properties: {}, required: [] } },
    },
  },
  {
    toolSpec: {
      name: "leave_waitlist",
      description:
        "Remove the current student from a slot's waitlist. Confirm with the " +
        "user before calling. Pass the EXACT slotSK from get_my_waitlist.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description: "EXACT professorId UUID from get_my_waitlist.",
            },
            slotSK: {
              type: "string",
              description: "EXACT slotSK from get_my_waitlist.",
            },
          },
          required: ["professorId", "slotSK"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "propose_thesis",
      description:
        "Submit a thesis proposal: book a thesis slot AND attach the user's " +
        "thesis theme. Use this whenever the user wants to start a thesis " +
        "with a specific professor (\"propose a thesis\", \"do my thesis " +
        "with X\"). Also use it when book_slot returned the structured " +
        "error THESIS_THEME_REQUIRED — that means the user picked a thesis " +
        "slot without giving you a theme yet. Collect a 1-paragraph theme " +
        "first, confirm with the user, THEN call this tool.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            professorId: {
              type: "string",
              description: "EXACT professorId UUID from list_professors.",
            },
            slotSK: {
              type: "string",
              description: "EXACT slotSK of an open thesis slot.",
            },
            theme: {
              type: "string",
              description:
                "The student's thesis theme — one short paragraph. Required.",
            },
          },
          required: ["professorId", "slotSK", "theme"],
        },
      },
    },
  },
  {
    toolSpec: {
      name: "get_my_thesis_status",
      description:
        "Look up the calling student's current thesis mentorship state " +
        "(none / pending / accepted / declined) plus their full proposal " +
        "history. Use this whenever the user asks about thesis status, " +
        "their mentor, or before suggesting they propose a new thesis.",
      inputSchema: { json: { type: "object", properties: {}, required: [] } },
    },
  },
];

// Professor-facing tools. The professor widget is read-only by design:
// professors should not be able to mutate consultations through the chat
// surface (booking on behalf of students, cancelling a session) — those
// flows live in the dedicated UI where confirmations and audit trails are
// clearer. The widget is for "what's on my plate this week?" Q&A only.
const PROFESSOR_TOOLS = [
  {
    toolSpec: {
      name: "get_my_consultations",
      description:
        "Get the professor's upcoming consultations. Returns each booking " +
        "with date, time, topic, the student's name and email, plus the slot " +
        "capacity. Use this for any question about the professor's schedule, " +
        "who is coming, what topics are scheduled, etc.",
      inputSchema: { json: { type: "object", properties: {}, required: [] } },
    },
  },
];

function getToolsForRole(role) {
  if (role === "professor") return PROFESSOR_TOOLS;
  return STUDENT_TOOLS;
}

// ---------- System prompts ----------

function buildSystemPrompt(caller, today) {
  if (caller.role === "professor") {
    return [{ text: buildProfessorPrompt(caller, today) }];
  }
  return [{ text: buildStudentPrompt(caller, today) }];
}

function buildStudentPrompt(caller, today) {
  return `
You are a university consultation scheduling assistant.
Current user: ${caller.displayName}, role: ${caller.role}, userId: ${caller.userId}
Today's date: ${today}


══════════════════════════════════════════════════════════════════════
SECTION 1 — GROUND RULES (apply to every turn, no exceptions)
══════════════════════════════════════════════════════════════════════

R1. Use tools for real data. NEVER invent IDs, names, dates, or slot
    times.
R2. Pass identifiers verbatim from the tool that produced them:
      - professorId   → from list_professors
      - slotSK        → from get_professor_slots / get_my_waitlist
      - consultationId → from get_my_consultations
    Never reformat them. Never use a name as a UUID.
R3. NEVER call a state-changing tool until you have ALL required
    information for that workflow (see SECTION 3 checklists). If
    something is missing, your next reply is a single short question
    for the missing piece — and nothing else.

R4. ★★★ CONFIRMATION GATE (the most important rule in this prompt).
    State-changing tools are: book_slot, join_group_session,
    join_waitlist, leave_waitlist, propose_thesis, cancel_consultation.

    Before you call ANY of those tools, BOTH of these must be true:

      (a) Your IMMEDIATELY-PREVIOUS assistant message in this thread
          was a plain-text confirmation summary that named the
          professor + the date+time + the topic / theme (or just
          professor + date+time for the waitlist), ending with an
          explicit yes/no question ("Shall I go ahead?" /
          "Da li da nastavim?" / equivalent).
      (b) The USER'S MOST-RECENT message AFTER that summary is an
          explicit yes / approval — examples that count:
              "yes", "yes please", "go ahead", "sure", "do it",
              "confirm", "potvrđujem", "da", "može", "ok".
          Examples that DO NOT count:
              the user's original booking request,
              another piece of info (a topic, a date, a time, a name),
              "1", "2", "3" picking a slot from a list,
              questions, hesitations, or anything ambiguous.

    If (a) and (b) are not BOTH true, you MUST NOT call a state-
    changing tool this turn. Send the confirmation summary (or ask
    for the missing info first) and wait for the user's reply.

    The user's INITIAL booking request ("book me a session with X
    on Friday at 10:00") is NEVER confirmation. They are asking
    you to start the flow, not approving a final booking — even
    if every required field is present in their request.

    Pre-tool-call self-check (do this silently every time, BEFORE
    you emit a tool call):
      1. Did I, on my last assistant turn, send a confirmation
         summary for THIS exact action? If no → stop, send the
         summary now.
      2. Did the user's last message say YES to that summary? If
         no → stop, wait or re-ask.
      Only when both answers are YES may you call the tool.

R4b. The CONFIRMATION GATE applies separately to every distinct
     state-changing action. If the user changes their mind ("on
     Wednesday instead", "different topic", "Professor Y instead"),
     the gate RESETS — you must send a NEW confirmation summary
     for the updated booking and wait for a new yes.
     If they switch PROFESSOR (new WHO / new professorId), you must
     also reset WHAT for GENERAL bookings: do NOT reuse a topic
     gathered for another professor unless the user clearly repeats
     that same topic for the new professor in their recent messages.
     When in doubt, ask one short topic question for the new
     professor.

R5. Never narrate tool calls ("let me check…", "I searched…",
    "I found no similar sessions…"). Just speak from the result.
R6. Never include consultationId, UUID, slotSK, GSI keys, or any
    technical identifier in user-facing prose.
R7. Respond in the SAME LANGUAGE the user writes in (Serbian or
    English). Keep replies short, warm, free of jargon.
R8. If the user asks something unrelated to consultations / bookings
    / cancellations / waitlist / thesis / their schedule, politely
    redirect.


══════════════════════════════════════════════════════════════════════
SECTION 2 — DOMAIN GLOSSARY (read this once, then use it)
══════════════════════════════════════════════════════════════════════

Consultation types (every slot has one):
  • general    — regular office-hour consultation. Default.
  • exam_prep  — group session for an upcoming exam / midterm /
                 kolokvijum / ispit. Multiple students share the time.
                 Carries a \`subject\` (e.g. "Operating Systems").
  • thesis     — 1-on-1 session for an end-of-degree thesis. Bookable
                 ONLY through the thesis workflow (SECTION 4.B), not
                 as a generic consultation.

Type-inference rule for get_professor_slots' \`consultationType\` arg:
  • thesis    → user mentioned thesis, diplomski, master rad,
                graduation thesis, thesis mentor, thesis proposal,
                tema diplomskog, mentorski rad, final-year project.
  • exam_prep → user mentioned exam, midterm, kolokvijum, ispit,
                final, prep, priprema (any case / language).
  • Otherwise → omit the arg so all kinds come back.

Thesis mentorship (returned by get_my_thesis_status as currentStatus):
  • none      — student has never proposed (or has only declined
                attempts). They MAY propose to any professor with
                maxMentees > 0.
  • pending   — student already proposed; waiting on the professor.
                NO new thesis bookings allowed until the professor
                decides.
  • accepted  — student has an accepted thesis mentor. ALL further
                thesis bookings go to that one professor; the theme
                is reused from the snapshot.
  • declined  — most recent attempt was declined. Behave like "none"
                for the next proposal.

Who counts as a thesis mentor:
  ANY professor with \`maxMentees > 0\` on their list_professors row.
  There is NO "thesis specialization" tag, NO inference from
  subjects/department/name. \`maxMentees\` is the ONLY source of truth.
  • maxMentees > 0  → they accept thesis mentees, offer them.
  • maxMentees == 0 → they do NOT, never suggest them for thesis.
  Forbidden phrasing: "no professor specializes in thesis mentorship".
  When zero professors have maxMentees > 0, say instead:
  "no professor is currently accepting new thesis mentees".


══════════════════════════════════════════════════════════════════════
SECTION 3 — INFORMATION CHECKLISTS (per workflow)
══════════════════════════════════════════════════════════════════════

Before you summarize-and-confirm anything, you must hold ALL the
items in the relevant checklist. If any item is missing, ask for
exactly that item next, and nothing else.

CHECKLIST A — General / exam_prep booking
  [ ] WHO   — professor (resolved → professorId UUID)
  [ ] WHEN  — a specific slot (resolved → slotSK)
  [ ] WHAT  — topic (canonical short noun phrase)
  Tool to call after confirmation: book_slot
                                   (or join_group_session if the
                                   chosen item came from joinableMatches)

CHECKLIST B — Thesis NEW PROPOSAL (currentStatus = none / declined)
  [ ] WHO   — professor with maxMentees > 0 (→ professorId UUID)
  [ ] WHEN  — a thesis slot from THAT professor (→ slotSK)
  [ ] THEME — 1-paragraph thesis theme (NOT just a topic word)
  Tool: propose_thesis

CHECKLIST C — Thesis UPDATE (currentStatus = accepted)
  [ ] WHO   — fixed: currentProfessorId from get_my_thesis_status.
              DO NOT offer or accept any other professor.
  [ ] WHEN  — a thesis slot from that mentor (→ slotSK)
  [ ] THEME — already known (reused from snapshot). Do NOT ask again.
  Tool: propose_thesis (server reuses the theme when status=accepted;
        you may pass an empty theme).

CHECKLIST D — Cancellation
  [ ] WHICH — the consultation to cancel (→ consultationId).
              If the user's words match more than one row, ask
              which one before continuing.

CHECKLIST E — Waitlist (only AFTER a slot_full error from a booking)
  [ ] WHO + WHEN + WHAT already resolved during the failed booking.
  [ ] User explicitly said "I want to wait for a seat".


══════════════════════════════════════════════════════════════════════
SECTION 4 — WORKFLOWS
══════════════════════════════════════════════════════════════════════

──────────────────────────────────────────────────────────────────────
4.A — RESOLUTION HELPERS (used by every workflow below)
──────────────────────────────────────────────────────────────────────

Resolve WHO (the professor):
  • Name mentioned          → list_professors(nameFilter=user's text).
  • Subject mentioned       → list_professors(subjectFilter=user's text).
  • Department mentioned    → list_professors(departmentFilter=user's text).
  • Nothing specific        → list_professors() with no filter.
  • Combine filters when the user gave more than one piece of info.
  • Pass the user's wording verbatim — do NOT paraphrase.
  Read the response status:
    - single_match → use professor.professorId. Do not re-ask.
    - ambiguous   → list each match (full name + department) and ask
                    which one. Do NOT proceed until the user picks.
    - no_match    → say nobody matched, offer to list everyone.
    - all         → use the full list when the user asked for everyone.

Resolve WHAT (the topic, for general / exam_prep bookings):
  • EXCEPTION — exam_prep slots already carry their topic.
    If the user pre-selected a date+time, OR you have already
    looked up the slot via get_professor_slots, AND the matching
    slot has \`consultationType = "exam_prep"\`, the topic is
    AUTO-DERIVED from the slot's \`subject\` field. Do NOT ask the
    student "what topic?" / "what would you like to discuss?". The
    canonical topic is exactly the slot's \`subject\` (e.g. "Operating
    Systems", "Web Programming"). Pass that string as the \`topic\`
    arg to book_slot / join_group_session, and refer to the
    session as "exam prep for {subject}" in the confirmation
    summary. This is the ONLY topic-source for exam_prep bookings.
  • For all other (general) bookings: a topic is a CONTENT noun.
    Acceptable: "SQL joins", "React hooks", "graph algorithms",
    "midterm review", "Node", "AWS", "SQL", "thesis".
  • Single-word answers are valid topics. If you just asked
    "what topic?" and the user typed "node" / "react" / "databases",
    that IS the topic — accept and move on.
  • Booking words are NOT topics: "session", "consultation",
    "meeting", "1-on-1", "group session", "office hour",
    "appointment", "slot", "reservation", "talk", or a bare time/date.
  • Canonicalize SILENTLY (don't ask the user to confirm):
      - Strip filler ("can you explain", "i'm struggling with",
        "i want to ask about", emojis, punctuation).
      - 2–6 words, Title Case, no trailing period.
      - Preserve technical terms verbatim (SQL, AWS, API, REST,
        JWT stay uppercase; React, Node.js, FastAPI keep canonical
        casing).
    Examples:
      "im struggling with sql joins"      → "SQL Joins"
      "i wanna ask about react hooks pls" → "React Hooks"
      "node please"                       → "Node"
      "aws :)                             → "AWS"
  • From the moment you have the canonical topic, "the topic"
    everywhere downstream means THAT canonical form, never the
    user's raw wording — but ONLY within the same pinned professorId.
    If the pinned professor CHANGES, discard the old canonical topic
    for general bookings (see R4b). exam_prep topics always come
    fresh from the chosen slot's \`subject\` for THAT slot only;
    never reuse another row's subject from an earlier list.

Resolve THEME (only for thesis NEW PROPOSAL, Checklist B):
  • This is NOT a one-word topic. It is a one-paragraph description
    of the thesis the user wants to do (≈ 1–4 sentences).
  • Ask in plain words: "What's your thesis theme? One short
    paragraph describing what you'd like to research is enough."
  • Do NOT canonicalize the theme — pass it through to propose_thesis
    verbatim (or only lightly trimmed). It's the professor's
    decision input, not a search keyword.

Resolve WHEN (the slot):
  Call get_professor_slots ONCE with:
    - professorId (UUID),
    - dateFrom / dateTo: user's range if given, otherwise today
      through today+14 (do NOT explain this default),
    - topic: when you have a SHORT phrase the student wants to discuss
      WITH THIS PROFESSOR — pass it for general/exam_prep flows so the
      server can search joinableMatches. OMIT it if: (a) you don't have
      WHAT scoped to this professor yet, or the user just switched
      professors and has not re-stated a topic (R4b); (b) thesis flows
      (no separate topic); (c) the pre-selected-slot peek in Workflow
      4.B step 1b where slot type isn't known yet.
    - consultationType: "thesis" / "exam_prep" / omit (per SECTION 2).
      OMIT this for the pre-selected-slot peek too — you're trying
      to discover the type, not filter by it.

  Choose what to show the user:
    1. Drop slots with alreadyBookedByYou=true. Same for
       joinableMatches entries with alreadyBookedByYou=true. If
       filtering leaves zero, say "you've already booked every
       available session with this professor in that range" and
       offer a wider range.
    2. PRE-SELECTED-SLOT SHORTCUT: if the user already named BOTH a
       date AND a time, look up the matching slot.
         • Match exists & bookable → skip the list, go straight to
           the confirmation summary for that single slot.
         • alreadyBookedByYou=true → say so and offer to view their
           reservations / pick a different time.
         • Not found              → say the time is no longer
           available and offer 2–3 nearby alternatives from the
           filtered list.
    3. Otherwise, present up to 5 slots numbered 1, 2, 3, …
         • joinableMatches FIRST (only when non-empty), labelled:
           "Join Tuesday May 6 at 10:00 — discussing X (1 student so far)".
         • Then bookable slots from \`slots\`, plain:
           "1. Tuesday, May 6 at 10:00".
         • exam_prep slots: append " — Exam prep · {subject}".
         • thesis slots: append " — Thesis".
         • No other annotations. If you don't know a slot's status,
           omit annotations rather than guess.
       If there are more than 5, mention the total and offer more.
       If there are zero, say so and offer a wider date range.
    4. Always emit a <picks> block (see SECTION 5) when you printed
       a numbered list.

──────────────────────────────────────────────────────────────────────
4.B — WORKFLOW: GENERAL / EXAM_PREP CONSULTATION
──────────────────────────────────────────────────────────────────────

Trigger: user wants to book a regular consultation (not thesis).

This workflow has FIVE strictly-ordered phases. You may NOT skip
or merge any of them. The CONFIRMATION GATE in R4 still applies on
top: phase 4 produces the summary, phase 5 only runs after the
user replies "yes".

  ─── PHASE 1: RESOLVE WHO ──────────────────────────────────────
  Call list_professors per SECTION 4.A → pin the professorId UUID.
  If WHO is missing or ambiguous, ask one focused question and
  wait. End this turn.

  ─── PHASE 2: PEEK THE SLOT (so you know its type) ─────────────
  • If the user already named BOTH a date AND a time:
      Call get_professor_slots(professorId, dateFrom/dateTo
      covering that day) WITHOUT a \`topic\` arg and WITHOUT a
      \`consultationType\` arg. Find the slot matching date+time.
        - If no match → tell the user the requested time isn't
          available and offer 2–3 nearby alternatives. End turn.
        - If match's consultationType = "thesis" → switch to
          Workflow 4.C. Do NOT continue here.
        - Otherwise remember (slotSK, consultationType, subject).
  • If the user did NOT name a date AND a time:
      You need a topic FIRST for THIS professor (so the search can
      find joinable group sessions). If the topic is missing per
      SECTION 4.A — or only exists from an earlier attempt with
      another professor — ask for it now. End turn.
      Once you have the topic, call get_professor_slots with
      the topic; present up to 5 slots numbered (per SECTION
      4.A); ask the user to pick one (with a <picks> block).
      End turn until the user replies. When they pick, remember
      (slotSK, consultationType, subject) for that slot.

  ─── PHASE 3: RESOLVE THE TOPIC ────────────────────────────────
  • If the slot's consultationType = "exam_prep":
      The topic is AUTO-DERIVED. It is exactly the slot's
      \`subject\` field (e.g. "Operating Systems"). Do NOT ask
      the student a topic question. Move to phase 3.5.
  • If the slot's consultationType = "general":
      You need a content-noun topic per SECTION 4.A that applies
      to THIS professor and THIS booking thread.
        - Re-use text from earlier messages ONLY if those messages
          clearly tied that topic to the CURRENT professor (same
          name / same booking attempt after PHASE 1) OR the user's
          latest reply restated the topic after you pinned this
          professor.
        - If the only topic in the thread came from an earlier
          booking attempt with a DIFFERENT professor, IGNORE it:
          ask one focused question: "What topic would you like to
          discuss with Professor X?" and END THIS TURN.
        - If there is no usable topic yet, same question, end turn.
        When the user replies with a topic, continue to phase 3.5
        on the NEXT turn.

  ─── PHASE 3.5: CHECK FOR JOINABLE GROUP SESSIONS ───────────────
  This step applies ONLY to the pre-selected-slot path (the user
  named both a date AND a time in their original message). If the
  user did NOT name a date AND a time, skip to phase 4 — joinable
  sessions were already surfaced by the initial get_professor_slots
  call that presented the numbered list.

  After the topic is resolved (general or exam_prep), call
  get_professor_slots ONCE MORE with:
    - professorId (same UUID)
    - dateFrom = today, dateTo = today+14 (the default window)
    - topic = the canonical topic resolved in phase 3
    - NO consultationType filter
  Purpose: compute joinableMatches for the topic NOW that you have
  it. The peek call in phase 2 omitted the topic (type was unknown),
  so joinableMatches was empty then.

  Read the returned joinableMatches (filter alreadyBookedByYou=true
  as usual). Two cases:

  CASE A — The pre-selected slotSK is in joinableMatches:
    The slot already has a student with a similar topic. The user
    is joining an existing group session.
    • Remember: this slot is a GROUP JOIN (flag it for phase 5).
    • Proceed to phase 4 with the JOIN confirmation phrasing.
    • Do NOT re-list slots or ask the user to pick again.

  CASE B — Other slots appear in joinableMatches (different slotSK):
    There are existing group sessions on OTHER dates/times with a
    similar topic. Surface them BEFORE the confirmation summary:
    present them in a numbered list (joinableMatches first, per
    SECTION 4.A rules) followed by the user's originally-chosen
    slot as the last option ("or your original choice: …").
    Ask the user to pick one. End turn. When they pick:
      - A joinableMatch → GROUP JOIN, phase 4 with join phrasing.
      - Original slot     → fresh booking, phase 4 with general
                           phrasing.

  CASE C — joinableMatches is empty:
    No similar group sessions exist. Proceed to phase 4 normally
    (fresh booking).

  ─── PHASE 4: SEND THE CONFIRMATION SUMMARY ────────────────────
  ★ This is a TEXT-ONLY assistant message. NO tool calls in this
    turn — not list_professors, not get_professor_slots, not
    book_slot, not anything. The whole turn is just the summary
    text below.

  Pick the phrasing that matches the slot type:
    general:    "Just to confirm: I'll book a consultation with
                 Professor X on Tuesday, May 6 at 10:00 to discuss
                 SQL Joins. Shall I go ahead?"
    exam_prep:  "Just to confirm: I'll book you into the exam-prep
                 session with Professor X on Tuesday, May 6 at
                 10:00 for Operating Systems. Shall I go ahead?"
    join (phase 3.5 CASE A or B joinableMatch picked):
                "Just to confirm: I'll join you into the group
                 session with Professor X on Tuesday, May 6 at
                 10:00 — you'll be joining N other student(s).
                 Topic: SQL Joins. Shall I go ahead?"
                 (Use currentParticipants for N.)

  Then END THE TURN. Do NOT call book_slot or join_group_session
  in this turn no matter how confident you feel about the data.
  Wait for the user's reply.

  ─── PHASE 5: ACT ON EXPLICIT YES ──────────────────────────────
  Re-check R4's CONFIRMATION GATE before proceeding. Only when the
  user's most-recent reply is an explicit yes (per R4 (b)) do you
  call:
    • join_group_session — if the confirmed slot is a GROUP JOIN
      (came from joinableMatches in phase 3 or phase 3.5 CASE A/B).
      Args: EXACT professorId UUID, EXACT slotSK, \`note\` = the topic.
    • book_slot — for everything else. Same arg shapes.
  Then send a warm confirmation:
    "All set! Your consultation with Professor X is booked for
     May 6 at 10:00 to discuss SQL Joins."
  Use "exam-prep session" / "group session" wording only when
  that's actually what happened.

  If the user replies "no", asks to change something, or sends
  a new piece of info → DO NOT call the booking tool. Loop back
  to whichever earlier phase is now stale and re-issue PHASE 4
  with the updated summary (the gate resets per R4b).

──────────────────────────────────────────────────────────────────────
4.C — WORKFLOW: THESIS
──────────────────────────────────────────────────────────────────────

Trigger: user mentions thesis / diplomski / master rad / thesis
mentor / thesis proposal / etc., OR picks a slot whose
consultationType is "thesis".

ALWAYS START with get_my_thesis_status. Branch on currentStatus:

  ── currentStatus = "none" or "declined" — NEW PROPOSAL ────────
  Use Checklist B (WHO with maxMentees>0, WHEN thesis slot, THEME
  paragraph). Tool: propose_thesis.

  Steps:
    a. Resolve WHO. Run list_professors per SECTION 4.A and FILTER
       the result to maxMentees > 0 BEFORE listing them. If the
       filtered list is empty, say "no professor is currently
       accepting new thesis mentees" and stop.
    b. Resolve WHEN. get_professor_slots with the chosen
       professorId AND consultationType="thesis". Use the slot
       presentation rules from SECTION 4.A.
    c. Resolve THEME (per SECTION 4.A "Resolve THEME"). Ask a
       plain question; do NOT call any tool while waiting.
    d. CONFIRMATION (no tool call). One summary:
         "Just to confirm: I'll send a thesis proposal to Professor
          X for the initial consultation on Tuesday, May 6 at 10:00.
          Theme: <user's theme, in their own words>. Shall I go
          ahead?"
    e. After explicit yes, call propose_thesis with EXACT
       professorId UUID, EXACT slotSK, and the theme. Confirm:
         "Sent! Your thesis proposal is with Professor X for the
          initial consultation on May 6 at 10:00. They'll review
          and decide after the meeting."
    f. The current status will become "pending" once propose_thesis
       returns. Subsequent thesis questions follow the "pending"
       branch below until the professor decides.

  ── currentStatus = "pending" — WAITING ON A DECISION ──────────
  • Tell the user their proposal with <professor name from the
    history> is pending and the professor can only decide after
    the initial consultation has happened.
  • DO NOT propose another thesis. The server would reject it
    with THESIS_PENDING_DECISION anyway.
  • Optionally offer to cancel the proposal (which is just
    cancel_consultation on the linked initial booking) so the
    user can try someone else. Use Workflow 4.D (cancellation)
    if they say yes.

  ── currentStatus = "accepted" — THESIS UPDATE BOOKING ─────────
  Use Checklist C (WHO is fixed, WHEN, THEME reused).
  Tool: propose_thesis.

  Steps:
    a. WHO is currentProfessorId — DO NOT offer or accept a
       different professor. If the user names a different one,
       politely explain that thesis bookings go to their
       accepted mentor and stop.
    b. Resolve WHEN. get_professor_slots(professorId =
       currentProfessorId, consultationType="thesis"). Slot
       presentation per SECTION 4.A.
    c. CONFIRMATION (no tool call):
         "Just to confirm: book a thesis update with Professor X
          on Tuesday, May 6 at 10:00. Shall I go ahead?"
       Do NOT mention the snapshot mechanism, do NOT show or ask
       about the theme.
    d. After explicit yes, call propose_thesis with the existing
       professorId UUID, the EXACT slotSK, and theme="" (empty
       string is fine — the server reuses the snapshot). Confirm:
         "All set — your thesis update with Professor X is booked
          for May 6 at 10:00."

Reading propose_thesis / book_slot / join_group_session results
(Nova Lite gets this wrong constantly — be deliberate):
  • If the result has a top-level \`error\` field → call FAILED.
    Read the error string and follow its instructions.
  • Otherwise the call SUCCEEDED. The result has \`success: true\`,
    \`consultationId\`, and \`slotFinalStatus\` describing the SLOT'S
    new state AFTER your booking landed — NOT the booking itself.
  • A successful 1-on-1 booking ALWAYS leaves
    \`slotFinalStatus: "full"\` because YOU just claimed the only
    seat. NEVER tell the user "the slot is full / now full /
    taken" after a successful booking. NEVER offer alternative
    slots after a success. The booking succeeded; confirm warmly.

Structured thesis errors (recover, do NOT retry the same call):
  • THESIS_THEME_REQUIRED      → ask for the theme, then
                                 propose_thesis again with it.
  • THESIS_PENDING_DECISION    → switch to the "pending" branch.
  • THESIS_WRONG_MENTOR        → switch to the "accepted" branch
                                 with the correct currentProfessorId.
  • THESIS_ALREADY_HAS_MENTOR  → same — the user already has an
                                 accepted mentor; route them there.

──────────────────────────────────────────────────────────────────────
4.D — WORKFLOW: CANCELLATION
──────────────────────────────────────────────────────────────────────

Use Checklist D. Tool: cancel_consultation.

Steps:
  1. Call get_my_consultations.
  2. Identify the row from the user's words (date, time, topic,
     professor name). If multiple match, STOP and ask which one —
     do not cancel anything yet.
  3. CONFIRMATION (no tool call). One summary:
       "Just to confirm: cancel your consultation with Professor X
        on Tuesday, May 6 at 10:00 about SQL Joins? Yes or no."
     You MAY also invite an optional reason in the same turn:
       "If you'd like to add a reason for the professor, send it
        with your reply; otherwise just say yes."
  4. After explicit yes, call cancel_consultation with the EXACT
     consultationId. If the user volunteered a reason, pass it
     verbatim as the \`reason\` arg; otherwise omit \`reason\`.
  5. Confirm:
       "Cancelled — your consultation with Professor X on May 6
        at 10:00 is gone from your schedule."
     If the user replies "no" or wants to change something,
     handle the new request instead.

──────────────────────────────────────────────────────────────────────
4.E — WORKFLOW: WAITLIST  (only after a slot_full error)
──────────────────────────────────────────────────────────────────────

The waitlist is NOTIFY-ONLY. Joining does NOT book the seat. When
someone cancels, the longest-waiting student gets a "seat opened"
notification and STILL has to manually book.

Trigger: book_slot or join_group_session returned "Slot is full"
AND the user explicitly says they want to wait.
DO NOT offer the waitlist before a booking failed.
DO NOT offer the waitlist for a slot the user already booked.

Steps:
  1. Confirm in one short sentence (professor + date + time) and
     ask for explicit yes. Do NOT mention or recap the topic in
     the waitlist confirmation — the waitlist only needs the slot.
  2. After yes, call join_waitlist with EXACT professorId UUID
     and EXACT slotSK. Do NOT pass \`topic\` or \`note\`, and do NOT
     ask the student for them — joining the waitlist is just
     "notify me if a seat opens", not a booking.
  3. Confirm: "You're on the waitlist. I'll let you know if a
     seat opens — you'll need to confirm the booking from the
     notification."

Other waitlist tools:
  • get_my_waitlist  → answer "where am I queued?" / "show my
    waitlist". Never invent entries — only describe what the
    tool returned.
  • leave_waitlist   → confirm slot first, then call with EXACT
    professorId AND EXACT slotSK from get_my_waitlist.


══════════════════════════════════════════════════════════════════════
SECTION 5 — OUTPUT FORMAT (picks, language, prose discipline)
══════════════════════════════════════════════════════════════════════

Picks (clickable buttons rendered by the UI):
  • When you ask the user to choose ONE item from a numbered list —
    slots / joinableMatches from get_professor_slots, or
    consultations during cancellation, or professors when the
    list is short — append a SINGLE \`<picks>\` block at the END
    of your message. Format (strict):
      <picks>[{"label":"...","value":"..."}, ...]</picks>
  • One {label, value} per item, in the SAME order as the list.
  • \`label\` = short button text ("Tuesday May 6 at 10:00",
    "Cancel Wed 12:00 with Prof Petrović").
  • \`value\` = exactly what the user's reply will be when they
    click ("1", "2", "3" for numbered lists; or a short phrase
    if more readable).
  • Do NOT emit \`<picks>\` for greetings, error recoveries,
    confirmation summaries, or general prose.
  • Picks AUGMENT the list — never replace the prose list above
    with picks alone.

Things you must NEVER do:
  • Tell the user no group sessions / matches were found.
  • Offer to "wait for" a future group session — that feature
    does not exist.
  • Explain the date-range default ("up to 14 days ahead", etc.).
  • Ask the user to choose between "1-on-1" and "group" up front;
    the group option only exists when joinableMatches is non-empty.
  • Invent slot annotations. The ONLY allowed annotations are
    " — Thesis", " — Exam prep · {subject}", and (for
    joinableMatches only) "Join … — discussing X (N student(s)
    so far)". Anything else — "(already booked by you)",
    "(reserved by someone else)", "(group session)",
    "(1 student so far)", "(full)", "(taken)" — is forbidden
    UNLESS the corresponding API field explicitly says so.
  • Conflate currentParticipants > 0 with "already booked by
    you". currentParticipants > 0 means OTHER students booked
    the slot. Only say "already booked by you" when
    alreadyBookedByYou === true.
  • Suggest professors with maxMentees === 0 for thesis flows.
  • Say "no professor specializes in thesis mentorship".

Permissions reminder:
  • Students can: view professors, view slots, book slots, view
    their own consultations, cancel their own bookings,
    join/leave waitlists, propose theses.
  • A professor reaching this surface (rare) is read-only — they
    can only see their own consultations and cannot book on
    behalf of students.
        `.trim();
}

// Professor-side prompt. The widget is intentionally read-only and scoped to
// the professor's own schedule. We do NOT expose the booking / cancellation
// flows here — those live in the dedicated UI screens with proper guards.
// Picks aren't useful in this surface (no choose-one-of-N flows) so the
// hint is omitted to keep the prompt small.
function buildProfessorPrompt(caller, today) {
  return `
You are a small in-page assistant that helps a university PROFESSOR understand
their own consultation schedule.

Current user: ${caller.displayName}, role: professor, userId: ${caller.userId}
Today's date: ${today}

CRITICAL FRAMING — read this before answering anything:
- The user IS the professor. STUDENTS book sessions WITH them. The professor
  does NOT book consultations of their own. NEVER suggest the professor
  "book a session", "make a booking", "reserve a slot", or "use a booking
  screen" — that is not an action they take.
- This widget is read-only. You describe the professor's schedule; you do
  not change it.
- NEVER mention "dedicated screens", "booking screens", "the booking page",
  or any other UI surface as a place to redirect the user. They already
  know the rest of the app — don't instruct them.

What you CAN do:
- Answer questions about the professor's UPCOMING consultations: how many
  bookings tomorrow, who is coming for a given topic, what their next
  session is, who booked a particular slot, and so on.
- Use get_my_consultations whenever you need real data. Never invent
  bookings, students, dates, or topics.

How to phrase EMPTY results:
- When get_my_consultations returns no rows for the asked period, reply
  with ONE short, plain sentence acknowledging the empty schedule from
  the PROFESSOR'S perspective. Examples of GOOD answers:
    "No one has booked you for this week yet."
    "Nothing on the calendar tomorrow."
    "Your week is clear so far — no reservations."
  Do NOT add a follow-up suggestion of any kind. Do NOT mention booking,
  reserving, scheduling, or any other action. STOP after the sentence.

What you CANNOT do (and must politely decline if asked):
- Book or cancel consultations.
- Message students.
- Show information about other professors.
- Anything unrelated to the professor's own schedule.
If asked to do any of those, say in one short sentence that you can't help
with that here, and stop. Do not redirect.

Style:
- Respond in the same language the user writes in (Serbian or English).
- Keep answers short, scannable, and conversational. Bullet lists are fine
  when summarising several bookings.
- Use natural date/time formatting (e.g. "Tuesday, May 6 at 10:00") — never
  leak raw IDs, UUIDs, slotSK strings, or DB internals.

Tailor the answer SHAPE to what the user actually asked for:
- **Topics-only questions** ("What topics are coming up?", "Which topics am
  I covering?", "Koje teme me čekaju?", and similar): output ONLY the list
  of DISTINCT topics. No dates, no times, no student names, no counts.
  Just the unique topic strings, one per bullet, deduplicated case-insensitively.
- **Schedule / time questions** ("What's on my schedule tomorrow?",
  "Who is booked at 10:00?"): include date + time + topic + student name(s).
- **Student-roster questions** ("Who is coming to see me?"): include student
  name + topic + when, in that order.

Group-session deduplication (CRITICAL):
- When two or more bookings share the SAME slot (same date AND time AND
  professor) — i.e. they're a group session — they MUST appear as ONE bullet,
  not one bullet per student. The signals that a row is part of a group
  session are: identical date+time, or totalParticipants > 1. Combine those
  rows like "Tuesday May 14 at 10:00 — Topic: node.js — Students: Luka Simić,
  Filip Ilić" (or "3 students" if there are more than 3 names).
- For topics-only questions, the same rule applies AND you also dedupe
  identical topics across DIFFERENT slots — the user just wants the set
  of subjects, each listed once.
        `.trim();
}

// ---------- Tool implementations ----------
// listProfessors / getMyConsultations / cancelConsultation / bookSlotCore /
// joinGroupCore are imported from the common layer so the REST handlers and
// the chat tool dispatcher share the same booking invariants.

// Normalize to plain ASCII so "jovanovic" matches "Jovanović", "petrovic"
// matches "Petrović", etc., and so subject / department matching is
// diacritic- and case-insensitive.
function asciiFold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Strip leading honorifics so a nameFilter like "Professor Petar Petrović"
// (which the assistant can produce when a student asks "book Professor X")
// still matches a stored row whose `name` is "Petar Petrović". Run on the
// already-folded form so it's case + diacritic insensitive.
function stripHonorific(s) {
  return s.replace(/^(prof(?:essor)?|dr|mr|mrs|ms|mister|madam)\.?\s+/i, "").trim();
}

// Wraps the imported listProfessors with server-side filtering on any
// combination of nameFilter, subjectFilter, departmentFilter. Pulling this
// out of the model is deliberate: Nova Lite is unreliable at fuzzy matching
// and tends to hallucinate extra matches.
async function listProfessorsFiltered({ nameFilter, subjectFilter, departmentFilter }) {
  const all = await listProfessors();

  const name = (nameFilter || "").trim();
  const subject = (subjectFilter || "").trim();
  const department = (departmentFilter || "").trim();

  if (!name && !subject && !department) {
    return { status: "all", professors: all };
  }

  const nameNeedle = stripHonorific(asciiFold(name));
  const subjectNeedle = asciiFold(subject);
  const departmentNeedle = asciiFold(department);

  const matches = all.filter((p) => {
    if (name && !asciiFold(p.name).includes(nameNeedle)) return false;
    if (department && !asciiFold(p.department).includes(departmentNeedle)) {
      return false;
    }
    if (subject) {
      const subjectsBlob = (p.subjects || []).map(asciiFold).join(" ");
      if (!subjectsBlob.includes(subjectNeedle)) return false;
    }
    return true;
  });

  const filters = { nameFilter: name, subjectFilter: subject, departmentFilter: department };

  if (matches.length === 0) {
    return {
      status: "no_match",
      filters,
      hint:
        "No professor matches the given filter(s). Tell the user and offer to list everyone (call list_professors with no arguments).",
    };
  }
  if (matches.length === 1) {
    return { status: "single_match", filters, professor: matches[0] };
  }
  return {
    status: "ambiguous",
    filters,
    matches,
    hint:
      "Multiple professors match. STOP and ask the user which one they mean. " +
      "List each match with full name and department. Do NOT call get_professor_slots until the user replies.",
  };
}

// Returns both the bookable slots in the requested window AND any existing
// group sessions whose topic is similar enough to be a join candidate. The
// model used to call findTopicMatches as a separate tool, but that meant
// Nova Lite would surface "I searched for similar sessions and found
// nothing" prose to the user even when the result was empty. Folding the
// match into the slots tool keeps grouping invisible by default: callers
// only mention join options when joinableMatches is non-empty.
//
// Each returned slot also carries `alreadyBookedByYou: boolean` — true
// when the calling student already has an active reservation on that exact
// slot. Without this hint the model would cheerfully offer the slot back
// to the student (because it wasn't full), the student would pick it, and
// the booking would only fail at write time with a duplicate-booking error
// AFTER the user already committed. The system prompt instructs the model
// to filter / label these slots up front so the dead-end conversation
// shown in the chat trace can't happen.
//
// joinableMatches is independent of the date window because the underlying
// findTopicMatches scans the professor's whole future. `topic` is optional:
// if omitted, we skip the embedding call and return joinableMatches: [].
async function getProfessorSlots(
  professorId,
  dateFrom,
  dateTo,
  topic,
  studentId,
  consultationType,
  subject
) {
  const items = await queryPk(`PROFESSOR#${professorId}`, "SLOT#");
  const lower = `SLOT#${dateFrom}`;
  const upper = `SLOT#${dateTo}T99:99`;

  // Build a Set of slotSK strings the current student already holds an
  // active booking on (with THIS professor). Hits the per-student GSI so
  // we never have to scan the consultation table. Failures degrade
  // silently to "no flagged slots" — bookSlotCore still rejects the
  // duplicate at write time.
  const ownBookedSlotSKs = new Set();
  if (studentId) {
    try {
      const studentRows = await queryGsi2(`STUDENT#${studentId}`);
      for (const r of studentRows) {
        if (r.SK !== "METADATA") continue;
        if (r.professorId !== professorId) continue;
        if (r.status === "cancelled") continue;
        if (r.slotSK) ownBookedSlotSKs.add(r.slotSK);
      }
    } catch {
      /* fall through — annotation is best-effort */
    }
  }

  // Optional type / subject filter narrows the bookable list (joinableMatches
  // is left untouched so a thesis-search doesn't accidentally drop a great
  // exam_prep group match the student would happily take). Type comparison
  // goes through normalizeConsultationType so undefined-on-row collapses to
  // "general" without a migration.
  const typeFilter = consultationType
    ? normalizeConsultationType(consultationType)
    : null;
  const subjectFilter =
    typeof subject === "string" && subject.trim()
      ? subject.trim().toLowerCase()
      : null;

  const now = Date.now();
  const slots = items
    .filter((i) => {
      if (i.SK < lower || i.SK > upper) return false;
      if (i.status === "full") return false;
      // Exclude slots whose start instant has already passed. Without this,
      // slots earlier today (same date, past time) appear in the list, the
      // student picks one, and bookSlotCore rejects it with "session has
      // passed" only after a full confirm round-trip.
      const instant = combineSlotInstantUtc(i.date, i.time);
      return instant && instant.getTime() > now;
    })
    .filter((i) => {
      if (typeFilter && normalizeConsultationType(i.consultationType) !== typeFilter) {
        return false;
      }
      if (subjectFilter) {
        const s = (i.subject || "").toLowerCase();
        if (!s.includes(subjectFilter)) return false;
      }
      return true;
    })
    .map((i) => ({
      slotSK: i.SK,
      date: i.date,
      time: i.time,
      consultationType: normalizeConsultationType(i.consultationType),
      subject: i.subject || "",
      maxParticipants: i.maxParticipants,
      currentParticipants: i.currentParticipants,
      alreadyBookedByYou: ownBookedSlotSKs.has(i.SK),
    }));

  let joinableMatches = [];
  if (topic && topic.trim()) {
    try {
      joinableMatches = await findTopicMatches(professorId, topic, studentId);
    } catch {
      // Best-effort: an embedding failure must not block the slot list.
      joinableMatches = [];
    }
  }
  // Match annotation also belongs on joinableMatches so the model never
  // suggests "join your own session" — `findTopicMatches` already filters
  // out the current student's bookings, but defending here costs nothing
  // and survives any future change to that filter.
  for (const m of joinableMatches) {
    m.alreadyBookedByYou = ownBookedSlotSKs.has(m.slotSK);
  }

  return { slots, joinableMatches };
}

async function runTool(name, input, caller, log) {
  const args = input || {};

  // Booking, group-join and waitlist tools MUST be student-only at the
  // transport layer too, independent of what the system prompt instructs.
  // The REST surface already enforces this; the chat surface needs the
  // same gate so a professor (or future role) holding a valid token
  // can't book / queue through the assistant.
  const studentOnlyTools = new Set([
    "book_slot",
    "join_group_session",
    "join_waitlist",
    "leave_waitlist",
    "get_my_waitlist",
    "propose_thesis",
    "get_my_thesis_status",
  ]);
  if (studentOnlyTools.has(name) && caller.role !== "student") {
    log?.warn("tool.role_blocked", { tool: name, role: caller.role });
    return {
      error:
        "Only students can use this action. Tell the user it is not " +
        "available to their role.",
    };
  }

  switch (name) {
    case "list_professors":
      return listProfessorsFiltered({
        nameFilter: args.nameFilter,
        subjectFilter: args.subjectFilter,
        departmentFilter: args.departmentFilter,
      });
    case "get_professor_slots":
      return getProfessorSlots(
        args.professorId,
        args.dateFrom,
        args.dateTo,
        args.topic,
        caller.userId,
        args.consultationType,
        args.subject
      );
    case "book_slot": {
      const result = await bookSlotCore({
        professorId: args.professorId,
        slotSK: args.slotSK,
        studentId: caller.userId,
        note: args.note || "",
        log,
      });
      if (result && result.error) return result;
      if (!result) return result;
      const { status: slotFinalStatus, ...rest } = result;
      // For 1-on-1 slots slotFinalStatus is ALWAYS "full" (the student just
      // claimed the only seat). Nova Lite repeatedly misreads that as a
      // booking failure ("the slot is now full"). Omit it for solo slots —
      // the field only matters to the model for group sessions where it
      // tells the UI whether more students can still join.
      const isSolo = (result.maxParticipants || 1) <= 1;
      return { success: true, ...(isSolo ? {} : { slotFinalStatus }), ...rest };
    }
    case "get_my_consultations": {
      const rows = await getMyConsultations(caller.userId, caller.role);
      // Slim the tool result to only the fields the model needs to answer
      // schedule questions. The raw rows carry slotSK / professorId /
      // studentId / GSI keys / status flags / DB internals that the system
      // prompt tells the model NEVER to leak. Handing the model a payload
      // full of forbidden fields makes Nova Lite freeze and return an
      // empty text block ("blank assistant message" bug). Strip them
      // server-side instead.
      //
      // Also drop cancelled rows: the chat surface answers "what's coming
      // up?" style questions, and a cancelled session isn't part of that
      // schedule. The MyConsultations page (a different consumer) keeps
      // them around for the cancelled-tombstone UI; the chat tool does not.
      const nowMs = Date.now();
      return Array.isArray(rows)
        ? rows
            .filter((r) => {
              if (r.status === "cancelled") return false;
              const instant = combineSlotInstantUtc(r.date, r.time);
              return instant && instant.getTime() > nowMs;
            })
            .map((r) => ({
              consultationId: r.consultationId,
              date: r.date,
              time: r.time,
              topic: r.topic,
              // Student-side replies need professor info; professor-side
              // replies need student info. Each branch falls back gracefully
              // when its counterpart field isn't enriched.
              ...(caller.role === "professor"
                ? {
                    studentName: r.studentName || "",
                    studentEmail: r.studentEmail || "",
                    totalParticipants: r.slotCurrentParticipants,
                    maxParticipants: r.slotMaxParticipants,
                  }
                : {
                    professorName: r.professorName || "",
                    professorDepartment: r.professorDepartment || "",
                    // Expose these so the model can identify which consultation
                    // is the pending thesis one when the student asks to cancel
                    // their proposal (Workflow 4.C pending branch → 4.D).
                    // Without them, the model has to guess from topic text alone.
                    consultationType: r.consultationType || "general",
                    ...(r.thesisStage ? { thesisStage: r.thesisStage } : {}),
                  }),
              ...(r.note ? { studentNote: r.note } : {}),
            }))
        : rows;
    }
    case "cancel_consultation":
      return cancelConsultation(args.consultationId, caller.userId, {
        reason: typeof args.reason === "string" ? args.reason : "",
      });
    case "join_group_session": {
      const result = await joinGroupCore({
        professorId: args.professorId,
        slotSK: args.slotSK,
        studentId: caller.userId,
        note: args.note || "",
        log,
      });
      if (result && result.error) return result;
      if (!result) return result;
      const { status: slotFinalStatus, ...rest } = result;
      const isSolo = (result.maxParticipants || 1) <= 1;
      return { success: true, ...(isSolo ? {} : { slotFinalStatus }), ...rest };
    }
    case "join_waitlist":
      return joinWaitlist({
        professorId: args.professorId,
        slotSK: args.slotSK,
        studentId: caller.userId,
        topic: typeof args.topic === "string" ? args.topic : "",
        note: typeof args.note === "string" ? args.note : "",
      });
    case "leave_waitlist":
      return leaveWaitlist({
        professorId: args.professorId,
        slotSK: args.slotSK,
        studentId: caller.userId,
      });
    case "propose_thesis": {
      const result = await bookSlotCore({
        professorId: args.professorId,
        slotSK: args.slotSK,
        studentId: caller.userId,
        note: typeof args.theme === "string" ? args.theme : "",
        thesisTheme: typeof args.theme === "string" ? args.theme : "",
        log,
      });
      if (result && result.error) return result;
      if (!result) return result;
      // Thesis slots are 1-on-1 by design so slotFinalStatus is always
      // "full" after a successful propose — omit it (same reasoning as
      // book_slot for solo slots) so the model can't misread it as failure.
      const { status: _discarded, ...rest } = result;
      return { success: true, ...rest };
    }
    case "get_my_thesis_status": {
      const current = await getCurrentMentorshipForStudent(caller.userId);
      const history = await listMentorshipsForStudent(caller.userId);
      // Resolve the current professor's name so the "pending" branch can
      // tell the student which professor they're waiting on without leaking
      // a UUID. Without this, the model either violates R6 or has to rely
      // on a prior list_professors call that may not be in the session.
      let currentProfessorName = "";
      if (current && current.professorId) {
        const allProfs = await listProfessors().catch(() => []);
        const match = allProfs.find((p) => p.professorId === current.professorId);
        currentProfessorName = match ? match.name : "";
      }
      return {
        currentStatus: current ? current.status : "none",
        currentProfessorId: current ? current.professorId : null,
        currentProfessorName,
        currentTheme: current ? current.thesisTheme || "" : "",
        currentDecidedAt: current && current.decidedAt ? current.decidedAt : null,
        history: history.map((m) => ({
          professorId: m.professorId,
          attempt: m.attempt,
          status: m.status,
          proposedAt: m.proposedAt,
          decidedAt: m.decidedAt || null,
          declineReason: m.declineReason || null,
          theme: m.thesisTheme || "",
        })),
      };
    }
    case "get_my_waitlist": {
      const entries = await listWaitlistForStudent(caller.userId);
      if (!Array.isArray(entries)) return entries;
      // Enrich with professor name so the model can tell the user which
      // professor they're queued for without leaking raw UUIDs (violates R6).
      // A single listProfessors() call builds the lookup map.
      const allProfs = await listProfessors().catch(() => []);
      const profNameMap = new Map(allProfs.map((p) => [p.professorId, p.name]));
      return entries.map((e) => ({
        slotSK: e.slotSK,
        professorId: e.professorId,
        professorName: profNameMap.get(e.professorId) || "",
        date: e.date,
        time: e.time,
        consultationType: e.consultationType,
        subject: e.subject,
        topic: e.topic,
        joinedAt: e.joinedAt,
      }));
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------- Handler ----------

// Session rows live for 24h after the last write so a student can leave the
// chat tab open, come back later in the day, and resume the same thread via
// the localStorage-stored sessionId. Anything older than 24h is treated as a
// fresh conversation — better UX than scrubbing through a stale week-old log.
const SESSION_TTL_SECONDS = 24 * 60 * 60;

exports.handler = async (event, context) => {
  const log = createLogger("chat", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    let caller;
    try {
      caller = getCaller(event);
    } catch (e) {
      log.error(e, { stage: "auth_getCaller" });
      return unauthorized();
    }
    log.withContext({ userId: caller.userId, role: caller.role });

    if (event.httpMethod === "GET") {
      return await handleGetHistory(event, caller, log, context);
    }

    return await handleConverse(event, caller, log, context);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      errName: e && e.name,
    });

    if (e && e.name === "ThrottlingException") {
      return error(
        `Bedrock is busy, try again (requestId=${context.awsRequestId})`
      );
    }
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};

// GET /chat/sessions/{sessionId} — returns the user-visible turns of a
// session so the UI can resume a stale tab. Each MSG row carries the
// caller's userId; only rows owned by the caller are returned, so a stolen
// sessionId can't leak someone else's transcript.
async function handleGetHistory(event, caller, log, context) {
  const sessionId =
    event.pathParameters && event.pathParameters.sessionId
      ? decodeURIComponent(event.pathParameters.sessionId)
      : "";
  if (!sessionId) {
    log.warn("missing_session_id", { stage: "validate_path" });
    return badRequest("sessionId path parameter is required");
  }
  log.withContext({ sessionId });

  let history;
  try {
    history = await queryPk(`SESSION#${sessionId}`, "MSG#");
  } catch (e) {
    log.error(e, { stage: "queryPk_history", sessionId });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
  history.sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));

  const messages = [];
  for (const row of history) {
    // Reject rows that don't belong to this caller. Old rows persisted
    // before the userId field was introduced are also dropped — they
    // would otherwise leak across users for any predictable sessionId.
    if (row.userId !== caller.userId) continue;

    const blocks = Array.isArray(row.contentBlocks) ? row.contentBlocks : [];
    const textBlock = blocks.find((b) => b && typeof b.text === "string" && b.text.trim());
    if (!textBlock) continue;

    messages.push({
      role: row.role,
      content: textBlock.text,
      createdAt: row.createdAt || null,
    });
  }

  log.end({ stage: "get_history", returned: messages.length, raw: history.length });
  return ok({ sessionId, messages });
}

async function handleConverse(event, caller, log, context) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    log.warn("invalid_json", { stage: "parse_body", message: e.message });
    return badRequest("invalid JSON body");
  }
  const { sessionId, message } = body;
  if (!sessionId || !message) {
    log.warn("missing_fields", {
      stage: "validate_body",
      hasSessionId: !!sessionId,
      hasMessage: !!message,
    });
    return badRequest("sessionId and message are required");
  }
  if (message.length > 2000) {
    log.warn("message_too_long", { stage: "validate_body", messageLen: message.length });
    return badRequest("message must be 2000 characters or fewer");
  }
  log.withContext({ sessionId, messageLen: message.length });

  // STEP 1: Load history and rebuild messages array
  //
  // Each row stores the FULL Bedrock content array under `contentBlocks`
  // (text + toolUse + toolResult blocks), so multi-turn tool flows work:
  // the model can refer back to UUIDs it received from list_professors on
  // a previous turn instead of inventing them from names. Legacy rows with
  // a flat `content` string fall back to a single text block.
  //
  // Old rows persisted before the userId-on-row change are silently dropped
  // here so a forged sessionId can't pull a stranger's transcript into the
  // model's context. Same scoping logic as the GET /chat/sessions/{id} path.
  let history;
  try {
    history = await queryPk(`SESSION#${sessionId}`, "MSG#");
  } catch (e) {
    log.error(e, { stage: "queryPk_history", sessionId });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
  history.sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
  const ownedHistory = history.filter((row) => row.userId === caller.userId);
  log.info("history_loaded", {
    historyCount: history.length,
    ownedCount: ownedHistory.length,
  });

  // Strip blocks that reference tools no longer in the current tool list.
  // Without this, a session whose history contains a `tool_use` for a
  // removed tool (e.g. find_topic_matches after we folded it into
  // get_professor_slots) makes the next bedrock:Converse call throw
  // ValidationException because the toolUse refers to a tool that isn't in
  // the toolConfig anymore. Two-pass: collect toolUseIds for removed tools,
  // then drop both the tool_use blocks and their matching tool_result
  // blocks. Messages that become empty after filtering are skipped, which
  // is safe — Bedrock only requires that toolResult blocks immediately
  // follow their matching toolUse, not strict role alternation.
  const REMOVED_TOOL_NAMES = new Set(["find_topic_matches"]);
  const removedToolUseIds = new Set();
  for (const item of ownedHistory) {
    const blocks = Array.isArray(item.contentBlocks) ? item.contentBlocks : [];
    for (const b of blocks) {
      if (b && b.toolUse && REMOVED_TOOL_NAMES.has(b.toolUse.name)) {
        removedToolUseIds.add(b.toolUse.toolUseId);
      }
    }
  }

  const messages = [];
  let droppedBlocks = 0;
  for (const item of ownedHistory) {
    const rawBlocks =
      Array.isArray(item.contentBlocks) && item.contentBlocks.length > 0
        ? item.contentBlocks
        : [{ text: item.content || "" }];
    const filtered = rawBlocks.filter((b) => {
      if (b && b.toolUse && REMOVED_TOOL_NAMES.has(b.toolUse.name)) {
        droppedBlocks += 1;
        return false;
      }
      if (b && b.toolResult && removedToolUseIds.has(b.toolResult.toolUseId)) {
        droppedBlocks += 1;
        return false;
      }
      return true;
    });
    if (filtered.length === 0) continue;
    messages.push({ role: item.role, content: filtered });
  }
  if (droppedBlocks > 0) {
    log.info("history_filtered_removed_tools", {
      droppedBlocks,
      keptMessages: messages.length,
    });
  }

  // Guard the Bedrock context window. A 24h-TTL session can accumulate many
  // turns; an unbounded history eventually causes a ValidationException when
  // the token count exceeds the model limit. Keep only the 30 most-recent
  // messages. Tool-use pairs (assistant toolUse + user toolResult) must be
  // kept together so we never split them — slice from a safe boundary.
  const MAX_HISTORY_MESSAGES = 30;
  if (messages.length > MAX_HISTORY_MESSAGES) {
    messages.splice(0, messages.length - MAX_HISTORY_MESSAGES);
  }

  // Track every message added during THIS request so we can persist them
  // in order at the end. Bedrock validates that toolResult blocks follow
  // their matching toolUse block, so order matters.
  const newMessages = [];
  const recordMsg = (role, contentBlocks) => {
    const msg = { role, content: contentBlocks };
    messages.push(msg);
    newMessages.push(msg);
  };

  recordMsg("user", [{ text: message }]);

  // STEP 3: System prompt + tools (role-aware)
  const today = new Date().toISOString().split("T")[0];
  const system = buildSystemPrompt(caller, today);
  const tools = getToolsForRole(caller.role);

  // STEP 4: Converse loop
  let finalText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  let lastStopReason = null;
  // Names of every tool call attempted in this turn (in invocation order).
  // The frontend uses this to decide whether to refresh derived views
  // (slot lists, "My Reservations") after a chat reply — e.g. when the
  // assistant calls book_slot, the Faculty directory needs to refetch
  // the slot the student just took.
  const toolsUsed = [];
  let iter = 0;
  for (; iter < 5; iter++) {
    const bedrockStartedAt = Date.now();
    let response;
    try {
      response = await bedrockClient.send(
        new ConverseCommand({
          modelId: process.env.BEDROCK_MODEL_ID,
          system,
          messages,
          toolConfig: { tools },
          inferenceConfig: { maxTokens: 1024 },
        })
      );
    } catch (bedrockErr) {
      log.error(bedrockErr, {
        stage: "bedrock_converse",
        iter,
        modelId: process.env.BEDROCK_MODEL_ID,
        bedrockMs: Date.now() - bedrockStartedAt,
        messagesCount: messages.length,
      });
      // Re-throw so the outer catch maps Throttling -> friendly message and
      // returns the right requestId in the body.
      throw bedrockErr;
    }

    const stopReason = response.stopReason;
    const outputMessage = response.output.message;
    lastStopReason = stopReason;
    const usage = response.usage || {};
    totalInputTokens += usage.inputTokens || 0;
    totalOutputTokens += usage.outputTokens || 0;

    log.info("bedrock_response", {
      iter,
      stopReason,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      bedrockMs: Date.now() - bedrockStartedAt,
    });

    if (stopReason === "tool_use") {
      // Persist the assistant's tool_use turn so the next request can see
      // which UUIDs came back from list_professors etc.
      newMessages.push(outputMessage);
      messages.push(outputMessage);

      const toolUseBlocks = (outputMessage.content || []).filter(
        (b) => b.toolUse
      );

      const resultBlocks = [];
      for (const block of toolUseBlocks) {
        const { name, toolUseId, input } = block.toolUse;
        totalToolCalls += 1;
        toolsUsed.push(name);
        const toolStartedAt = Date.now();
        let toolResult;
        let toolOk = true;
        try {
          toolResult = await runTool(name, input, caller, log);
          if (toolResult && toolResult.error) toolOk = false;
        } catch (toolErr) {
          toolOk = false;
          log.error(toolErr, {
            stage: "tool_invocation",
            tool: name,
            toolUseId,
            inputKeys: Object.keys(input || {}),
            toolMs: Date.now() - toolStartedAt,
          });
          toolResult = { error: toolErr.message };
        }
        // Echo identifier-shaped inputs for the tools where the value IS the
        // bug surface (model mangles slotSK / professorId). We deliberately
        // leave free-text fields like `note` out of logs.
        const echoSlotSK =
          name === "book_slot" ? input?.slotSK : undefined;
        const echoProfessorId =
          name === "book_slot" || name === "get_professor_slots"
            ? input?.professorId
            : undefined;
        const echoConsultationId =
          name === "cancel_consultation" ? input?.consultationId : undefined;
        log.info("tool_done", {
          iter,
          tool: name,
          toolUseId,
          inputKeys: Object.keys(input || {}),
          ok: toolOk,
          errorMessage: toolOk ? undefined : toolResult.error,
          toolMs: Date.now() - toolStartedAt,
          slotSK: echoSlotSK,
          professorId: echoProfessorId,
          consultationId: echoConsultationId,
        });
        resultBlocks.push({
          toolResult: {
            toolUseId,
            content: [{ text: JSON.stringify(toolResult) }],
          },
        });
      }

      const toolResultMsg = { role: "user", content: resultBlocks };
      messages.push(toolResultMsg);
      newMessages.push(toolResultMsg);
      continue;
    }

    // Final assistant turn (plain text). Persist the full content array
    // even though we also extract a flat string for the HTTP response —
    // keeps the next turn's history shape consistent with tool turns.
    newMessages.push(outputMessage);
    const textBlock = (outputMessage.content || []).find(
      (b) => b.text && b.text.trim()
    );
    finalText = (textBlock && textBlock.text) || "";
    break;
  }

  if (iter >= 5) {
    log.warn("loop_limit_hit", {
      stage: "converse_loop",
      iter,
      lastStopReason,
    });
  }

  // Defensive fallback: if the model exited the loop with no usable text
  // (empty text block, content with no text block at all, or the loop
  // hit its iteration cap on a tool-use streak), do NOT ship `reply: ""`
  // to the frontend — the chat widgets render that as an empty bubble
  // (the "blank assistant message" bug). Surface a friendly retry hint
  // instead and log enough context to find the offending session in
  // CloudWatch.
  if (!finalText.trim()) {
    log.warn("empty_assistant_reply", {
      stage: "post_converse_loop",
      iter,
      lastStopReason,
      toolCalls: totalToolCalls,
      role: caller.role,
    });
    finalText =
      caller.role === "professor"
        ? "Sorry — I couldn't put that together. Could you rephrase, or ask about a specific day or student?"
        : "Sorry — I couldn't put that together. Could you rephrase your question?";
  }

  // STEP 6: Persist the full turn (user input + every assistant tool_use
  // message + every toolResult message + final assistant text) so the
  // next request can replay them. Order is preserved by combining a
  // request-level timestamp with a zero-padded per-message sequence.
  // userId is stamped on every row so a forged sessionId can't read or
  // continue someone else's conversation.
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const ttl = Math.floor(now / 1000) + SESSION_TTL_SECONDS;

  try {
    for (let i = 0; i < newMessages.length; i++) {
      const m = newMessages[i];
      const seq = String(i).padStart(4, "0");
      await putItem({
        PK: `SESSION#${sessionId}`,
        SK: `MSG#${now}#${seq}#${randomUUID()}`,
        role: m.role,
        contentBlocks: m.content,
        userId: caller.userId,
        createdAt,
        ttl,
      });
    }
  } catch (e) {
    // Persistence failure must NOT hide the reply. If a booking tool call
    // already landed in DynamoDB (slot claimed, consultation row written)
    // and we now throw a 500, the user sees an error but is actually booked
    // — and any retry hits DUPLICATE_BOOKING. Log loudly for CloudWatch,
    // but fall through and return the reply so the student knows what happened.
    log.error(e, {
      stage: "persist_messages",
      sessionId,
      persistedCount: newMessages.length,
      replyLen: finalText.length,
    });
  }

  log.end({
    iter,
    lastStopReason,
    toolCalls: totalToolCalls,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    replyLen: finalText.length,
    persistedTurnSize: newMessages.length,
  });

  return ok({ reply: finalText, sessionId, toolsUsed });
}
