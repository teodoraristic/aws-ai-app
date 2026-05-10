"use strict";

const { randomUUID } = require("crypto");
const {
  deleteItem,
  getItem,
  putItem,
  queryGsi1,
  queryGsi1Page,
  queryGsi2,
  queryPk,
  transactWrite,
  updateItem,
} = require("./db");
const { embedText, cosineSim } = require("./embeddings");
const {
  mentorshipSk,
  mentorshipGsi2Sk,
  getCurrentMentorshipForStudent,
  getLatestMentorshipWithProfessor,
} = require("./mentorship");

// Shape check matching what `list_professors` (and Cognito subs) return.
// Used both by the chat tool plumbing and the REST booking handler so the
// two paths reject the same garbage input with the same wording.
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Combine a YYYY-MM-DD + HH:MM into an absolute instant interpreted as UTC,
// matching the way `manage-slots` already treats `date`. Used to reject
// bookings whose slot start time has already passed.
function combineSlotInstantUtc(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [hh, mm] = String(timeStr).split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(hh || 0, mm || 0, 0, 0);
  return d;
}

// Cosine similarity threshold for topic-based grouping. Tuned for Titan v2
// 256-dim normalized vectors on short academic topic strings:
//   "SQL joins" vs "SQL JOINs"            ~0.95
//   "SQL joins" vs "join queries"         ~0.70
//   "SQL joins" vs "database normalization" ~0.45
//   "SQL joins" vs "React hooks"          ~0.10
// 0.55 catches paraphrases / typos without grouping unrelated subjects.
// Exam-prep slots get a slightly lower bar (0.45) so a student asking
// about "midterm prep" surfaces an existing exam_prep group on, say,
// "operating systems exam" without needing a near-verbatim phrase match.
const TOPIC_MATCH_THRESHOLD = 0.55;
const TOPIC_MATCH_THRESHOLD_EXAM_PREP = 0.45;
const TOPIC_MATCH_MAX = 3;

// Allowed values for consultationType. We normalize at write time so a
// missing / unknown value collapses to "general" without a migration.
const CONSULTATION_TYPES = new Set(["general", "exam_prep", "thesis"]);
function normalizeConsultationType(raw) {
  const t = raw == null ? "" : String(raw).trim();
  return CONSULTATION_TYPES.has(t) ? t : "general";
}

// Coerce a stored maxMentees value to a non-negative integer. Default 0 —
// a freshly-created professor has no mentee slots open until they pick a
// number themselves on the Thesis settings card.
function normalizeMaxMentees(raw) {
  if (raw == null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

async function listProfessors() {
  const items = await queryGsi1("ROLE#professor");
  return items.map((i) => ({
    professorId: i.userId,
    name: i.displayName,
    department: i.department || "",
    subjects: Array.isArray(i.subjects) ? i.subjects : [],
    maxMentees: normalizeMaxMentees(i.maxMentees),
  }));
}

async function listProfessorsPage({ limit = 50, exclusiveStartKey } = {}) {
  const { items, lastEvaluatedKey } = await queryGsi1Page("ROLE#professor", null, { limit, exclusiveStartKey });
  const professors = items.map((i) => ({
    professorId: i.userId,
    name: i.displayName,
    department: i.department || "",
    subjects: Array.isArray(i.subjects) ? i.subjects : [],
    maxMentees: normalizeMaxMentees(i.maxMentees),
  }));
  return { professors, lastEvaluatedKey };
}

async function getMyConsultations(userId, role, opts = {}) {
  const today = new Date().toISOString().split("T")[0];
  // 60-day backward window for "past": enough for the feedback composer
  // to surface freshly-finished sessions without the response ballooning.
  const PAST_LOOKBACK_DAYS = 60;
  const lowerBoundDate = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - PAST_LOOKBACK_DAYS);
    return d.toISOString().split("T")[0];
  })();
  const range = (opts.range || "upcoming").toLowerCase();

  const items =
    role === "student"
      ? await queryGsi2(`STUDENT#${userId}`)
      : await queryGsi1(`PROFESSOR#${userId}`);

  // Visibility rules differ by role:
  //   - students always see EVERY upcoming row of theirs (booked AND
  //     cancelled), so the reservations page can render "this was
  //     cancelled by you / by professor" tombstones for recently dropped
  //     sessions instead of silently making them vanish.
  //   - professors see upcoming booked rows + only those cancelled rows
  //     where the WHOLE session went away. A partial group cancel
  //     (one student dropped from a multi-person session) is hidden from
  //     the professor's row list — the participant counter on the slot
  //     decreases instead. This matches the requested rule:
  //         "if it was a grouped session and only one student cancels it
  //          should be visible to that student that he cancelled but to
  //          the professor just decrease the number of people coming."
  let upcoming = items.filter((i) => {
    // Waitlist rows live in the same GSI2 partition (STUDENT#{id}) but
    // have SK starting with WAITLIST# — exclude them from consultation results.
    if (i.SK && i.SK.startsWith("WAITLIST#")) return false;
    if (range === "upcoming") return i.date >= today;
    if (range === "past")
      return i.date >= lowerBoundDate && i.date < today;
    // range === "all"
    return i.date >= lowerBoundDate;
  });
  if (role === "professor") {
    // Build a per-slot count of rows still booked. A cancelled row is
    // "partial" iff at least one OTHER row on the same slot is still
    // booked; partial cancels are dropped from the professor's view.
    const stillBookedBySlot = new Map();
    for (const r of upcoming) {
      if (r.status === "booked" && r.slotSK) {
        stillBookedBySlot.set(
          r.slotSK,
          (stillBookedBySlot.get(r.slotSK) || 0) + 1
        );
      }
    }
    upcoming = upcoming.filter((r) => {
      if (r.status !== "cancelled") return true;
      // No slotSK to check against → keep the row (defensive: legacy data
      // without slotSK should still surface so the professor knows about it).
      if (!r.slotSK) return true;
      const stillBooked = stillBookedBySlot.get(r.slotSK) || 0;
      return stillBooked === 0;
    });
  }

  if (upcoming.length === 0) return upcoming;

  if (role === "student") {
    // Enrich student rows with the professor's profile so the My
    // Reservations card can show who they booked with (name, department)
    // without the frontend doing N extra fetches. Best-effort: a missing
    // profile leaves the field blank; the card falls back to a placeholder.
    const profIds = [
      ...new Set(upcoming.map((c) => c.professorId).filter(Boolean)),
    ];
    const profProfiles = await Promise.all(
      profIds.map((id) =>
        getItem(`USER#${id}`, "PROFILE").catch(() => null)
      )
    );
    const profById = new Map();
    for (const p of profProfiles) {
      if (p && p.userId) profById.set(p.userId, p);
    }
    return upcoming.map((c) => {
      const prof = profById.get(c.professorId);
      return {
        ...c,
        professorName: prof ? prof.displayName : "",
        professorEmail: prof ? prof.email : "",
        professorDepartment: prof ? prof.department || "" : "",
        // Surface attribution explicitly — the raw row already carries
        // these but spelling them out in the return shape keeps the
        // frontend consumer code obvious.
        cancelledBy: c.cancelledBy || null,
        cancelledAt: c.cancelledAt || null,
      };
    });
  }

  // Professor branch: enrich with each student's profile so the UI can
  // show who booked.
  const studentIds = [
    ...new Set(upcoming.map((c) => c.studentId).filter(Boolean)),
  ];
  const profiles = await Promise.all(
    studentIds.map((id) =>
      getItem(`USER#${id}`, "PROFILE").catch(() => null)
    )
  );
  const byId = new Map();
  for (const p of profiles) {
    if (p && p.userId) byId.set(p.userId, p);
  }

  // Fetch slot capacity AND duration for each unique slot. Capacity drives
  // the per-card capacity widget; duration lets the UI merge contiguous
  // bookings into a single "block" header (10:00-11:30) — same merge logic
  // as the Availability page.
  const uniqueSlotSKs = [...new Set(upcoming.map((c) => c.slotSK).filter(Boolean))];
  const slotItems = await Promise.all(
    uniqueSlotSKs.map((sk) =>
      getItem(`PROFESSOR#${userId}`, sk).catch(() => null)
    )
  );
  const slotInfo = new Map();
  for (let i = 0; i < uniqueSlotSKs.length; i++) {
    const slot = slotItems[i];
    if (slot) {
      slotInfo.set(uniqueSlotSKs[i], {
        maxParticipants: slot.maxParticipants || 1,
        currentParticipants: slot.currentParticipants || 0,
        // Legacy slots created before durationMinutes was persisted are all
        // 30-minute blocks (matches manage-slots fallback constant).
        durationMinutes: Number.isInteger(slot.durationMinutes)
          ? slot.durationMinutes
          : 30,
      });
    }
  }

  return upcoming.map((c) => {
    const profile = byId.get(c.studentId);
    const info = slotInfo.get(c.slotSK);
    return {
      ...c,
      studentName: profile ? profile.displayName : "",
      studentEmail: profile ? profile.email : "",
      slotMaxParticipants: info ? info.maxParticipants : undefined,
      slotCurrentParticipants: info ? info.currentParticipants : undefined,
      slotDurationMinutes: info ? info.durationMinutes : undefined,
      cancelledBy: c.cancelledBy || null,
      cancelledAt: c.cancelledAt || null,
    };
  });
}

