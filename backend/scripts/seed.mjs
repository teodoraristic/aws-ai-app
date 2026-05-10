#!/usr/bin/env node
//
// Seed Cognito + DynamoDB with fake users (and optionally slots/consultations)
// so we can hit the running stack with realistic data without clicking through
// the sign-up flow N times.
//
// Usage:
//   npm install                    (once, in this folder)
//   npm run seed                   create users, idempotent
//   npm run seed:reset             delete previously seeded users + rows, then seed
//   npm run seed:with-data         seed users + slots + sample bookings
//   npm run seed:fresh             reset + users + data (most useful for E2E demos)
//
// Auth: uses your default AWS credential chain (e.g. AWS CLI profile).
// Region defaults to eu-west-1, override with AWS_REGION.
//
// Why we don't go through Cognito self-signup:
//   AdminCreateUser is idempotent and instant, doesn't send emails, and lets
//   us set a permanent password so the user can sign in immediately. The
//   downside is that the PostConfirmation Lambda doesn't fire for AdminCreate,
//   so the script writes the USER#<sub>/PROFILE row itself, mirroring what
//   auth-post-confirmation/handler.js does on real signup.

import { randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";

// ---------- Config ----------

const STACK_NAME = process.env.STACK_NAME || "UniConsultationsStack";
const REGION = process.env.AWS_REGION || "eu-west-1";

const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const WITH_DATA = args.has("--with-data");

const SEED_PASSWORD = process.env.SEED_PASSWORD || "Test1234!";

// Tag every seeded item with this so cleanup can target ONLY us, not real
// users that registered through the UI.
const SEED_TAG = "seed-fixture-v1";

// ---------- Fixture data ----------

const PROFESSORS = [
  {
    email: "ana.petrovic@example.edu",
    displayName: "Ana Petrović",
    department: "Software Engineering",
    subjects: ["Software Engineering", "Web Programming"],
    maxMentees: 5,
  },
  {
    email: "marko.jovanovic@example.edu",
    displayName: "Marko Jovanović",
    department: "Computer Science",
    subjects: ["Distributed Systems", "Operating Systems"],
    maxMentees: 3,
  },
  {
    email: "ivana.nikolic@example.edu",
    displayName: "Ivana Nikolić",
    department: "Information Systems",
    subjects: ["Databases", "Data Modeling"],
    maxMentees: 4,
  },
];

const STUDENTS = [
  { email: "luka.simic@example.edu", displayName: "Luka Simić" },
  { email: "milica.djordjevic@example.edu", displayName: "Milica Đorđević" },
  { email: "stefan.popovic@example.edu", displayName: "Stefan Popović" },
  { email: "jovana.markovic@example.edu", displayName: "Jovana Marković" },
  { email: "filip.ilic@example.edu", displayName: "Filip Ilić" },
];

// Admins are seeded only when --with-data is passed (or via the explicit
// fresh path). They get the same Cognito user shape as the others, just
// with custom:role = "admin" so the analytics admin endpoint accepts them.
const ADMINS = [
  { email: "admin@example.edu", displayName: "Admin Office" },
];

// Free-form notes used as the consultation `topic` for general bookings.
// Picked to roughly match the professor subjects above so analytics's
// "by topic" grouping clusters into recognisable themes.
const STUDENT_NOTES = [
  "Final project feedback",
  "SQL joins and indexes",
  "REST API design",
  "Distributed consensus algorithms",
  "Code review for assignment",
  "Clarification on lecture notes",
  "Architecture review",
  "Scaling patterns",
];

// Slot blueprint applied to every professor on every seeded date. Each
// entry pins one (time, consultationType, capacity) tuple. The schema
// mirrors what `manage-slots/handler.js` writes:
//   - `consultationType`     general | exam_prep | thesis
//   - `subject`              required for exam_prep — stamped from the
//                            professor's first subject
//   - `maxParticipants`      1 for thesis (server enforces this), 1 for
//                            solo, >1 for group-friendly slots that
//                            support topic-match joining
//   - `durationMinutes`      30 (matches the legacy fallback in
//                            consultations.js / manage-slots.js)
// Mixing types per day gives every analytics chart non-trivial buckets.
const SLOT_TEMPLATES = [
  { time: "09:00", type: "general",   max: 1, hasSubject: false },
  { time: "09:30", type: "general",   max: 3, hasSubject: false },
  { time: "10:00", type: "exam_prep", max: 3, hasSubject: true  },
  { time: "10:30", type: "thesis",    max: 1, hasSubject: false },
  { time: "11:00", type: "general",   max: 1, hasSubject: false },
];

// Thesis mentorship fixtures. One row per status branch the chat /
// thesis flow has to handle: accepted, pending, declined. The seeder
// pairs `accepted` and `pending` with a real thesis consultation row
// so the booking-side data is self-consistent (slot is full, mentee
// row references a slot that actually exists). Declined rows have no
// matching consultation — the student withdrew before a session.
const MENTORSHIPS = [
  {
    studentIdx: 2, // Stefan Popović
    professorIdx: 0, // Ana Petrović
    status: "accepted",
    theme:
      "Optimizing CI build pipelines for a monorepo web app: caching, " +
      "incremental builds, and dependency-graph-aware test selection.",
    attempt: 1,
    initialDaysAgo: 14, // initial consultation already happened
    decidedDaysAgo: 10, // professor accepted shortly after
  },
  {
    studentIdx: 0, // Luka Simić
    professorIdx: 1, // Marko Jovanović
    status: "pending",
    theme:
      "Lock-free data structures for distributed key-value stores under " +
      "high write contention.",
    attempt: 1,
    initialDaysAhead: 5, // initial consultation upcoming
  },
  {
    studentIdx: 1, // Milica Đorđević
    professorIdx: 2, // Ivana Nikolić
    status: "declined",
    theme:
      "Schema evolution strategies in document databases without downtime.",
    attempt: 1,
    declineReason: "Outside my current research focus, sorry!",
    decidedDaysAgo: 2,
  },
];

// ---------- Helpers ----------

const cfnClient = new CloudFormationClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

function log(scope, msg, extra) {
  const tail = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[${scope}] ${msg}${tail}`);
}

async function loadStackOutputs() {
  const r = await cfnClient.send(
    new DescribeStacksCommand({ StackName: STACK_NAME })
  );
  const outputs = r.Stacks?.[0]?.Outputs || [];
  const map = Object.fromEntries(
    outputs.map((o) => [o.OutputKey, o.OutputValue])
  );
  const userPoolId = map.UserPoolId;
  const tableName = map.TableName;
  if (!userPoolId || !tableName) {
    throw new Error(
      `Could not find UserPoolId / TableName in stack ${STACK_NAME}. ` +
        `Got: ${Object.keys(map).join(", ")}`
    );
  }
  return { userPoolId, tableName };
}

async function getCognitoSub(userPoolId, email) {
  try {
    const r = await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email })
    );
    const subAttr = (r.UserAttributes || []).find((a) => a.Name === "sub");
    return subAttr?.Value || null;
  } catch (e) {
    if (e instanceof UserNotFoundException) return null;
    throw e;
  }
}

async function ensureCognitoUser(userPoolId, { email, displayName, role }) {
  const existingSub = await getCognitoSub(userPoolId, email);
  if (existingSub) {
    log("cognito", "user already exists, reusing", { email, sub: existingSub });
    return existingSub;
  }

  const created = await cognitoClient.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      // SUPPRESS = don't send the "you've been invited" email. We set a
      // permanent password right after so the user can sign in immediately.
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:role", Value: role },
        { Name: "custom:displayName", Value: displayName },
      ],
    })
  );

  await cognitoClient.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: SEED_PASSWORD,
      Permanent: true,
    })
  );

  const subAttr = (created.User?.Attributes || []).find((a) => a.Name === "sub");
  const sub = subAttr?.Value;
  if (!sub) throw new Error(`Cognito did not return a sub for ${email}`);
  log("cognito", "user created", { email, sub });
  return sub;
}

async function writeProfile(tableName, fixture) {
  const { sub, email, displayName, role, department, subjects, maxMentees } =
    fixture;
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `USER#${sub}`,
        SK: "PROFILE",
        GSI1PK: `ROLE#${role}`,
        GSI1SK: `USER#${sub}`,
        userId: sub,
        email,
        displayName,
        role,
        department: role === "professor" ? department || "" : undefined,
        subjects:
          role === "professor" && Array.isArray(subjects) && subjects.length
            ? subjects
            : undefined,
        // Default thesis-mentee capacity for seeded professors. Lets demo
        // accounts appear in the student-side thesis picker without an
        // extra "configure capacity" step.
        maxMentees:
          role === "professor" && Number.isInteger(maxMentees)
            ? maxMentees
            : undefined,
        seedTag: SEED_TAG,
        createdAt: new Date().toISOString(),
      },
    })
  );
  log("ddb", "profile written", { email, role });
}

