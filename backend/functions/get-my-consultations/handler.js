"use strict";

const { getMyConsultations } = require("/opt/nodejs/consultations");
const { ok, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

// GET /me/consultations — returns the caller's upcoming consultations.
// Notifications used to be piggy-backed on this response and auto-cleared
// server-side, which made polling racy (a successful poll that lost the
// network between server-clear and client-render lost notifications
// permanently). Notifications now live behind their own /me/notifications
// endpoints and keep server-side read state.
exports.handler = async (event, context) => {
  const log = createLogger("get-my-consultations", event, context);
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

    // Optional `range` query param controls the date window:
    //   - upcoming (default): c.date >= today — same as before.
    //   - all: include the last 60 days too, so the feedback composer
    //          can pick up sessions whose start time has passed.
    //   - past: only the last 60 days, status=booked.
    // The 60-day cap keeps the response bounded; sessions older than that
    // are already out of scope for "rate the recent past" UX.
    const qs = event.queryStringParameters || {};
    const range = (qs.range || "upcoming").toLowerCase();
    if (!["upcoming", "all", "past"].includes(range)) {
      log.warn("invalid_range", { range });
      return ok({ consultations: [] });
    }

    let consultations;
    try {
      consultations = await getMyConsultations(caller.userId, caller.role, {
        range,
      });
    } catch (e) {
      log.error(e, {
        stage: "getMyConsultations",
        userId: caller.userId,
        role: caller.role,
        range,
      });
      return error(`Internal error (requestId=${context.awsRequestId})`);
    }

    log.end({ count: consultations.length, range });
    return ok({ consultations });
  } catch (e) {
    log.error(e, { stage: "handler_unhandled" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