// Find upcoming consultations for this professor whose topic is semantically
// similar to what the current student wants to discuss. Used by the chatbot
// BEFORE picking a slot: if another student already booked Tuesday 10:00 to
// discuss "SQL joins" and the current student wants to discuss "join queries",
// we offer them the chance to join that session instead of creating a new one.
//
// Matching is done via Titan embedding cosine similarity, NOT string match —
// "SQL joins" / "sql joinz" / "JOIN queries" all collapse to the same cluster.
//
// Slots the professor published as 1-on-1 (`maxParticipants === 1`) are
// excluded — the professor's stated cap wins, the student must book a fresh
// slot. Slots with capacity remaining (`currentParticipants < maxParticipants`)
// are included; full slots are filtered out.
async function findTopicMatches(professorId, topic, currentStudentId) {
  if (!professorId || !topic || !topic.trim()) return [];

  const today = new Date().toISOString().split("T")[0];
  const all = await queryGsi1(`PROFESSOR#${professorId}`);
  const candidates = all.filter(
    (c) =>
      c.SK === "METADATA" &&
      c.status !== "cancelled" &&
      c.date >= today &&
      c.studentId !== currentStudentId &&
      Array.isArray(c.topicEmbedding) &&
      c.topicEmbedding.length > 0
  );
  if (candidates.length === 0) return [];

  // Resolve slot capacity once per unique slotSK so we know which slots the
  // professor opened to multiple participants.
  const uniqueSlotSKs = [
    ...new Set(candidates.map((c) => c.slotSK).filter(Boolean)),
  ];
  const slotMap = new Map();
  await Promise.all(
    uniqueSlotSKs.map(async (sk) => {
      const slot = await getItem(`PROFESSOR#${professorId}`, sk).catch(
        () => null
      );
      if (slot) slotMap.set(sk, slot);
    })
  );

  let queryEmbedding;
  try {
    queryEmbedding = await embedText(topic);
  } catch {
    // If the embedding call fails we fall back to "no matches" rather than
    // surfacing a confusing error — the user can still book a new slot.
    return [];
  }
  if (!queryEmbedding) return [];

  const bySlot = new Map();
  for (const c of candidates) {
    const slot = slotMap.get(c.slotSK);
    if (!slot) continue;

    const allowsGroup = (slot.maxParticipants || 1) > 1;
    if (!allowsGroup) continue;
    if (slot.status === "full") continue;
    if ((slot.currentParticipants || 0) >= (slot.maxParticipants || 1)) continue;

    const similarity = cosineSim(queryEmbedding, c.topicEmbedding);
    // Exam-prep group sessions are explicitly meant to be discovered by
    // students asking about the same exam in different words, so we let
    // a slightly weaker semantic match through. General group slots keep
    // the stricter cutoff to avoid noisy "you could join this random
    // session" suggestions.
    const slotType = normalizeConsultationType(slot.consultationType);
    const threshold =
      slotType === "exam_prep"
        ? TOPIC_MATCH_THRESHOLD_EXAM_PREP
        : TOPIC_MATCH_THRESHOLD;
    if (similarity < threshold) continue;

    const topicText = c.topic || c.note || "";
    const existing = bySlot.get(c.slotSK);
    if (!existing) {
      bySlot.set(c.slotSK, {
        slotSK: c.slotSK,
        date: c.date,
        time: c.time,
        topics: topicText ? [topicText] : [],
        similarity: Number(similarity.toFixed(3)),
        currentParticipants: slot.currentParticipants || 0,
        maxParticipants: slot.maxParticipants || 1,
        consultationType: slotType,
        subject: slot.subject || "",
      });
    } else {
      if (topicText && !existing.topics.includes(topicText)) {
        existing.topics.push(topicText);
      }
      if (similarity > existing.similarity) {
        existing.similarity = Number(similarity.toFixed(3));
      }
    }
  }

  return [...bySlot.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOPIC_MATCH_MAX);
}

// True if this student already has an ACTIVE booking on the given slot.
// We hit GSI2 (per-student index) keyed by the slot's date+time to avoid a
// scan; the slotSK comparison weeds out any same-day-same-time edge cases
// across different professors.
async function hasStudentBookedSlot(studentId, professorId, slotSK, slotDate, slotTime) {
  if (!studentId || !slotSK) return false;
  const rows = await queryGsi2(
    `STUDENT#${studentId}`,
    `DATE#${slotDate}T${slotTime}`
  );
  return rows.some(
    (c) =>
      c.SK === "METADATA" &&
      c.status !== "cancelled" &&
      c.slotSK === slotSK &&
      c.professorId === professorId
  );
}