// ---------- Slot + consultation seeding ----------

function isoDate(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function buildSlotsForProfessor(professorRecord) {
  // Spread slots across BOTH past and future dates so the analytics
  // dashboard has line-chart points on either side of "today" — 14 days
  // back, 14 days forward. Each day gets the full SLOT_TEMPLATES rotation
  // so every consultationType (general / exam_prep / thesis) and every
  // capacity flavour (solo / group) appears every day.
  const { sub: professorId, fixture } = professorRecord;
  const examSubject = (fixture.subjects && fixture.subjects[0]) || "";

  const items = [];
  for (let offset = -14; offset <= 14; offset++) {
    if (offset === 0) continue;
    const date = isoDate(offset);
    for (const tpl of SLOT_TEMPLATES) {
      items.push({
        PK: `PROFESSOR#${professorId}`,
        SK: `SLOT#${date}T${tpl.time}`,
        GSI1PK: "SLOT_STATUS#available",
        GSI1SK: `PROFESSOR#${professorId}#DATE#${date}T${tpl.time}`,
        professorId,
        date,
        time: tpl.time,
        status: "available",
        maxParticipants: tpl.max,
        currentParticipants: 0,
        // Matches the runtime fallback in manage-slots.js / consultations.js;
        // the merged-block UI and overlap guard both key off this field.
        durationMinutes: 30,
        consultationType: tpl.type,
        // Subject is mandatory on exam_prep slots and ignored elsewhere —
        // mirror the validation in createSlots so seeded data behaves the
        // same as anything published through the UI.
        subject: tpl.hasSubject ? examSubject : undefined,
        seedTag: SEED_TAG,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return items;
}

async function batchPut(tableName, items) {
  // BatchWrite max 25 items per request.
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    );
  }
}

async function seedSlots(tableName, professorRecords) {
  let total = 0;
  for (const rec of professorRecords) {
    const items = buildSlotsForProfessor(rec);
    await batchPut(tableName, items);
    total += items.length;
  }
  log("slots", "seeded", { count: total });
}

// Seed a couple of class-schedule entries (NOT consultations) per professor,
// so the new "Classes" section in the availability page has data to show.
async function seedClasses(tableName, professorRecords) {
  let total = 0;
  for (const { sub, fixture } of professorRecords) {
    // Two upcoming class sessions per professor: one tomorrow, one in 3 days.
    const offsets = [1, 3];
    const subject = fixture.subjects?.[0] || fixture.department || "Class";
    for (let i = 0; i < offsets.length; i++) {
      const classId = randomUUID();
      const date = isoDate(offsets[i]);
      const startTime = i === 0 ? "12:00" : "14:00";
      const endTime = i === 0 ? "13:30" : "15:30";
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `PROFESSOR#${sub}`,
            SK: `CLASS#${classId}`,
            professorId: sub,
            classId,
            subject,
            date,
            startTime,
            endTime,
            room: i === 0 ? "Hall A2" : "Lab 304",
            seedTag: SEED_TAG,
            createdAt: new Date().toISOString(),
          },
        })
      );
      total += 1;
    }
  }
  log("classes", "seeded", { count: total });
}

