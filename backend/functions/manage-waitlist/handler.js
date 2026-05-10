"use strict";

const {
  joinWaitlist,
  leaveWaitlist,
  listWaitlistForStudent,
} = require("/opt/nodejs/waitlist");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");
const { getItem } = require("/opt/nodejs/db");

// POST /professors/{id}/slots/{slotSK}/waitlist
async function postJoinWaitlist(event, context, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "student") {
    return unauthorized("Only students can join a waitlist.");
  }

  const professorId = event.pathParameters && event.pathParameters.id;
  const rawSlotSK = event.pathParameters && event.pathParameters.slotSK;
  if (!professorId || !rawSlotSK) {
    return badRequest("missing professorId / slotSK");
  }
  const slotSK = decodeURIComponent(rawSlotSK);

  let body = {};
  if (event.body) {
    try {
      body =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      log.warn("invalid_json", { message: e.message });
      return badRequest("invalid JSON body");
    }
  }

  const topic = typeof body.topic === "string" ? body.topic : "";
  const note = typeof body.note === "string" ? body.note : "";

  let result;
  try {
    result = await joinWaitlist({
      professorId,
      slotSK,
      studentId: caller.userId,
      topic,
      note,
    });
  } catch (e) {
    log.error(e, { stage: "joinWaitlist", professorId, slotSK });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result.error) {
    log.warn("waitlist_join_rejected", { reason: result.error });
    return badRequest(result.error);
  }

  log.end({
    stage: "joinWaitlist",
    alreadyOnWaitlist: !!result.alreadyOnWaitlist,
  });
  return ok(result);
}

// DELETE /me/waitlist/{slotSK}?professorId=…
//
// We require the professorId via query string because the WAITLIST row's
// PK is partitioned by professor — without it we'd have to query GSI2
// just to find which professor's row to delete. Sending it explicitly
// keeps the leave path a single roundtrip.
async function deleteLeaveWaitlist(event, context, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  const rawSlotSK = event.pathParameters && event.pathParameters.slotSK;
  if (!rawSlotSK) return badRequest("missing slotSK");
  const slotSK = decodeURIComponent(rawSlotSK);

  const qs = event.queryStringParameters || {};
  const professorId = qs.professorId;
  if (!professorId) {
    return badRequest("professorId query parameter is required");
  }

  let result;
  try {
    result = await leaveWaitlist({
      professorId,
      slotSK,
      studentId: caller.userId,
    });
  } catch (e) {
    log.error(e, { stage: "leaveWaitlist", professorId, slotSK });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result.error) {
    return badRequest(result.error);
  }
  log.end({ stage: "leaveWaitlist" });
  return ok(result);
}

// GET /me/waitlist
async function getMyWaitlist(event, context, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  let entries;
  try {
    entries = await listWaitlistForStudent(caller.userId);
  } catch (e) {
    log.error(e, { stage: "listWaitlistForStudent" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  // Enrich each entry with the professor's display name so the UI can
  // render rows without a follow-up fetch. Best-effort — a missing
  // profile leaves the field blank; the card has a "professor" fallback.
  if (entries.length > 0) {
    const profIds = [
      ...new Set(entries.map((e) => e.professorId).filter(Boolean)),
    ];
    const profiles = await Promise.all(
      profIds.map((id) =>
        getItem(`USER#${id}`, "PROFILE").catch(() => null)
      )
    );
    const byId = new Map();
    for (const p of profiles) {
      if (p && p.userId) byId.set(p.userId, p);
    }
    entries = entries.map((e) => {
      const prof = byId.get(e.professorId);
      return {
        ...e,
        professorName: prof ? prof.displayName : "",
      };
    });
  }

  log.end({ stage: "getMyWaitlist", count: entries.length });
  return ok({ entries });
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-waitlist", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    const path = event.path || event.resource || "";
    const method = event.httpMethod;

    if (method === "POST" && path.endsWith("/waitlist")) {
      return await postJoinWaitlist(event, context, log);
    }
    if (method === "GET" && path.endsWith("/me/waitlist")) {
      return await getMyWaitlist(event, context, log);
    }
    if (method === "DELETE" && path.includes("/me/waitlist/")) {
      return await deleteLeaveWaitlist(event, context, log);
    }

    log.warn("unsupported_route", { method, path });
    return badRequest(`unsupported route: ${method} ${path}`);
  } catch (e) {
    log.error(e, { stage: "handler_unhandled" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