// Core booking writer reused by BOTH:
//   1. the chat assistant tool (`book_slot`), and
//   2. the manual REST endpoint (`POST /bookings`).
//
// Keeps the DynamoDB writes in a single place so the two booking surfaces
// can never diverge on the consultation row shape, GSI keys, slot-status
// transition, or topic-embedding policy.
//
// All booking invariants live HERE (shape, slot existence, past-slot,
// self-booking, duplicate booking, capacity). Callers only enforce
// transport-layer concerns (HTTP-level role check on the REST handler,
// system-prompt guidance on the chat tool). Error strings are friendly
// enough for the model to repeat verbatim AND for the modal to render
// inline.
async function bookSlotCore({
  professorId,
  slotSK,
  studentId,
  note = "",
  thesisTheme = "",
  log,
}) {
  if (!professorId || !UUID_LIKE.test(professorId)) {
    log?.warn?.("bookSlotCore.invalid_professorId", { professorId, slotSK });
    return {
      error:
        `professorId must be the UUID returned by list_professors (e.g. ` +
        `12a5b4c4-d011-70ba-4502-ef0be6402810), got "${professorId}". ` +
        `Call list_professors first and use the exact professorId field.`,
    };
  }
  // Require the full SLOT#YYYY-MM-DDTHH:MM shape so a truncated or
  // reformatted value fails fast here rather than silently returning
  // "Slot not found" after a wasted DynamoDB read.
  if (!slotSK || !/^SLOT#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slotSK)) {
    log?.warn?.("bookSlotCore.invalid_slotSK", { professorId, slotSK });
    return {
      error:
        `slotSK must be SLOT#YYYY-MM-DDTHH:MM (e.g. SLOT#2026-05-06T10:00), ` +
        `got "${slotSK}". Use the exact slotSK from get_professor_slots without reformatting.`,
    };
  }
  if (studentId && professorId === studentId) {
    log?.warn?.("bookSlotCore.self_booking", { professorId, slotSK });
    return { error: "You cannot reserve your own session." };
  }

  const slot = await getItem(`PROFESSOR#${professorId}`, slotSK);
  if (!slot) {
    log?.warn?.("bookSlotCore.slot_not_found", { professorId, slotSK });
    return { error: "Slot not found" };
  }

  // Past-slot guard. The slot row stores `date` (YYYY-MM-DD) and `time`
  // (HH:MM) separately; combineSlotInstantUtc reconstructs the absolute
  // instant in UTC so the comparison is timezone-stable.
  const slotInstant = combineSlotInstantUtc(slot.date, slot.time);
  if (!slotInstant || slotInstant.getTime() <= Date.now()) {
    log?.warn?.("bookSlotCore.past_slot", {
      professorId,
      slotSK,
      slotDate: slot.date,
      slotTime: slot.time,
    });
    return { error: "This session has already started or passed." };
  }

  if (slot.status === "full") {
    log?.warn?.("bookSlotCore.slot_full", {
      professorId,
      slotSK,
      currentParticipants: slot.currentParticipants,
      maxParticipants: slot.maxParticipants,
    });
    return { error: "Slot is full" };
  }

  // Duplicate-booking guard, indexed on the per-student GSI2 so we don't
  // need to scan the consultation table.
  if (studentId) {
    let alreadyBooked = false;
    try {
      alreadyBooked = await hasStudentBookedSlot(
        studentId,
        professorId,
        slotSK,
        slot.date,
        slot.time
      );
    } catch (e) {
      log?.warn?.("bookSlotCore.duplicate_check_failed", {
        professorId,
        slotSK,
        message: e.message,
      });
      // Fall through — better to risk a rare duplicate than block a real
      // booking on an index hiccup.
    }
    if (alreadyBooked) {
      log?.warn?.("bookSlotCore.duplicate_booking", {
        professorId,
        slotSK,
        studentId,
      });
      // Phrasing matters here — the model echoes this string almost
      // verbatim. "You have already reserved this session" got rephrased
      // by Nova Lite as "the slot you chose has already been reserved",
      // which the user reads as "someone else took it". Be explicit that
      // the existing reservation is THEIRS and tell the model what to do
      // next, so the conversation doesn't dead-end.
      return {
        error:
          "DUPLICATE_BOOKING: you (this student) already have an active " +
          "reservation on this exact slot. Tell the user clearly that " +
          "they already have a reservation for this session (mention the " +
          "date and time in natural language) and suggest viewing their " +
          "reservations or picking a different time. Do NOT say the slot " +
          "was taken by someone else.",
      };
    }
  }

  // Topic embedding is best-effort. A throttled / failing embedding shouldn't
  // block the booking — the row just won't appear in topic-match results
  // until backfilled.
  let topicEmbedding = null;
  if (note && note.trim()) {
    try {
      topicEmbedding = await embedText(note);
    } catch (e) {
      log?.warn?.("bookSlotCore.embed_failed", {
        professorId,
        slotSK,
        message: e.message,
      });
    }
  }

  // Snapshot the slot's type + subject onto the consultation row so the
  // historical shape survives any later edit / deletion of the slot.
  // Analytics, daily reports, and the cancellation tombstone all rely on
  // these fields being present on the consultation, not just the slot.
  const consultationType = normalizeConsultationType(slot.consultationType);
  const subjectSnapshot = slot.subject ? String(slot.subject) : undefined;

  // ── Thesis branch ───────────────────────────────────────────────
  //
  // Thesis slots are special: booking one may also create / advance a
  // mentorship row. Resolve the student's current mentorship state first
  // and decide which sub-flow to run before we touch any DDB write.
  //
  // The state machine is:
  //   none / declined  → new proposal: requires `thesisTheme`, creates a
  //                      pending mentorship row + initial consultation
  //                      atomically (TransactWriteItems).
  //   pending          → THESIS_PENDING_DECISION: reject. The student
  //                      cannot book another thesis slot until the
  //                      professor decides.
  //   accepted (same prof) → "update" consultation: regular booking, no
  //                      theme needed, no mentorship change.
  //   accepted (other prof) → THESIS_WRONG_MENTOR: reject. The student
  //                      already has a mentor and it isn't this one.
  //
  // Plus a global guard: before creating any new pending row we check
  // for any active mentorship across the faculty (THESIS_ALREADY_HAS_MENTOR).
  let thesisStage; // "initial" | "update" — only set on thesis branch
  let thesisThemeSnapshot; // string, snapshotted onto the consultation row
  let thesisMentorshipPut = null; // optional Transact item for new pending row

  if (consultationType === "thesis") {
    if (!studentId) {
      return { error: "Thesis bookings require an authenticated student." };
    }
    const current = await getCurrentMentorshipForStudent(studentId);
    const currentStatus = current ? current.status : "none";

    if (currentStatus === "pending") {
      return {
        error:
          "THESIS_PENDING_DECISION: you already proposed a thesis mentorship. " +
          "Wait for the professor's decision before booking another thesis slot. " +
          "Tell the user this clearly and offer to show them their pending proposal.",
      };
    }

    if (currentStatus === "accepted") {
      if (current.professorId !== professorId) {
        return {
          error:
            "THESIS_WRONG_MENTOR: this thesis slot belongs to a professor who " +
            "is not your accepted mentor. Tell the user their accepted mentor " +
            "is a different professor and offer to show that professor's " +
            "thesis slots instead. Do NOT name the slot's professor.",
        };
      }
      thesisStage = "update";
      thesisThemeSnapshot = current.thesisTheme || "";
    } else {
      // none / declined → fresh proposal.
      const cleanTheme = (thesisTheme || "").trim();
      if (!cleanTheme) {
        return {
          error:
            "THESIS_THEME_REQUIRED: a thesis proposal needs a theme. Ask the " +
            "user for the thesis theme (one short paragraph is fine) and call " +
            "propose_thesis again with the theme.",
        };
      }

      // Block fresh proposals when ANY pending row exists for this student
      // anywhere — getCurrentMentorshipForStudent already returned the
      // newest, but a "declined" newest with a stray older "pending" is
      // theoretically possible. Re-check the full list to be safe.
      const allRows = await queryGsi2(
        `STUDENT#${studentId}`,
        "MENTOR#"
      );
      if (allRows.some((r) => r.status === "pending")) {
        return {
          error:
            "THESIS_ALREADY_HAS_MENTOR: you already have a pending thesis " +
            "proposal in flight. Resolve it before starting another.",
        };
      }
      if (allRows.some((r) => r.status === "accepted")) {
        return {
          error:
            "THESIS_ALREADY_HAS_MENTOR: you already have an accepted thesis " +
            "mentor. Tell the user they need to keep working with that mentor.",
        };
      }

      // Compute next attempt for THIS specific (student, professor) pair.
      const prevWithProf = await getLatestMentorshipWithProfessor(
        studentId,
        professorId
      );
      const attempt = prevWithProf ? (prevWithProf.attempt || 0) + 1 : 1;
      const nowIso = new Date().toISOString();

      thesisStage = "initial";
      thesisThemeSnapshot = cleanTheme;
      thesisMentorshipPut = {
        Put: {
          Item: {
            PK: `PROFESSOR#${professorId}`,
            SK: mentorshipSk(studentId, attempt),
            GSI2PK: `STUDENT#${studentId}`,
            GSI2SK: mentorshipGsi2Sk(professorId, attempt),
            studentId,
            professorId,
            attempt,
            status: "pending",
            thesisTheme: cleanTheme,
            proposedAt: nowIso,
          },
          // Idempotency: if a parallel propose snuck through with the same
          // attempt number, fail the whole transaction so we don't end up
          // with two "pending" rows for the same student.
          ConditionExpression: "attribute_not_exists(PK)",
        },
      };
    }
  }

  const consultationId = randomUUID();
  const newCount = (slot.currentParticipants || 0) + 1;
  const newStatus = newCount >= (slot.maxParticipants || 1) ? "full" : "available";

  const consultationItem = {
    PK: `CONSULTATION#${consultationId}`,
    SK: "METADATA",
    GSI1PK: `PROFESSOR#${professorId}`,
    GSI1SK: `DATE#${slot.date}T${slot.time}`,
    GSI2PK: `STUDENT#${studentId}`,
    GSI2SK: `DATE#${slot.date}T${slot.time}`,
    consultationId,
    studentId,
    professorId,
    slotSK,
    date: slot.date,
    time: slot.time,
    note,
    topic: note || (thesisStage === "initial" ? "Thesis proposal" : "Consultation"),
    topicEmbedding,
    consultationType,
    subject: subjectSnapshot,
    status: "booked",
    createdAt: new Date().toISOString(),
    ...(thesisStage ? { thesisStage } : {}),
    ...(thesisThemeSnapshot ? { thesisTheme: thesisThemeSnapshot } : {}),
  };

  if (thesisMentorshipPut) {
    // Transactional path: brand-new thesis proposal. Slot claim,
    // mentorship row, and consultation row must all succeed or all fail
    // — partial state would leave the student looking like they have a
    // pending mentor with no booking, or a slot decremented but no
    // record of the booking.
    const { transactWrite } = require("./db");

    const claimNames = { "#slotStatus": "status" };
    const claimValues = {
      ":available": "available",
      ":currentParticipants": newCount,
      ":newStatus": newStatus,
      ":gsi1pk": `SLOT_STATUS#${newStatus}`,
    };
    const claimUpdate = {
      Update: {
        Key: { PK: `PROFESSOR#${professorId}`, SK: slotSK },
        UpdateExpression:
          "SET currentParticipants = :currentParticipants, " +
          "#slotStatus = :newStatus, GSI1PK = :gsi1pk",
        ConditionExpression: "#slotStatus = :available",
        ExpressionAttributeNames: claimNames,
        ExpressionAttributeValues: claimValues,
      },
    };

    try {
      await transactWrite([
        claimUpdate,
        thesisMentorshipPut,
        { Put: { Item: consultationItem } },
      ]);
    } catch (e) {
      // DDB returns a single TransactionCanceledException with a per-item
      // CancellationReasons array. Map the most likely cause back to a
      // user-friendly message.
      const reasons = e?.CancellationReasons || [];
      const slotFailed = reasons[0]?.Code === "ConditionalCheckFailed";
      const mentorshipFailed = reasons[1]?.Code === "ConditionalCheckFailed";
      log?.warn?.("bookSlotCore.thesis_transact_failed", {
        name: e?.name,
        reasons: reasons.map((r) => r?.Code).join(","),
      });
      if (slotFailed) return { error: "Slot is full" };
      if (mentorshipFailed) {
        return {
          error:
            "THESIS_ALREADY_HAS_MENTOR: a parallel proposal landed first. " +
            "Tell the user to refresh their thesis status and try again.",
        };
      }
      throw e;
    }
  } else {
    // Regular path (general / exam_prep / thesis "update"): atomic
    // TransactWriteItems so the slot-count increment and the consultation
    // row are written together or not at all. The previous two-step approach
    // (updateItem then putItem) left a window where the slot count could be
    // incremented but the consultation row never written — leaving the slot
    // permanently at the wrong capacity with no record for the student.
    try {
      await transactWrite([
        {
          Update: {
            Key: { PK: `PROFESSOR#${professorId}`, SK: slotSK },
            UpdateExpression:
              "SET currentParticipants = :newCount, #slotStatus = :newStatus, GSI1PK = :gsi1pk",
            ConditionExpression: "#slotStatus = :available",
            ExpressionAttributeNames: { "#slotStatus": "status" },
            ExpressionAttributeValues: {
              ":available": "available",
              ":newCount": newCount,
              ":newStatus": newStatus,
              ":gsi1pk": `SLOT_STATUS#${newStatus}`,
            },
          },
        },
        { Put: { Item: consultationItem } },
      ]);
    } catch (e) {
      const reasons = e?.CancellationReasons || [];
      const slotFailed = reasons[0]?.Code === "ConditionalCheckFailed";
      log?.warn?.("bookSlotCore.regular_transact_failed", {
        name: e?.name,
        reasons: reasons.map((r) => r?.Code).join(","),
      });
      if (slotFailed || e.name === "ConditionalCheckFailedException") {
        return { error: "Slot is full" };
      }
      throw e;
    }
  }

  log?.info?.("bookSlotCore.written", {
    consultationId,
    professorId,
    slotSK,
    studentId,
    date: slot.date,
    time: slot.time,
    newSlotStatus: newStatus,
    newCount,
    maxParticipants: slot.maxParticipants || 1,
    consultationType,
    thesisStage,
  });

  // Waitlist cleanup: if the booking student happened to be queued on
  // this same slot (typical "I joined the waitlist, then got the
  // seat_opened ping, then booked"), drop their waitlist row so a
  // future cancel doesn't ping them again on a slot they already hold.
  try {
    const { clearStudentFromWaitlist } = require("./waitlist");
    await clearStudentFromWaitlist(professorId, slotSK, studentId);
  } catch (_err) {
    /* silent — waitlist row is best-effort */
  }

  return {
    consultationId,
    date: slot.date,
    time: slot.time,
    slotSK,
    professorId,
    currentParticipants: newCount,
    maxParticipants: slot.maxParticipants || 1,
    status: newStatus,
    topic: consultationItem.topic,
    consultationType,
    subject: subjectSnapshot || "",
    thesisStage: thesisStage || undefined,
    thesisTheme: thesisThemeSnapshot || undefined,
  };
}