// Mark a single emergency-unavailable day on the first professor (5 days out)
// to demo how recurring slot generation skips it.
async function seedUnavailable(tableName, professorRecords) {
  if (professorRecords.length === 0) return;
  const { sub } = professorRecords[0];
  const date = isoDate(5);
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        PK: `PROFESSOR#${sub}`,
        SK: `UNAVAILABLE#${date}`,
        professorId: sub,
        date,
        reason: "Faculty meeting",
        seedTag: SEED_TAG,
        createdAt: new Date().toISOString(),
      },
    })
  );
  log("unavailable", "seeded", { count: 1, date });
}

// Generate a varied set of bookings spread across the whole slot window
// seeded above. We deliberately mix:
//   - solo bookings (one student per slot)
//   - group bookings (two students sharing the same group-friendly slot)
//   - cancellations (student- AND professor-initiated, with reasons,
//     so the cancelled-bookings KPI and the cancellation breakdown
//     chart both have data)
//   - past bookings carrying studentFeedback / professorFeedback so the
//     analytics rating + attendance widgets aren't blank
// across past + future dates so every chart on the analytics dashboard
// renders something interesting after a single `npm run seed:fresh`.
//
// Thesis slots are intentionally excluded from this random pool: they're
// 1-on-1, require a `thesisStage` snapshot on the consultation row, and
// only make sense alongside a matching mentorship row. seedMentorships
// owns those bookings end-to-end.
async function seedSampleBookings(tableName, professorRecords, studentRecords) {
  if (professorRecords.length === 0 || studentRecords.length === 0) return;

  // Pull every slot we just wrote so we know which combinations are valid.
  const allSlots = [];
  for (const { sub } of professorRecords) {
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROFESSOR#${sub}`,
          ":prefix": "SLOT#",
        },
      })
    );
    for (const item of out.Items || []) allSlots.push(item);
  }

  if (allSlots.length === 0) return;

  // Deterministic-ish picks so re-runs produce comparable charts. The seed
  // value is fixed (5) and we walk the slot list in stride.
  const random = mulberry32(5);
  const bookablePool = allSlots.filter(
    (s) => s.consultationType !== "thesis"
  );
  const pickSlot = () => bookablePool[Math.floor(random() * bookablePool.length)];
  const pickStudent = () =>
    studentRecords[Math.floor(random() * studentRecords.length)];
  const pickNote = () =>
    STUDENT_NOTES[Math.floor(random() * STUDENT_NOTES.length)];

  // Track per-slot occupancy so we don't over-book a 1-on-1 slot or push a
  // group slot past its maxParticipants.
  const slotState = new Map();
  for (const s of allSlots) {
    slotState.set(`${s.professorId}::${s.SK}`, {
      slot: s,
      currentParticipants: 0,
      maxParticipants: s.maxParticipants || 1,
      bookings: [],
    });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const bookingsToWrite = [];
  const TOTAL = 32;
  const CANCEL_RATE = 0.18;

  let attempts = 0;
  while (bookingsToWrite.length < TOTAL && attempts < TOTAL * 5) {
    attempts += 1;
    const slot = pickSlot();
    if (!slot) break;
    const key = `${slot.professorId}::${slot.SK}`;
    const state = slotState.get(key);
    if (!state) continue;
    if (state.currentParticipants >= state.maxParticipants) continue;

    const student = pickStudent();
    if (state.bookings.some((b) => b.studentId === student.sub)) continue;

    const willCancel = random() < CANCEL_RATE;
    const isGroupCandidate = state.maxParticipants > 1;
    state.currentParticipants += 1;
    state.bookings.push({
      studentId: student.sub,
      cancelled: willCancel,
    });

    bookingsToWrite.push({
      slot,
      state,
      student,
      willCancel,
      isGroupCandidate,
    });
  }

  let createdCount = 0;
  let cancelledCount = 0;

  for (const { slot, state, student, willCancel, isGroupCandidate } of bookingsToWrite) {
    const consultationId = randomUUID();
    const date = slot.date;
    const time = slot.time;
    const isPast = date < todayIso;

    // Topic conventions match the runtime:
    //   - exam_prep slots inherit their topic from the slot's `subject`
    //     (the chat system prompt's auto-derive rule + bookSlotCore's
    //     subjectSnapshot logic both end up with the same string).
    //   - everything else picks a free-form note from STUDENT_NOTES.
    const note =
      slot.consultationType === "exam_prep"
        ? slot.subject || pickNote()
        : pickNote();

    // A slot is treated as a group session when its capacity is > 1 AND
    // more than one student ended up booked into it (mirrors the runtime
    // join_group_session logic).
    const finalGroup =
      isGroupCandidate && state.bookings.filter((b) => !b.cancelled).length > 1;

    // Cancellation attribution + lead-time bucketing. Mirrors the fields
    // cancelConsultation stamps onto cancelled rows so the analytics
    // breakdown ("by reason / by lead time / by who cancelled") and the
    // cancelled-tombstone UI both work.
    let cancellationFields = {};
    if (willCancel) {
      const cancelledBy = random() < 0.7 ? "student" : "professor";
      // Cancel between 5 minutes and 4 days before the (random) "now".
      const cancelledAtMs =
        Date.now() - Math.floor(5 * 60_000 + random() * 4 * 86_400_000);
      const slotInstant = new Date(`${date}T${time}:00Z`).getTime();
      const leadH =
        Math.round(((slotInstant - cancelledAtMs) / 3_600_000) * 100) / 100;
      const reasons = [
        "Schedule clash with a lecture",
        "Got sick — let's reschedule",
        "Already resolved the question over email",
        "Family emergency",
        "",
      ];
      const reason = reasons[Math.floor(random() * reasons.length)];
      cancellationFields = {
        cancelledBy,
        cancelledAt: new Date(cancelledAtMs).toISOString(),
        cancellationLeadHours: leadH,
        ...(reason ? { cancellationReason: reason } : {}),
      };
    }

    // Past, non-cancelled bookings get sample feedback. Submit rates are
    // intentionally <1 so the analytics "n responses" footer isn't a flat
    // line — ~70% student, ~60% professor — and ratings skew positive
    // (3..5) so the average looks plausible without being pinned to 5.
    let feedbackFields = {};
    if (isPast && !willCancel) {
      if (random() < 0.7) {
        const rating = 3 + Math.floor(random() * 3); // 3, 4, or 5
        const comments = [
          "Really helpful — clarified the bits I was missing.",
          "Thanks, I think I can move forward now.",
          "Good session, would book again.",
          "Helpful but felt a bit rushed.",
          "",
        ];
        const comment = comments[Math.floor(random() * comments.length)];
        feedbackFields.studentFeedback = {
          rating,
          ...(comment ? { comment } : {}),
          submittedAt: new Date().toISOString(),
        };
      }
      if (random() < 0.6) {
        const r = random();
        // Most past sessions land "yes"; sprinkle in a few late + no-show
        // so the no-show KPI isn't always 0%.
        const attended = r < 0.85 ? "yes" : r < 0.95 ? "late" : "no";
        feedbackFields.professorFeedback = {
          attended,
          submittedAt: new Date().toISOString(),
        };
      }
    }

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `CONSULTATION#${consultationId}`,
          SK: "METADATA",
          GSI1PK: `PROFESSOR#${slot.professorId}`,
          GSI1SK: `DATE#${date}T${time}`,
          GSI2PK: `STUDENT#${student.sub}`,
          GSI2SK: `DATE#${date}T${time}`,
          consultationId,
          studentId: student.sub,
          professorId: slot.professorId,
          slotSK: slot.SK,
          date,
          time,
          topic: note,
          note,
          // Snapshot the slot's type + subject onto the row, matching
          // bookSlotCore. Without these the analytics "by type" and
          // "by subject" charts can't bucket seeded rows correctly.
          consultationType: slot.consultationType || "general",
          subject: slot.subject || undefined,
          status: willCancel ? "cancelled" : "booked",
          isGroupSession: finalGroup && !willCancel,
          ...cancellationFields,
          ...feedbackFields,
          seedTag: SEED_TAG,
          createdAt: new Date().toISOString(),
        },
      })
    );

    if (willCancel) cancelledCount += 1;
    else createdCount += 1;
  }

  // Refresh each slot's status / counters so the Availability page and the
  // analytics occupancy KPI agree on what's full vs available. We rewrite
  // the entire row (spread of `state.slot`) so the consultationType /
  // subject / durationMinutes fields written by buildSlotsForProfessor
  // are preserved verbatim.
  for (const [, state] of slotState) {
    if (state.bookings.length === 0) continue;
    const activeCount = state.bookings.filter((b) => !b.cancelled).length;
    const status = activeCount >= state.maxParticipants ? "full" : "available";
    const isGroup = state.maxParticipants > 1 && activeCount > 1;

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...state.slot,
          status,
          currentParticipants: activeCount,
          isGroupSession: isGroup,
          GSI1PK: `SLOT_STATUS#${status}`,
          GSI1SK: `PROFESSOR#${state.slot.professorId}#DATE#${state.slot.date}T${state.slot.time}`,
          seedTag: SEED_TAG,
        },
      })
    );
  }

  log("bookings", "seeded", {
    booked: createdCount,
    cancelled: cancelledCount,
    slotsTouched: [...slotState.values()].filter((s) => s.bookings.length > 0).length,
  });
}

