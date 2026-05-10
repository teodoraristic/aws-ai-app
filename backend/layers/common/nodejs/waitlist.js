"use strict";

// ── Waitlist (notify-only) ───────────────────────────────────────
//
// When a slot fills up, students can register their interest on a
// per-slot waitlist. Cancellations and day-wipes pop the longest-waiting
// row off the front of the queue and emit a `seat_opened` notification —
// the student then has to manually book the freshly-available seat
// through the regular booking flow. We deliberately do NOT auto-promote:
//   - it would race the booking core's duplicate-booking and slot-full
//     guards in subtle ways,
//   - and the user-facing UX is more honest ("seat opened, want it?")
//     than silently inserting them into a session they may no longer
//     need.
//
// Schema (one row per (professor, slot, student) tuple):
//
//   PK: PROFESSOR#{professorId}    SK: WAITLIST#{slotSK}#{studentId}
//   GSI2PK: STUDENT#{studentId}    GSI2SK: WAITLIST#{slotSK}
//
//   fields: studentId, professorId, slotSK, joinedAt, topic, note?
//
// Same single-table tenancy as the rest of the app: queries by professor
// hit the primary key, queries by student hit GSI2.

const {
  getItem,
  putItem,
  deleteItem,
  queryPk,
  queryGsi2,
} = require("./db");

const WAITLIST_NOTE_MAX = 240;
const WAITLIST_TOPIC_MAX = 240;

function clean(input, max) {
  if (typeof input !== "string") return "";
  const trimmed = input.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Prefix a slotSK ("SLOT#…") with the WAITLIST namespace + the studentId.
// Keeps the resulting SK greppable and lets us begins_with on the
// per-slot prefix without an explicit length match.
function buildSk(slotSK, studentId) {
  return `WAITLIST#${slotSK}#${studentId}`;
}

function buildGsi2Sk(slotSK) {
  return `WAITLIST#${slotSK}`;
}

// Add the calling student to a slot's waitlist. Idempotent: if the row
// already exists, return the existing entry instead of bumping joinedAt
// — so the student never accidentally loses their queue position by
// re-clicking "Join waitlist".
async function joinWaitlist({ professorId, slotSK, studentId, topic, note }) {
  if (!professorId) return { error: "Missing professorId" };
  if (!slotSK || !slotSK.startsWith("SLOT#")) {
    return { error: "Invalid slotSK" };
  }
  if (!studentId) return { error: "Missing studentId" };

  const slot = await getItem(`PROFESSOR#${professorId}`, slotSK);
  if (!slot) return { error: "Slot not found" };

  // Past-slot guard mirrors the booking core's. No point queueing for
  // a session that's already started.
  const slotInstantUtc = (() => {
    if (!slot.date || !slot.time) return null;
    const [hh, mm] = String(slot.time).split(":").map(Number);
    const d = new Date(`${slot.date}T00:00:00Z`);
    d.setUTCHours(hh || 0, mm || 0, 0, 0);
    return d;
  })();
  if (
    !slotInstantUtc ||
    !Number.isFinite(slotInstantUtc.getTime()) ||
    slotInstantUtc.getTime() <= Date.now()
  ) {
    return { error: "This slot has already started." };
  }

  // Reject if the student already has an active booking on this slot.
  // The system prompt instructs the model not to offer the waitlist in this
  // case, but a server-side guard is necessary because the model can
  // misread a DUPLICATE_BOOKING error as a slot-full failure and then
  // offer — and call — join_waitlist anyway.
  const existingBookings = await queryGsi2(
    `STUDENT#${studentId}`,
    `DATE#${slot.date}T${slot.time}`
  );
  const alreadyBooked = existingBookings.some(
    (r) =>
      r.SK === "METADATA" &&
      r.professorId === professorId &&
      r.slotSK === slotSK &&
      r.status !== "cancelled"
  );
  if (alreadyBooked) {
    return {
      error:
        "You already have an active booking for this slot. " +
        "Tell the user they already have a reservation and do not need to join the waitlist.",
    };
  }

  const sk = buildSk(slotSK, studentId);
  const existing = await getItem(`PROFESSOR#${professorId}`, sk);
  if (existing) {
    return {
      ok: true,
      alreadyOnWaitlist: true,
      entry: shapeEntry(existing),
    };
  }

  const cleanTopic = clean(topic, WAITLIST_TOPIC_MAX);
  const cleanNote = clean(note, WAITLIST_NOTE_MAX);
  const joinedAt = new Date().toISOString();

  await putItem({
    PK: `PROFESSOR#${professorId}`,
    SK: sk,
    GSI2PK: `STUDENT#${studentId}`,
    GSI2SK: buildGsi2Sk(slotSK),
    studentId,
    professorId,
    slotSK,
    date: slot.date,
    time: slot.time,
    consultationType: slot.consultationType || "general",
    subject: slot.subject || "",
    topic: cleanTopic,
    note: cleanNote || undefined,
    joinedAt,
  });

  return {
    ok: true,
    alreadyOnWaitlist: false,
    entry: {
      slotSK,
      professorId,
      studentId,
      date: slot.date,
      time: slot.time,
      topic: cleanTopic,
      note: cleanNote || "",
      joinedAt,
      consultationType: slot.consultationType || "general",
      subject: slot.subject || "",
    },
  };
}

async function leaveWaitlist({ professorId, slotSK, studentId }) {
  if (!professorId || !slotSK || !studentId) {
    return { error: "Missing required fields" };
  }
  const sk = buildSk(slotSK, studentId);
  await deleteItem(`PROFESSOR#${professorId}`, sk);
  return { ok: true };
}

// List every waitlist entry the calling student is on, with enough slot
// info that the UI can render a row without re-fetching the slot.
async function listWaitlistForStudent(studentId) {
  if (!studentId) return [];
  const rows = await queryGsi2(`STUDENT#${studentId}`, "WAITLIST#");
  // Hydrate per-slot data lazily — only for slots that are still in the
  // future and still exist. Stale rows (slot deleted, slot in the past)
  // are filtered out and silently cleaned to keep the response tidy.
  const nowMs = Date.now();
  const out = [];
  for (const r of rows) {
    if (!r.slotSK || !r.professorId) continue;
    // Lazy cleanup — once the slot has started the student can no longer
    // act on a seat_opened notification, so drop the row silently.
    const slotInstant = (() => {
      if (!r.date) return null;
      const d = new Date(`${r.date}T${r.time || "00:00"}:00Z`);
      return Number.isFinite(d.getTime()) ? d : null;
    })();
    if (!slotInstant || slotInstant.getTime() <= nowMs) {
      deleteItem(r.PK, r.SK).catch(() => {});
      continue;
    }
    out.push(shapeEntry(r));
  }
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.time || "") < (b.time || "") ? -1 : 1;
  });
  return out;
}

