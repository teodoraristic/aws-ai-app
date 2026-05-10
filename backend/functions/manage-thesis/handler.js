"use strict";

// ── Thesis mentorship REST surface ────────────────────────────────
//
// Routes:
//   POST   /thesis/proposal             (student) — propose a thesis
//   GET    /thesis/me                   (student) — current mentorship state
//   GET    /thesis/mentees              (professor) — pending + accepted + history
//   PATCH  /thesis/mentees/{studentId}  (professor) — accept / decline a pending row
//
// Booking + mentorship transactional invariants live in `bookSlotCore`
// (consultations.js); this handler is a thin REST shim over that and a
// few helper queries from the mentorship module.

const { getItem, queryPk, queryGsi2, updateItem } = require("/opt/nodejs/db");
const {
  bookSlotCore,
  getMyConsultations,
  createNotification,
  combineSlotInstantUtc,
  normalizeMaxMentees,
} = require("/opt/nodejs/consultations");
const {
  listMenteesForProfessor,
  listMentorshipsForStudent,
  countAcceptedMenteesForProfessor,
} = require("/opt/nodejs/mentorship");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

// A professor can mentor between 0 and this many thesis students at once.
// 50 is generous — real numbers are typically 5-15 — but the cap protects
// against fat-finger input on the slider.
const MAX_MENTEES_HARD_LIMIT = 50;

// POST /thesis/proposal
//
// Body: { professorId, slotSK, theme }
// Delegates to bookSlotCore with a thesisTheme — the booking core's
// thesis branch handles the state machine + transactional write.
async function postProposal(event, context, log, caller) {
  if (caller.role !== "student") {
    return unauthorized("Only students can propose a thesis.");
  }

  let body = {};
  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      log.warn("invalid_json", { message: e.message });
      return badRequest("invalid JSON body");
    }
  }

  const professorId = body && body.professorId;
  const slotSK = body && body.slotSK;
  const theme = (body && typeof body.theme === "string" ? body.theme : "").trim();
  if (!professorId || !slotSK) {
    return badRequest("professorId and slotSK are required");
  }
  if (!theme) {
    return badRequest("theme is required for a thesis proposal");
  }

  let result;
  try {
    result = await bookSlotCore({
      professorId,
      slotSK,
      studentId: caller.userId,
      note: theme,
      thesisTheme: theme,
      log,
    });
  } catch (e) {
    log.error(e, { stage: "bookSlotCore", professorId, slotSK });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result.error) {
    log.warn("proposal_rejected", { reason: result.error, professorId, slotSK });
    return badRequest(result.error);
  }

  // Best-effort notification to the professor that they have a new
  // proposal to decide on. Failure is silent — the mentorship row was
  // already written and the professor will see it in their /thesis tab.
  try {
    const studentProfile = await getItem(`USER#${caller.userId}`, "PROFILE");
    const studentLabel =
      (studentProfile && studentProfile.displayName) || "A student";
    await createNotification(professorId, {
      type: "thesis_proposal",
      message: `${studentLabel} proposed a thesis with you. Open the Thesis page to review and decide.`,
      consultationId: result.consultationId,
      slotSK,
      date: result.date,
      time: result.time,
    });
  } catch (_err) {
    /* noop */
  }

  log.end({ stage: "thesis_proposal", professorId });
  return ok(result);
}