// ---------- Mentorship seeding ----------
//
// Writes one MENTEE row per entry in MENTORSHIPS, plus the matching
// thesis consultation row (and slot-state flip) for accepted / pending
// mentorships. Schema mirrors the runtime exactly (see mentorship.js):
//
//   PK: PROFESSOR#{professorId}    SK: MENTEE#{studentId}#{attempt}
//   GSI2PK: STUDENT#{studentId}    GSI2SK: MENTOR#{professorId}#{attempt}
//
// The accepted branch piggybacks past student + professor feedback on
// the initial consultation so the thesis-flow demo data is consistent
// with what the rating widget would show after a real session.
async function seedMentorships(tableName, professorRecords, studentRecords) {
  if (professorRecords.length === 0 || studentRecords.length === 0) return;
  const todayIso = new Date().toISOString().slice(0, 10);
  let mentorshipCount = 0;
  let thesisConsultations = 0;

  for (const m of MENTORSHIPS) {
    const prof = professorRecords[m.professorIdx];
    const stud = studentRecords[m.studentIdx];
    if (!prof || !stud) continue;

    const attemptStr = String(m.attempt).padStart(3, "0");

    // Pick a `proposedAt` that's older than the deciding event so the
    // chat / thesis status panel renders a sensible "proposed → decided"
    // timeline.
    const proposedDaysAgo =
      m.initialDaysAhead != null
        ? 1
        : m.initialDaysAgo != null
          ? m.initialDaysAgo + 2
          : (m.decidedDaysAgo ?? 0) + 2;
    const proposedAtDate = new Date();
    proposedAtDate.setUTCDate(proposedAtDate.getUTCDate() - proposedDaysAgo);
    const proposedAt = proposedAtDate.toISOString();

    let decidedAt = null;
    if (m.status === "accepted" || m.status === "declined") {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (m.decidedDaysAgo ?? 1));
      decidedAt = d.toISOString();
    }

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `PROFESSOR#${prof.sub}`,
          SK: `MENTEE#${stud.sub}#${attemptStr}`,
          GSI2PK: `STUDENT#${stud.sub}`,
          GSI2SK: `MENTOR#${prof.sub}#${attemptStr}`,
          studentId: stud.sub,
          professorId: prof.sub,
          attempt: m.attempt,
          status: m.status,
          thesisTheme: m.theme,
          proposedAt,
          ...(decidedAt ? { decidedAt } : {}),
          ...(m.declineReason ? { declineReason: m.declineReason } : {}),
          seedTag: SEED_TAG,
        },
      })
    );
    mentorshipCount += 1;

    // Declined attempts have no consultation — the student withdrew (or
    // the professor declined) before any session occurred.
    if (m.status === "declined") continue;

    // Pair the mentorship with the thesis slot at HH:MM = 10:30 (per
    // SLOT_TEMPLATES) on the relevant date. Pulling the existing slot
    // row first keeps any seed-timestamp / GSI fields stable.
    const offset =
      m.initialDaysAhead != null ? m.initialDaysAhead : -m.initialDaysAgo;
    const date = isoDate(offset);
    const slotSK = `SLOT#${date}T10:30`;

    const slotResp = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": `PROFESSOR#${prof.sub}`,
          ":sk": slotSK,
        },
      })
    );
    const slot = (slotResp.Items || [])[0];
    if (!slot) continue;

    // Thesis slots are 1-on-1 — claiming the seat fills them.
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...slot,
          status: "full",
          currentParticipants: 1,
          GSI1PK: "SLOT_STATUS#full",
          seedTag: SEED_TAG,
        },
      })
    );

    const consultationId = randomUUID();
    const isPast = date < todayIso;
    const feedbackFields =
      m.status === "accepted" && isPast
        ? {
            studentFeedback: {
              rating: 5,
              comment:
                "Great kickoff session — really excited to work on this together.",
              submittedAt: new Date().toISOString(),
            },
            professorFeedback: {
              attended: "yes",
              submittedAt: new Date().toISOString(),
            },
          }
        : {};

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `CONSULTATION#${consultationId}`,
          SK: "METADATA",
          GSI1PK: `PROFESSOR#${prof.sub}`,
          GSI1SK: `DATE#${date}T${slot.time}`,
          GSI2PK: `STUDENT#${stud.sub}`,
          GSI2SK: `DATE#${date}T${slot.time}`,
          consultationId,
          studentId: stud.sub,
          professorId: prof.sub,
          slotSK,
          date,
          time: slot.time,
          // Same shape bookSlotCore writes for a thesis booking: topic
          // is the canned "Thesis proposal" string, note carries the
          // student's theme, and the row snapshots thesisStage +
          // thesisTheme so the chat / status surfaces don't have to
          // re-look-up the mentorship row.
          topic: "Thesis proposal",
          note: m.theme,
          consultationType: "thesis",
          thesisStage: "initial",
          thesisTheme: m.theme,
          status: "booked",
          isGroupSession: false,
          ...feedbackFields,
          seedTag: SEED_TAG,
          createdAt: proposedAt,
        },
      })
    );
    thesisConsultations += 1;
  }
  log("mentorships", "seeded", { mentorshipCount, thesisConsultations });
}