// Find the longest-waiting student on a slot's waitlist. Used by the
// cancellation pathway to pick who gets the seat_opened notification.
// Returns null when no one is queued. Stale entries (slot deleted, past
// date) are filtered out and the next-eligible row is returned.
async function nextWaitlistedFor(professorId, slotSK) {
  if (!professorId || !slotSK) return null;
  const prefix = `WAITLIST#${slotSK}#`;
  const rows = await queryPk(`PROFESSOR#${professorId}`, prefix);
  if (rows.length === 0) return null;

  // joinedAt is an ISO string — direct lex compare gives chronological
  // ordering. Pick the smallest (oldest first) so the longest-waiting
  // student is notified.
  rows.sort((a, b) => (a.joinedAt || "") < (b.joinedAt || "") ? -1 : 1);
  for (const r of rows) {
    if (!r.joinedAt || !r.studentId) continue;
    return shapeEntry(r);
  }
  return null;
}

// Remove a single (slotSK, studentId) waitlist row. Called from
// bookSlotCore when a booking succeeds, so a student who finally booked
// the slot they were queued on doesn't keep getting "seat_opened" pings
// when a third student later cancels.
async function clearStudentFromWaitlist(professorId, slotSK, studentId) {
  if (!professorId || !slotSK || !studentId) return;
  const sk = buildSk(slotSK, studentId);
  await deleteItem(`PROFESSOR#${professorId}`, sk).catch(() => {});
}

function shapeEntry(row) {
  return {
    slotSK: row.slotSK,
    professorId: row.professorId,
    studentId: row.studentId,
    date: row.date,
    time: row.time,
    topic: row.topic || "",
    note: row.note || "",
    joinedAt: row.joinedAt,
    consultationType: row.consultationType || "general",
    subject: row.subject || "",
  };
}

module.exports = {
  joinWaitlist,
  leaveWaitlist,
  listWaitlistForStudent,
  nextWaitlistedFor,
  clearStudentFromWaitlist,
};