// Core "join an existing group session" writer reused by the chat tool
// (`join_group_session`). Like `bookSlotCore`, all booking invariants live
// here — the chat handler only enforces the role check (transport-layer).
//
// Capacity intentionally does NOT auto-expand here anymore. The slot's
// `maxParticipants` is the professor's stated cap (set at publish time, or
// raised manually via the capacity widget). A topic-match join is just a
// regular booking that increments `currentParticipants` against that cap;
// once the slot is full, no more joins.
async function joinGroupCore({
  professorId,
  slotSK,
  studentId,
  note = "",
  log,
}) {
  if (!professorId || !UUID_LIKE.test(professorId)) {
    log?.warn?.("joinGroupCore.invalid_professorId", { professorId, slotSK });
    return {
      error: `professorId must be a UUID, got "${professorId}". Call list_professors first.`,
    };
  }
  if (!slotSK || !/^SLOT#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slotSK)) {
    log?.warn?.("joinGroupCore.invalid_slotSK", { professorId, slotSK });
    return {
      error: `slotSK must be SLOT#YYYY-MM-DDTHH:MM (e.g. SLOT#2026-05-06T10:00), got "${slotSK}".`,
    };
  }
  if (studentId && professorId === studentId) {
    log?.warn?.("joinGroupCore.self_booking", { professorId, slotSK });
    return { error: "You cannot join your own session." };
  }

  const slot = await getItem(`PROFESSOR#${professorId}`, slotSK);
  if (!slot) {
    log?.warn?.("joinGroupCore.slot_not_found", { professorId, slotSK });
    return { error: "Slot not found" };
  }

  // Group-only guard. A 1-on-1 slot stays 1-on-1 forever — the professor
  // sets the ceiling at publish time (and may raise it manually via the
  // capacity widget). The old auto-expansion is gone: a join is just a
  // regular booking inside the existing cap.
  if ((slot.maxParticipants || 1) <= 1) {
    log?.warn?.("joinGroupCore.solo_slot", {
      professorId,
      slotSK,
      maxParticipants: slot.maxParticipants,
    });
    return {
      error:
        "This slot was set up as a private 1-on-1 session by the professor. " +
        "Group joining is not allowed. Please book a different available slot instead.",
    };
  }

  const slotInstant = combineSlotInstantUtc(slot.date, slot.time);
  if (!slotInstant || slotInstant.getTime() <= Date.now()) {
    log?.warn?.("joinGroupCore.past_slot", {
      professorId,
      slotSK,
      slotDate: slot.date,
      slotTime: slot.time,
    });
    return { error: "This session has already started or passed." };
  }

  const max = slot.maxParticipants || 1;
  const cur = slot.currentParticipants || 0;
  if (slot.status === "full" || cur >= max) {
    log?.warn?.("joinGroupCore.slot_full", {
      professorId,
      slotSK,
      currentParticipants: cur,
      maxParticipants: max,
    });
    return { error: "This session is fully booked." };
  }

  if (studentId) {
    let alreadyBooked = false;
    try {
      alreadyBooked = await hasStudentBookedSlot(
        studentId,
        professorId,
        slotSK,
        slot.date,
        slot.time
      );
    } catch (e) {
      log?.warn?.("joinGroupCore.duplicate_check_failed", {
        professorId,
        slotSK,
        message: e.message,
      });
    }
    if (alreadyBooked) {
      log?.warn?.("joinGroupCore.duplicate_booking", {
        professorId,
        slotSK,
        studentId,
      });
      // Same wording rationale as bookSlotCore — be explicit that the
      // existing reservation belongs to the current student so the model
      // doesn't reframe it as "someone else took the slot".
      return {
        error:
          "DUPLICATE_BOOKING: you (this student) already have an active " +
          "reservation on this exact slot. Tell the user clearly that " +
          "they already have a reservation for this session (mention the " +
          "date and time in natural language) and suggest viewing their " +
          "reservations or picking a different time. Do NOT say the slot " +
          "was taken by someone else.",
      };
    }
  }

  // Find every other booking on this slot so we can notify them once the
  // join lands. Querying GSI1 by professor + the slot's date+time prefix
  // returns just the consultation METADATA rows for that slot.
  const slotDate = slotSK.replace(/^SLOT#/, "");
  const sameSlotRows = await queryGsi1(
    `PROFESSOR#${professorId}`,
    `DATE#${slotDate}`
  );
  const othersInSlot = sameSlotRows.filter(
    (c) =>
      c.SK === "METADATA" &&
      c.slotSK === slotSK &&
      c.status !== "cancelled" &&
      c.studentId !== studentId
  );

  let topicEmbedding = null;
  if (note && note.trim()) {
    try {
      topicEmbedding = await embedText(note);
    } catch (e) {
      log?.warn?.("joinGroupCore.embed_failed", {
        professorId,
        slotSK,
        message: e.message,
      });
    }
  }

  const newCount = cur + 1;
  const newStatus = newCount >= max ? "full" : "available";

  const consultationType = normalizeConsultationType(slot.consultationType);
  const subjectSnapshot = slot.subject ? String(slot.subject) : undefined;
  const consultationId = randomUUID();

  const consultationItem = {
    PK: `CONSULTATION#${consultationId}`,
    SK: "METADATA",
    GSI1PK: `PROFESSOR#${professorId}`,
    GSI1SK: `DATE#${slot.date}T${slot.time}`,
    GSI2PK: `STUDENT#${studentId}`,
    GSI2SK: `DATE#${slot.date}T${slot.time}`,
    consultationId,
    studentId,
    professorId,
    slotSK,
    date: slot.date,
    time: slot.time,
    note,
    topic: note || "Consultation",
    topicEmbedding,
    consultationType,
    subject: subjectSnapshot,
    isGroupSession: true,
    status: "booked",
    createdAt: new Date().toISOString(),
  };

  // Atomic: slot-count increment + consultation row in one transaction.
  // The condition on currentParticipants catches concurrent joins that
  // would otherwise both pass the pre-check and both succeed, causing
  // over-capacity. The previous two-step approach (updateItem then putItem)
  // left a window where the slot was incremented but no consultation row
  // existed if the Lambda timed out between the two writes.
  try {
    await transactWrite([
      {
        Update: {
          Key: { PK: `PROFESSOR#${professorId}`, SK: slotSK },
          UpdateExpression:
            "SET currentParticipants = :newCount, #slotStatus = :newStatus, GSI1PK = :gsi1pk",
          ConditionExpression: "currentParticipants = :expected",
          ExpressionAttributeNames: { "#slotStatus": "status" },
          ExpressionAttributeValues: {
            ":expected": cur,
            ":newCount": newCount,
            ":newStatus": newStatus,
            ":gsi1pk": `SLOT_STATUS#${newStatus}`,
          },
        },
      },
      { Put: { Item: consultationItem } },
    ]);
  } catch (e) {
    const reasons = e?.CancellationReasons || [];
    const slotFailed = reasons[0]?.Code === "ConditionalCheckFailed";
    log?.warn?.("joinGroupCore.transact_failed", {
      name: e?.name,
      reasons: reasons.map((r) => r?.Code).join(","),
    });
    if (slotFailed || e.name === "ConditionalCheckFailedException") {
      return { error: "Session was modified by another request. Please try again." };
    }
    throw e;
  }

  for (const c of othersInSlot) {
    await createNotification(c.studentId, {
      type: "group_join",
      consultationId: c.consultationId,
      slotSK,
      date: slot.date,
      time: slot.time,
      message: `Another student has joined your consultation session on ${slot.date} at ${slot.time}. It is now a group session.`,
    }).catch(() => {
      // Best-effort: a notification failure must not unwind the join.
    });
  }

  log?.info?.("joinGroupCore.written", {
    consultationId,
    professorId,
    slotSK,
    studentId,
    notifiedCount: othersInSlot.length,
    newCount,
    maxParticipants: max,
  });

  try {
    const { clearStudentFromWaitlist } = require("./waitlist");
    await clearStudentFromWaitlist(professorId, slotSK, studentId);
  } catch (_err) {
    /* silent — waitlist row is best-effort */
  }

  return {
    consultationId,
    date: slot.date,
    time: slot.time,
    slotSK,
    professorId,
    currentParticipants: newCount,
    maxParticipants: max,
    status: newStatus,
    topic: note || "Consultation",
    consultationType,
    subject: subjectSnapshot || "",
    groupSize: newCount,
    notifiedStudents: othersInSlot.length,
  };
}

// Writes a notification row for a user. TTL = 30 days.
async function createNotification(userId, data) {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + 60 * 60 * 24 * 30;
  await putItem({
    PK: `USER#${userId}`,
    SK: `NOTIF#${now}#${randomUUID()}`,
    userId,
    type: data.type,
    message: data.message,
    consultationId: data.consultationId,
    slotSK: data.slotSK,
    date: data.date,
    time: data.time,
    read: false,
    createdAt: new Date(now).toISOString(),
    ttl,
  });
}

// List notifications for a user. Source-of-truth for read/unread state lives
// on the row (`read` boolean) — read state is no longer auto-cleared on
// fetch like the old `getAndClearNotifications` did. The client decides when
// to mark a notification read via the dedicated mark-read endpoint.
//
// Default sort is newest-first (NOTIF# SK encodes an epochMs prefix, so
// ScanIndexForward=false on the primary key gives chronological DESC). The
// `limit` arg caps the response so the bell never has to render the full
// 30-day TTL window.
async function listNotifications(userId, { limit = 50 } = {}) {
  const rows = await queryPk(`USER#${userId}`, "NOTIF#", {
    limit,
    scanForward: false,
  });
  return rows.map((r) => ({
    id: r.SK,
    type: r.type,
    message: r.message,
    consultationId: r.consultationId,
    slotSK: r.slotSK,
    date: r.date,
    time: r.time,
    read: !!r.read,
    createdAt: r.createdAt,
  }));
}

// Marks a single notification row as read. Returns true on a successful
// flip, false if the row didn't exist (e.g. already deleted, wrong owner).
async function markNotificationRead(userId, notifSK) {
  if (!notifSK || !notifSK.startsWith("NOTIF#")) return false;
  // Defense in depth — make the update conditional on the row actually
  // existing under THIS user's partition. If a caller ever passes someone
  // else's SK, the conditional check fails and we return false instead of
  // creating a phantom row via UpdateItem's upsert behavior.
  try {
    await updateItem(
      `USER#${userId}`,
      notifSK,
      { read: true },
      {
        expression: "attribute_exists(PK)",
      }
    );
    return true;
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

// Marks every unread notification for the user as read in a single fan-out.
// Returns the count actually flipped.
async function markAllNotificationsRead(userId) {
  const rows = await queryPk(`USER#${userId}`, "NOTIF#");
  const unread = rows.filter((r) => !r.read);
  if (unread.length === 0) return 0;
  const results = await Promise.allSettled(
    unread.map((r) => updateItem(`USER#${userId}`, r.SK, { read: true }))
  );
  return results.filter((r) => r.status === "fulfilled").length;
}

// Deletes a single notification row. Same ownership guard as markRead.
async function deleteNotification(userId, notifSK) {
  if (!notifSK || !notifSK.startsWith("NOTIF#")) return false;
  const existing = await getItem(`USER#${userId}`, notifSK);
  if (!existing) return false;
  await deleteItem(`USER#${userId}`, notifSK);
  return true;
}

function formatCancellationDate(dateStr, timeStr) {
  if (!dateStr) return "your upcoming session";
  const [, month, day] = dateStr.split("-").map(Number);
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const monthName = MONTHS[(month || 1) - 1] || "";
  return timeStr ? `${day} ${monthName} at ${timeStr}` : `${day} ${monthName}`;
}

async function cancelConsultation(consultationId, userId, opts = {}) {
  const item = await getItem(`CONSULTATION#${consultationId}`, "METADATA");
  if (!item) return { error: "Not found" };
  // Either the student who booked, or the professor who hosts it can cancel.
  if (item.studentId !== userId && item.professorId !== userId) {
    return { error: "Not allowed" };
  }

  // Idempotency guard: a re-cancel must not double-decrement
  // currentParticipants on the slot or fire a duplicate cancellation
  // notification to the student. The chat tool can call us a second time
  // if the model retries, and the manual "Cancel" button in the UI can
  // also race a stale view of the consultation list.
  if (item.status === "cancelled") {
    return { cancelled: true, alreadyCancelled: true };
  }

  // Persist who cancelled and when so both sides of the consultation can
  // render a "Cancelled by professor / Cancelled by you" tombstone with
  // accurate attribution. The boolean check against item.professorId is
  // the source of truth — caller role lives in Cognito which we don't
  // re-fetch here.
  const cancelledBy =
    userId === item.professorId ? "professor" : "student";

  // Cancellation reason is now accepted from BOTH roles. Trim, cap at 240
  // chars (matches the UI's textarea maxLength), and stamp on the row so
  // analytics can show why people drop and the cancelled tombstone has
  // context. Pre-existing professor branch already passed `opts.reason`
  // through; we just generalise.
  const rawReason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  const cancellationReason = rawReason ? rawReason.slice(0, 240) : "";

  // Lead time is "hours between now and the slot start" — negative when
  // the cancellation lands AFTER the session already began. Stored on the
  // row so the analytics aggregator can bucket cancellations by lead time
  // ( >48h | 24-48h | <24h | same-day | after-start ) without having to
  // recompute from raw timestamps.
  const slotInstantUtc = combineSlotInstantUtc(item.date, item.time);
  const cancelledAtIso = new Date().toISOString();
  let cancellationLeadHours = null;
  if (slotInstantUtc && Number.isFinite(slotInstantUtc.getTime())) {
    cancellationLeadHours =
      (slotInstantUtc.getTime() - Date.now()) / 3_600_000;
    cancellationLeadHours =
      Math.round(cancellationLeadHours * 100) / 100; // 2dp
  }

  await updateItem(`CONSULTATION#${consultationId}`, "METADATA", {
    status: "cancelled",
    cancelledBy,
    cancelledAt: cancelledAtIso,
    ...(cancellationReason ? { cancellationReason } : {}),
    ...(cancellationLeadHours != null ? { cancellationLeadHours } : {}),
  });

  const slot = await getItem(`PROFESSOR#${item.professorId}`, item.slotSK);
  let newSlotCount = null;
  if (slot) {
    newSlotCount = Math.max(0, (slot.currentParticipants || 0) - 1);
    await updateItem(`PROFESSOR#${item.professorId}`, item.slotSK, {
      currentParticipants: newSlotCount,
      status: "available",
      GSI1PK: "SLOT_STATUS#available",
    });
  }

  const when = formatCancellationDate(item.date, item.time);
  const topicClause = item.topic ? ` (${item.topic})` : "";

  const reasonClause = cancellationReason
    ? ` Reason: ${cancellationReason}`
    : "";

  if (cancelledBy === "professor" && item.studentId) {
    // Professor pulled the session — notify the student so they see it
    // in the bell without having to refresh. Append the reason verbatim
    // (truncated) when the professor wrote one, so the student knows why
    // (e.g. "I'm out sick — let's reschedule").
    await createNotification(item.studentId, {
      type: "cancellation",
      message:
        `Your consultation on ${when}${topicClause} was cancelled by your professor.` +
        reasonClause,
      consultationId,
      slotSK: item.slotSK,
      date: item.date,
      time: item.time,
    }).catch(() => {
      // Best-effort — a notification failure must not block the cancellation.
    });
  } else if (cancelledBy === "student" && item.professorId) {
    // Student dropped — notify the professor symmetrically, with their
    // name so the professor can scan the bell and recognise who
    // cancelled. For group sessions where other students are still
    // booked, surface the new participant count too so the professor
    // immediately understands the session is happening at reduced size.
    const studentProfile = await getItem(
      `USER#${item.studentId}`,
      "PROFILE"
    ).catch(() => null);
    const studentLabel =
      (studentProfile && studentProfile.displayName) ||
      (studentProfile && studentProfile.email) ||
      "A student";

    const isGroupCapable = (slot && slot.maxParticipants > 1) || false;
    const stillBooked = newSlotCount == null ? null : newSlotCount;
    let message;
    if (isGroupCapable && stillBooked != null && stillBooked > 0) {
      const peopleClause =
        stillBooked === 1 ? "1 student is still booked" : `${stillBooked} students are still booked`;
      message =
        `${studentLabel} dropped from your group session on ${when}${topicClause}. ${peopleClause}.` +
        reasonClause;
    } else {
      message =
        `${studentLabel} cancelled their consultation on ${when}${topicClause}.` +
        reasonClause;
    }

    await createNotification(item.professorId, {
      type: "cancellation",
      message,
      consultationId,
      slotSK: item.slotSK,
      date: item.date,
      time: item.time,
    }).catch(() => {
      // Best-effort — a notification failure must not block the cancellation.
    });
  }

  // Waitlist nudge: when capacity opens up on a slot, notify the
  // longest-waiting student so they can take it. Notify-only — we never
  // auto-promote; the student must come back and book through the
  // regular path. We DON'T notify the student who just cancelled (they
  // wouldn't take their own seat back) and we DON'T fire the notification
  // for partial group cancels where the slot was already non-full going
  // in (no "newly opened seat" to advertise). The cancelDay path passes
  // notifyWaitlist=false so we don't ping students about slots that are
  // about to be deleted.
  try {
    const slotMax = (slot && slot.maxParticipants) || 1;
    const wasFullBefore =
      slot && (slot.currentParticipants || 0) >= slotMax;
    const notifyWaitlist = opts.notifyWaitlist !== false;
    if (
      notifyWaitlist &&
      wasFullBefore &&
      newSlotCount != null &&
      newSlotCount < slotMax
    ) {
      const { nextWaitlistedFor } = require("./waitlist");
      const next = await nextWaitlistedFor(item.professorId, item.slotSK);
      if (next && next.studentId && next.studentId !== userId) {
        const profProfile = await getItem(
          `USER#${item.professorId}`,
          "PROFILE"
        ).catch(() => null);
        const profLabel =
          (profProfile && profProfile.displayName) || "your professor";
        const seatWhen = formatCancellationDate(next.date, next.time);
        await createNotification(next.studentId, {
          type: "seat_opened",
          message:
            `A seat opened up on ${seatWhen} with ${profLabel}. ` +
            `Open the booking flow to grab it before someone else does.`,
          slotSK: item.slotSK,
          date: next.date,
          time: next.time,
        }).catch(() => {});
      }
    }
  } catch (_err) {
    // Waitlist is a soft layer — failures here must not break the
    // cancellation itself, which has already been written above.
  }

  // Thesis-mentorship cleanup: when the student cancels their `initial`
  // proposal booking, flip the linked pending mentorship to `declined`
  // with reason "withdrawn by student". The plan calls this an "implicit
  // mentorship cancel" — modeled as a decline so the same UI tab handles
  // the row, and so a future re-proposal can bump `attempt` cleanly.
  // Acceptance-stage updates (thesisStage="update") are normal cancellations:
  // the mentorship row stays accepted, the student just loses one seat.
  if (
    item.consultationType === "thesis" &&
    item.thesisStage === "initial" &&
    cancelledBy === "student"
  ) {
    try {
      const pendingRows = await queryGsi2(
        `STUDENT#${item.studentId}`,
        `MENTOR#${item.professorId}#`
      );
      const pending = pendingRows.find((r) => r.status === "pending");
      if (pending) {
        await updateItem(pending.PK, pending.SK, {
          status: "declined",
          declineReason: cancellationReason || "withdrawn by student",
          decidedAt: cancelledAtIso,
        });
      }
    } catch (_err) {
      // Soft cleanup — the booking was already cancelled above. Worst
      // case the mentorship row stays "pending" and a sweep job /
      // explicit user action can still reset it.
    }
  }

  return {
    cancelled: true,
    cancelledBy,
    cancelledAt: cancelledAtIso,
    cancellationLeadHours,
    cancellationReason: cancellationReason || null,
  };
}

// ---------- Feedback ----------
//
// Two independent feedback channels per consultation. The shape lives on
// CONSULTATION#{id}/METADATA via two optional fields:
//   - studentFeedback   { rating: 1..5, comment?: string, submittedAt }
//   - professorFeedback { attended: "yes"|"no"|"late", note?: string, submittedAt }
//
// One submission per side. The window is indefinite — anyone who held an
// active booking on a past consultation can fill it in whenever. The
// server enforces that:
//   - the caller is the student OR the host professor on this consultation
//   - the consultation is in the past (slot's start instant has elapsed)
//   - the role's slice has not been written before
const VALID_RATINGS = new Set([1, 2, 3, 4, 5]);
const VALID_ATTENDED = new Set(["yes", "no", "late"]);

async function submitFeedback({ consultationId, userId, payload, log }) {
  if (!consultationId) return { error: "Missing consultationId" };
  const item = await getItem(`CONSULTATION#${consultationId}`, "METADATA");
  if (!item) return { error: "Not found" };

  // Identify the caller's role on this specific consultation row. We do
  // NOT trust the caller-asserted role here — Cognito role can drift from
  // the row's actual student/professor identity (e.g. an admin token, or
  // a future role). The row IDs are the source of truth.
  let role = null;
  if (item.studentId === userId) role = "student";
  else if (item.professorId === userId) role = "professor";
  if (!role) return { error: "Not allowed" };

  if (item.status === "cancelled") {
    return { error: "Cancelled consultations don't take feedback." };
  }

  // "Past" means the slot's start instant has elapsed. Anything earlier
  // is rejected so the student can't pre-rate a future session.
  const slotInstant = combineSlotInstantUtc(item.date, item.time);
  if (
    !slotInstant ||
    !Number.isFinite(slotInstant.getTime()) ||
    slotInstant.getTime() > Date.now()
  ) {
    return {
      error:
        "Feedback can only be submitted after the consultation has started.",
    };
  }

  const submittedAt = new Date().toISOString();

  if (role === "student") {
    if (item.studentFeedback) {
      return { error: "You've already submitted feedback for this session." };
    }
    const ratingRaw = payload?.rating;
    const rating = Number.isInteger(ratingRaw) ? ratingRaw : Number(ratingRaw);
    if (!VALID_RATINGS.has(rating)) {
      return { error: "Rating must be a whole number from 1 to 5." };
    }
    const comment =
      typeof payload?.comment === "string"
        ? payload.comment.trim().slice(0, 600)
        : "";
    const studentFeedback = {
      rating,
      ...(comment ? { comment } : {}),
      submittedAt,
    };
    await updateItem(
      `CONSULTATION#${consultationId}`,
      "METADATA",
      { studentFeedback },
      {
        // Defend against a parallel double-submit racing the get/put above.
        expression: "attribute_not_exists(studentFeedback)",
      }
    );
    log?.info?.("submitFeedback.student.written", {
      consultationId,
      rating,
      hasComment: !!comment,
    });
    return { ok: true, role, studentFeedback };
  }

  // role === "professor"
  if (item.professorFeedback) {
    return { error: "You've already submitted feedback for this session." };
  }
  const attended =
    typeof payload?.attended === "string" ? payload.attended : "";
  if (!VALID_ATTENDED.has(attended)) {
    return { error: "Attended must be one of: yes, no, late." };
  }
  const note =
    typeof payload?.note === "string"
      ? payload.note.trim().slice(0, 600)
      : "";
  const professorFeedback = {
    attended,
    ...(note ? { note } : {}),
    submittedAt,
  };
  await updateItem(
    `CONSULTATION#${consultationId}`,
    "METADATA",
    { professorFeedback },
    {
      expression: "attribute_not_exists(professorFeedback)",
    }
  );
  log?.info?.("submitFeedback.professor.written", {
    consultationId,
    attended,
    hasNote: !!note,
  });

  // No-show notification is best-effort. The student gets a low-stakes
  // heads-up so they can reach out if it's a mistake (e.g. they joined
  // late but the professor marked them as no-show by accident).
  if (attended === "no" && item.studentId) {
    const when = formatCancellationDate(item.date, item.time);
    const topicClause = item.topic ? ` (${item.topic})` : "";
    await createNotification(item.studentId, {
      type: "no_show",
      message:
        `You were marked as a no-show for your consultation on ${when}${topicClause}. ` +
        `If this is a mistake, please reach out to your professor.`,
      consultationId,
      slotSK: item.slotSK,
      date: item.date,
      time: item.time,
    }).catch(() => {
      /* swallow — feedback submission still succeeds */
    });
  }

  return { ok: true, role, professorFeedback };
}

module.exports = {
  listProfessors,
  listProfessorsPage,
  getMyConsultations,
  cancelConsultation,
  findTopicMatches,
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  bookSlotCore,
  joinGroupCore,
  hasStudentBookedSlot,
  combineSlotInstantUtc,
  normalizeConsultationType,
  normalizeMaxMentees,
  CONSULTATION_TYPES,
  submitFeedback,
};
