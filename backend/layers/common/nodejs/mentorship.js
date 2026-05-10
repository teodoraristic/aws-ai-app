"use strict";

// ── Thesis mentorship ────────────────────────────────────────────
//
// A `MENTEE` row links one student to one professor for the lifecycle of
// a thesis: proposed → pending → accepted | declined. Declined attempts
// are kept as history. A new proposal to the same professor (after a
// decline) bumps `attempt`, so the SK is `MENTEE#{studentId}#{attempt}`
// — letting us keep multiple chronological rows under the same student.
//
// Schema:
//
//   PK: PROFESSOR#{professorId}    SK: MENTEE#{studentId}#{attempt}
//   GSI2PK: STUDENT#{studentId}    GSI2SK: MENTOR#{professorId}#{attempt}
//
//   fields: studentId, professorId, attempt,
//           status (pending|accepted|declined),
//           thesisTheme,
//           initialConsultationId,
//           proposedAt, decidedAt?, declineReason?
//
// Why two indexes:
//   - PK lets the professor list "all my mentees" cheaply (queryPk).
//   - GSI2 lets the student list "my mentorship history" cheaply, and
//     more importantly enforces the global "one active mentor at a
//     time" rule by querying STUDENT#... across the whole faculty.

const { queryPk, queryGsi2 } = require("./db");

function mentorshipSk(studentId, attempt) {
  return `MENTEE#${studentId}#${String(attempt).padStart(3, "0")}`;
}

function mentorshipGsi2Sk(professorId, attempt) {
  return `MENTOR#${professorId}#${String(attempt).padStart(3, "0")}`;
}

// Find the highest-attempt mentorship row across the faculty for this
// student. Returns null when the student has never proposed. The "current"
// mentorship — the one whose status drives the booking branch — is always
// the one with the largest (chronologically newest) attempt across all
// professors. When two professors received proposals at separate times,
// only the most recent matters; older ones are history.
async function getCurrentMentorshipForStudent(studentId) {
  if (!studentId) return null;
  const rows = await queryGsi2(`STUDENT#${studentId}`, "MENTOR#");
  if (!rows.length) return null;
  rows.sort((a, b) => (a.proposedAt || "") < (b.proposedAt || "") ? 1 : -1);
  return rows[0];
}

// Get the latest mentorship row this student has WITH a specific professor,
// regardless of status. Used to compute the next attempt number.
async function getLatestMentorshipWithProfessor(studentId, professorId) {
  if (!studentId || !professorId) return null;
  const rows = await queryGsi2(
    `STUDENT#${studentId}`,
    `MENTOR#${professorId}#`
  );
  if (!rows.length) return null;
  rows.sort((a, b) => (a.attempt || 0) - (b.attempt || 0));
  return rows[rows.length - 1];
}

// All mentees for a professor, regardless of status. The page / chat tool
// can group them by status client-side.
async function listMenteesForProfessor(professorId) {
  if (!professorId) return [];
  const rows = await queryPk(`PROFESSOR#${professorId}`, "MENTEE#");
  rows.sort((a, b) => (a.proposedAt || "") < (b.proposedAt || "") ? 1 : -1);
  return rows;
}

// How many ACCEPTED mentees this professor currently has — used to
// compare against `maxMentees` so the booking flow can stop accepting
// proposals once the cap is reached and the student-side picker can
// hide professors who are full.
async function countAcceptedMenteesForProfessor(professorId) {
  if (!professorId) return 0;
  const rows = await queryPk(`PROFESSOR#${professorId}`, "MENTEE#");
  let count = 0;
  for (const r of rows) {
    if (r.status === "accepted") count += 1;
  }
  return count;
}

// All mentorship rows for a student across the whole faculty, history
// included. Sorted newest-first.
async function listMentorshipsForStudent(studentId) {
  if (!studentId) return [];
  const rows = await queryGsi2(`STUDENT#${studentId}`, "MENTOR#");
  rows.sort((a, b) => (a.proposedAt || "") < (b.proposedAt || "") ? 1 : -1);
  return rows;
}

module.exports = {
  mentorshipSk,
  mentorshipGsi2Sk,
  getCurrentMentorshipForStudent,
  getLatestMentorshipWithProfessor,
  listMenteesForProfessor,
  listMentorshipsForStudent,
  countAcceptedMenteesForProfessor,
};
