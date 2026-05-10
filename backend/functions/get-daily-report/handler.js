"use strict";

// GET /me/daily-report — returns the most-recent persisted daily report
// for the calling professor. The cron in `daily-report` writes one row per
// professor per target date (PK=USER#<id>, SK=DAILY_REPORT#<date>) every
// evening at 19:00 UTC for tomorrow's schedule.
//
// Behaviour:
//   - If a specific ?date=YYYY-MM-DD is requested, fetch that exact row.
//   - Otherwise return the latest non-expired report (DESC SK sort + take
//     first), so the professor always sees "the next thing scheduled" even
//     if today's cron didn't run for them (e.g. they had no consultations
//     yesterday).
//   - When there is no report yet, return 200 { report: null } rather than
//     404. "No row" is an expected state right after deployment / for a
//     brand-new professor, not a client error — and a 200-with-null gives
//     the frontend a single shape to render the empty state from without
//     having to string-match error messages.
//
// Students and admins get 403 — this surface is for professors only.

const { getItem, queryPk } = require("/opt/nodejs/db");
const {
  ok,
  badRequest,
  unauthorized,
  error,
} = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shape(row) {
  if (!row) return null;
  return {
    date: row.date || row.SK?.replace(/^DAILY_REPORT#/, "") || null,
    total: row.total || 0,
    reportText: row.reportText || "",
    generatedAt: row.generatedAt || null,
  };
}

exports.handler = async (event, context) => {
  const log = createLogger("get-daily-report", event, context);
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

    if (caller.role !== "professor") {
      log.warn("role_blocked", { stage: "authz" });
      return unauthorized("Only professors can read daily reports.");
    }

    const requestedDate =
      (event.queryStringParameters && event.queryStringParameters.date) || "";
    if (requestedDate && !DATE_RE.test(requestedDate)) {
      log.warn("invalid_date", { stage: "validate_query", requestedDate });
      return badRequest("date query param must be YYYY-MM-DD");
    }

    if (requestedDate) {
      let row;
      try {
        row = await getItem(`USER#${caller.userId}`, `DAILY_REPORT#${requestedDate}`);
      } catch (e) {
        log.error(e, { stage: "getItem", requestedDate });
        return error(`Internal error (requestId=${context.awsRequestId})`);
      }
      if (!row) {
        log.end({ stage: "specific_date", found: false, requestedDate });
        return ok({ report: null });
      }
      log.end({ stage: "specific_date", found: true, requestedDate });
      return ok({ report: shape(row) });
    }

    // No specific date — return the most-recent (DESC SK) row. Cap at 1 so
    // we don't pull the full TTL window.
    let rows;
    try {
      rows = await queryPk(`USER#${caller.userId}`, "DAILY_REPORT#", {
        limit: 1,
        scanForward: false,
      });
    } catch (e) {
      log.error(e, { stage: "queryPk_latest" });
      return error(`Internal error (requestId=${context.awsRequestId})`);
    }
    const latest = rows && rows.length > 0 ? rows[0] : null;
    if (!latest) {
      log.end({ stage: "latest", found: false });
      return ok({ report: null });
    }
    log.end({ stage: "latest", found: true, date: latest.date });
    return ok({ report: shape(latest) });
  } catch (e) {
    log.error(e, { stage: "handler_unhandled" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