// GET /thesis/me
//
// Returns the student's mentorship history (newest-first), the linked
// initial / upcoming / past thesis bookings, and — when no active
// mentorship exists — the list of professors who currently publish thesis
// slots (so the picker UI has something to show).
async function getMyThesis(event, context, log, caller) {
  if (caller.role !== "student") {
    return unauthorized("Only students have a thesis view.");
  }

  let mentorships;
  try {
    mentorships = await listMentorshipsForStudent(caller.userId);
  } catch (e) {
    log.error(e, { stage: "listMentorshipsForStudent" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  // Enrich each mentorship row with the professor's profile (display
  // name + department + email) so the UI can render rows directly.
  const profIds = [
    ...new Set(mentorships.map((m) => m.professorId).filter(Boolean)),
  ];
  const profiles = await Promise.all(
    profIds.map((id) => getItem(`USER#${id}`, "PROFILE").catch(() => null))
  );
  const byId = new Map();
  for (const p of profiles) {
    if (p && p.userId) byId.set(p.userId, p);
  }
  const enriched = mentorships.map((m) => {
    const prof = byId.get(m.professorId);
    return {
      ...m,
      professorName: prof ? prof.displayName : "",
      professorDepartment: prof ? prof.department || "" : "",
      professorEmail: prof ? prof.email : "",
    };
  });

  // Pull thesis-related consultations (initial + updates) so the page can
  // show the schedule next to each mentorship.
  let allConsultations = [];
  try {
    const upcoming = await getMyConsultations(caller.userId, "student", {
      range: "all",
    });
    allConsultations = (upcoming || []).filter(
      (c) => c.consultationType === "thesis"
    );
  } catch (e) {
    log.warn("thesis_consultations_failed", { message: e.message });
  }

  // The "current" mentorship is the newest row regardless of status —
  // accepted / pending / declined / none. UI uses this to pick the view.
  const current = enriched[0] || null;

  // When the student has no active mentorship, also surface the list of
  // professors currently publishing thesis slots so the picker UI on the
  // student view has something to render. A professor is shown only if:
  //   - they currently publish at least one available `thesis` slot, AND
  //   - their stated `maxMentees` is > 0, AND
  //   - their accepted-mentee count is below `maxMentees` (still has
  //     room to take another mentee on).
  // The third check matters even though the proposal goes through `pending`
  // first — a professor with 0 free seats won't be able to accept anyone
  // new, so showing them on the picker would just produce dead-end
  // proposals. The data is denormalized into the picker row so the UI
  // can also show "3/5 mentees" style hints.
  let thesisProfessors = [];
  if (!current || current.status === "declined") {
    try {
      const today = new Date().toISOString().split("T")[0];

      const profsRaw = await require("/opt/nodejs/consultations").listProfessors();
      const checks = await Promise.all(
        (profsRaw || []).map(async (p) => {
          const cap = normalizeMaxMentees(p.maxMentees);
          if (cap <= 0) return null;
          const [slots, acceptedCount] = await Promise.all([
            queryPk(`PROFESSOR#${p.professorId}`, "SLOT#").catch(() => []),
            countAcceptedMenteesForProfessor(p.professorId).catch(() => 0),
          ]);
          if (acceptedCount >= cap) return null;
          const hasOpen = slots.some(
            (s) =>
              s.consultationType === "thesis" &&
              s.status === "available" &&
              s.date >= today
          );
          if (!hasOpen) return null;
          return {
            ...p,
            acceptedMentees: acceptedCount,
            maxMentees: cap,
            menteesRemaining: Math.max(0, cap - acceptedCount),
          };
        })
      );
      thesisProfessors = checks.filter(Boolean).map((p) => ({
        professorId: p.professorId,
        name: p.name,
        department: p.department || "",
        email: p.email,
        subjects: p.subjects || [],
        maxMentees: p.maxMentees,
        acceptedMentees: p.acceptedMentees,
        menteesRemaining: p.menteesRemaining,
      }));
    } catch (e) {
      log.warn("thesis_professors_failed", { message: e.message });
    }
  }

  log.end({
    stage: "getMyThesis",
    mentorshipCount: enriched.length,
    consultationCount: allConsultations.length,
  });
  return ok({
    current,
    history: enriched,
    consultations: allConsultations,
    thesisProfessors,
  });
}

// GET /thesis/mentees
//
// Professor-facing list of every mentorship row pointing at them, with
// the linked student profile and (for pending rows) the initial
// consultation date so the UI can group them by tab.
async function getMyMentees(event, context, log, caller) {
  if (caller.role !== "professor") {
    return unauthorized("Only professors have a mentees view.");
  }

  let mentees;
  try {
    mentees = await listMenteesForProfessor(caller.userId);
  } catch (e) {
    log.error(e, { stage: "listMenteesForProfessor" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  const studentIds = [
    ...new Set(mentees.map((m) => m.studentId).filter(Boolean)),
  ];
  const profiles = await Promise.all(
    studentIds.map((id) => getItem(`USER#${id}`, "PROFILE").catch(() => null))
  );
  const byId = new Map();
  for (const p of profiles) {
    if (p && p.userId) byId.set(p.userId, p);
  }

  const enriched = mentees.map((m) => {
    const prof = byId.get(m.studentId);
    return {
      ...m,
      studentName: prof ? prof.displayName : "",
      studentEmail: prof ? prof.email : "",
    };
  });

  // Pull this professor's thesis consultations so the UI can show "next
  // initial consultation: …" inline on each pending row.
  let consultations = [];
  try {
    consultations = await getMyConsultations(caller.userId, "professor", {
      range: "all",
    });
    consultations = (consultations || []).filter(
      (c) => c.consultationType === "thesis"
    );
  } catch (e) {
    log.warn("mentee_consultations_failed", { message: e.message });
  }

  // Pull current mentee capacity from the professor's profile so the page
  // can show a "3 / 5 mentees" badge alongside the tab list.
  let capacity = { maxMentees: 0, acceptedMentees: 0 };
  try {
    const profile = await getItem(`USER#${caller.userId}`, "PROFILE");
    capacity.maxMentees = normalizeMaxMentees(profile?.maxMentees);
    capacity.acceptedMentees = enriched.filter(
      (m) => m.status === "accepted"
    ).length;
  } catch (e) {
    log.warn("capacity_lookup_failed", { message: e.message });
  }

  log.end({ stage: "getMyMentees", count: enriched.length });
  return ok({ mentees: enriched, consultations, capacity });
}

// GET /thesis/settings — returns a professor's current thesis capacity
// settings (`maxMentees`) plus their derived counts. Cheap to compute on
// every page load; we don't bother caching.
async function getThesisSettings(event, context, log, caller) {
  if (caller.role !== "professor") {
    return unauthorized("Only professors have thesis settings.");
  }
  try {
    const profile = await getItem(`USER#${caller.userId}`, "PROFILE");
    const maxMentees = normalizeMaxMentees(profile?.maxMentees);
    const acceptedMentees = await countAcceptedMenteesForProfessor(
      caller.userId
    );
    log.end({ stage: "getThesisSettings", maxMentees, acceptedMentees });
    return ok({
      maxMentees,
      acceptedMentees,
      menteesRemaining: Math.max(0, maxMentees - acceptedMentees),
    });
  } catch (e) {
    log.error(e, { stage: "getThesisSettings" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
}

// PATCH /thesis/settings — updates the calling professor's `maxMentees`.
// Body: { maxMentees: number }. We refuse to drop below the current
// `acceptedMentees` count because shrinking the cap underneath an
// already-accepted mentor would put the relationship in an inconsistent
// state (the professor would appear "over-capacity" and the student-side
// listing would silently filter them off the picker — but the existing
// mentee row would still be active).
async function patchThesisSettings(event, context, log, caller) {
  if (caller.role !== "professor") {
    return unauthorized("Only professors have thesis settings.");
  }

  let body = {};
  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      return badRequest("invalid JSON body");
    }
  }

  const raw = body && body.maxMentees;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return badRequest("maxMentees must be a non-negative integer.");
  }
  const next = Math.floor(parsed);
  if (next > MAX_MENTEES_HARD_LIMIT) {
    return badRequest(
      `maxMentees must be ${MAX_MENTEES_HARD_LIMIT} or fewer.`
    );
  }

  let acceptedMentees = 0;
  try {
    acceptedMentees = await countAcceptedMenteesForProfessor(caller.userId);
  } catch (e) {
    log.warn("count_failed", { message: e.message });
  }

  if (next < acceptedMentees) {
    return badRequest(
      `Can't drop below your current accepted mentees (${acceptedMentees}). ` +
        `Wait for a thesis to wrap up before lowering the cap.`
    );
  }

  try {
    await updateItem(`USER#${caller.userId}`, "PROFILE", {
      maxMentees: next,
    });
  } catch (e) {
    log.error(e, { stage: "updateProfile" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  log.end({
    stage: "patchThesisSettings",
    maxMentees: next,
    acceptedMentees,
  });
  return ok({
    maxMentees: next,
    acceptedMentees,
    menteesRemaining: Math.max(0, next - acceptedMentees),
  });
}

// PATCH /thesis/mentees/{studentId}
//
// Body: { status: "accepted" | "declined", declineReason? }
//
// Flips the latest pending row for (caller, studentId) to the requested
// status. Notifies the student afterwards. We do not let a professor
// re-flip an already-decided row — once accepted/declined, terminal.
async function patchMentee(event, context, log, caller) {
  if (caller.role !== "professor") {
    return unauthorized("Only professors can decide on mentees.");
  }

  const studentId = event.pathParameters && event.pathParameters.studentId;
  if (!studentId) return badRequest("missing studentId");

  let body = {};
  if (event.body) {
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      return badRequest("invalid JSON body");
    }
  }
  const nextStatus = body && body.status;
  if (nextStatus !== "accepted" && nextStatus !== "declined") {
    return badRequest("status must be 'accepted' or 'declined'");
  }
  const declineReason =
    body && typeof body.declineReason === "string"
      ? body.declineReason.trim().slice(0, 240)
      : "";

  // Find the latest mentorship row between this professor and student.
  // We allow paginating through history but expect a small number per
  // pair, so a full queryPk + filter is fine.
  let candidates;
  try {
    candidates = await queryPk(
      `PROFESSOR#${caller.userId}`,
      `MENTEE#${studentId}#`
    );
  } catch (e) {
    log.error(e, { stage: "queryMentee" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
  if (!candidates.length) return badRequest("No mentorship row for this student.");

  candidates.sort((a, b) => (a.attempt || 0) - (b.attempt || 0));
  const latest = candidates[candidates.length - 1];

  if (latest.status !== "pending") {
    return badRequest(
      `This proposal is already ${latest.status}; flips are not allowed.`
    );
  }

  // Initial-consultation guard — the professor can't decide until they've
  // actually had the kickoff meeting with the student. We resolve the
  // linked initial consultation row by walking this professor's thesis
  // consultations and matching on (studentId, thesisStage="initial",
  // status≠cancelled). The slot's start instant is the source of truth.
  let initialConsultation = null;
  try {
    const myCons = await getMyConsultations(caller.userId, "professor", {
      range: "all",
    });
    initialConsultation = (myCons || []).find(
      (c) =>
        c.consultationType === "thesis" &&
        c.thesisStage === "initial" &&
        c.studentId === studentId &&
        c.status !== "cancelled"
    );
  } catch (e) {
    log.warn("initial_consultation_lookup_failed", { message: e.message });
  }

  if (!initialConsultation) {
    return badRequest(
      "Can't decide yet: the initial consultation booking is missing. " +
        "Ask the student to re-book or restore the booking before deciding."
    );
  }
  const initialInstant = combineSlotInstantUtc(
    initialConsultation.date,
    initialConsultation.time
  );
  if (
    !initialInstant ||
    !Number.isFinite(initialInstant.getTime()) ||
    initialInstant.getTime() > Date.now()
  ) {
    return badRequest(
      "Can't decide yet: the initial consultation hasn't taken place. " +
        "You can accept or decline once the meeting on " +
        `${initialConsultation.date} at ${initialConsultation.time} has started.`
    );
  }

  // Capacity guard — accepting a new mentee must stay inside `maxMentees`.
  // Decline doesn't consume capacity, so we only check on the accept path.
  if (nextStatus === "accepted") {
    let cap = 0;
    let accepted = 0;
    try {
      const profile = await getItem(`USER#${caller.userId}`, "PROFILE");
      cap = normalizeMaxMentees(profile?.maxMentees);
      accepted = await countAcceptedMenteesForProfessor(caller.userId);
    } catch (e) {
      log.warn("capacity_check_failed", { message: e.message });
    }
    if (cap <= 0) {
      return badRequest(
        "Set a thesis capacity (maxMentees) on your Thesis settings before accepting mentees."
      );
    }
    if (accepted >= cap) {
      return badRequest(
        `You're at capacity (${accepted}/${cap} mentees). Raise the cap on the Thesis settings card or decline this proposal.`
      );
    }
  }

  const decidedAt = new Date().toISOString();
  try {
    await updateItem(latest.PK, latest.SK, {
      status: nextStatus,
      decidedAt,
      ...(nextStatus === "declined" && declineReason
        ? { declineReason }
        : {}),
    });
  } catch (e) {
    log.error(e, { stage: "updateMentee" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  // Notify the student. Best-effort — a missing notification doesn't
  // block the decision, but it should land in 99% of cases.
  try {
    const profProfile = await getItem(
      `USER#${caller.userId}`,
      "PROFILE"
    ).catch(() => null);
    const profLabel =
      (profProfile && profProfile.displayName) || "Your professor";
    const verb = nextStatus === "accepted" ? "accepted" : "declined";
    const reasonClause =
      nextStatus === "declined" && declineReason
        ? ` Reason: ${declineReason}`
        : "";
    await createNotification(studentId, {
      type: "thesis_decision",
      message: `${profLabel} ${verb} your thesis proposal.${reasonClause}`,
    });
  } catch (_err) {
    /* noop */
  }

  log.end({
    stage: "patchMentee",
    studentId,
    status: nextStatus,
    attempt: latest.attempt,
  });
  return ok({
    ok: true,
    status: nextStatus,
    decidedAt,
    attempt: latest.attempt,
  });
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-thesis", event, context);
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

    const path = event.path || event.resource || "";
    const method = event.httpMethod;

    if (method === "POST" && path.endsWith("/thesis/proposal")) {
      return await postProposal(event, context, log, caller);
    }
    if (method === "GET" && path.endsWith("/thesis/me")) {
      return await getMyThesis(event, context, log, caller);
    }
    if (method === "GET" && path.endsWith("/thesis/mentees")) {
      return await getMyMentees(event, context, log, caller);
    }
    if (method === "PATCH" && path.includes("/thesis/mentees/")) {
      return await patchMentee(event, context, log, caller);
    }
    if (method === "GET" && path.endsWith("/thesis/settings")) {
      return await getThesisSettings(event, context, log, caller);
    }
    if (method === "PATCH" && path.endsWith("/thesis/settings")) {
      return await patchThesisSettings(event, context, log, caller);
    }

    log.warn("unsupported_route", { method, path });
    return badRequest(`unsupported route: ${method} ${path}`);
  } catch (e) {
    log.error(e, { stage: "handler_unhandled" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