// Tiny seedable PRNG so re-running the script yields stable bookings.
// Picked over Math.random() so tests / demos see comparable numbers.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Reset path ----------

async function deleteSeedRows(tableName) {
  // Walk USER profiles by GSI1 (ROLE#student / ROLE#professor) and slots /
  // consultations by their primary keys. We only delete rows tagged with
  // SEED_TAG so a real production user that happens to share an email
  // domain can never be wiped out.
  const toDelete = [];

  async function scanAndCollectByGsi1(gsi1pk) {
    let ExclusiveStartKey;
    do {
      const out = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": gsi1pk },
          ExclusiveStartKey,
        })
      );
      for (const item of out.Items || []) {
        if (item.seedTag === SEED_TAG) {
          toDelete.push({ PK: item.PK, SK: item.SK });
        }
      }
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  await scanAndCollectByGsi1("ROLE#professor");
  await scanAndCollectByGsi1("ROLE#student");
  await scanAndCollectByGsi1("ROLE#admin");

  // Slots + consultations live under PROFESSOR#... / CONSULTATION#... PKs.
  // We collect those by looking at each professor profile we just found and
  // querying their slots, plus following each booking's consultation row.
  const profProfiles = toDelete
    .filter((k) => k.SK === "PROFILE" && k.PK.startsWith("USER#"))
    .map((k) => k.PK.replace(/^USER#/, ""));

  for (const professorId of profProfiles) {
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `PROFESSOR#${professorId}` },
      })
    );
    for (const item of out.Items || []) {
      if (item.seedTag === SEED_TAG) {
        toDelete.push({ PK: item.PK, SK: item.SK });
      }
    }
  }

  // Consultations are linked from professor GSI1 = PROFESSOR#<id>; query each.
  for (const professorId of profProfiles) {
    const out = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `PROFESSOR#${professorId}` },
      })
    );
    for (const item of out.Items || []) {
      if (item.seedTag === SEED_TAG) {
        toDelete.push({ PK: item.PK, SK: item.SK });
      }
    }
  }

  // Dedupe (a slot or profile may have been picked up twice).
  const seen = new Set();
  const unique = toDelete.filter((k) => {
    const id = `${k.PK}::${k.SK}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  for (const key of unique) {
    await ddb.send(
      new DeleteCommand({ TableName: tableName, Key: key })
    );
  }
  log("ddb", "seed rows deleted", { count: unique.length });
}

async function deleteCognitoUser(userPoolId, email) {
  try {
    await cognitoClient.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email })
    );
    log("cognito", "user deleted", { email });
  } catch (e) {
    if (e instanceof UserNotFoundException) return;
    throw e;
  }
}

async function resetCognito(userPoolId) {
  for (const fixture of [...PROFESSORS, ...STUDENTS, ...ADMINS]) {
    await deleteCognitoUser(userPoolId, fixture.email);
  }
}

// ---------- Main ----------

async function main() {
  log("init", "loading stack outputs", { stack: STACK_NAME, region: REGION });
  const { userPoolId, tableName } = await loadStackOutputs();
  log("init", "ready", { userPoolId, tableName });

  if (RESET) {
    log("reset", "removing previously seeded users + rows");
    await resetCognito(userPoolId);
    await deleteSeedRows(tableName);
  }

  const professorRecords = [];
  for (const fixture of PROFESSORS) {
    const sub = await ensureCognitoUser(userPoolId, {
      ...fixture,
      role: "professor",
    });
    await writeProfile(tableName, { ...fixture, sub, role: "professor" });
    professorRecords.push({ sub, fixture });
  }

  const studentRecords = [];
  for (const fixture of STUDENTS) {
    const sub = await ensureCognitoUser(userPoolId, {
      ...fixture,
      role: "student",
    });
    await writeProfile(tableName, { ...fixture, sub, role: "student" });
    studentRecords.push({ sub, fixture });
  }

  // Admins are created on every seed run (cheap — just one user) so
  // `npm run seed` is enough to set up the analytics admin endpoint.
  for (const fixture of ADMINS) {
    const sub = await ensureCognitoUser(userPoolId, {
      ...fixture,
      role: "admin",
    });
    await writeProfile(tableName, { ...fixture, sub, role: "admin" });
  }

  if (WITH_DATA) {
    await seedSlots(tableName, professorRecords);
    await seedClasses(tableName, professorRecords);
    await seedUnavailable(tableName, professorRecords);
    // Diverse bookings (booked + cancelled, solo + group, past + future)
    // so the analytics dashboard has data for every chart out of the box.
    await seedSampleBookings(tableName, professorRecords, studentRecords);
    // Thesis mentorships (one per status: accepted / pending / declined)
    // along with their initial consultations + slot-state flips so the
    // chat thesis flow has every branch represented.
    await seedMentorships(tableName, professorRecords, studentRecords);
  }

  console.log("\nDone. Sign in with any seeded user:");
  for (const fx of [...PROFESSORS, ...STUDENTS, ...ADMINS]) {
    console.log(`  ${fx.email.padEnd(36)}  ${SEED_PASSWORD}`);
  }
}

main().catch((e) => {
  console.error("\nSeed failed:", e);
  process.exit(1);
});
