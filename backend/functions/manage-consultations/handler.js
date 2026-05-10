"use strict";

const {
  cancelConsultation,
  submitFeedback,
} = require("/opt/nodejs/consultations");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

// PATCH /consultations/{id}
// Today this only handles "status: cancelled" + an optional reason. We
// keep it dispatch-style so future fields (reschedule, etc.) slot in
// without a new method.
async function patchConsultation(event, context, log, caller) {
  const consultationId =
    event.pathParameters && event.pathParameters.id;
  if (!consultationId) {
    log.warn("missing_id", { stage: "validate_path" });
    return badRequest("missing consultation id");
  }
  log.withContext({ consultationId });

  // Optional cancellation reason — accepted from EITHER role now (chunk 4).
  // Body is JSON; ignore parse errors so a plain "no body" cancellation
  // still works.
  let reason = "";
  if (event.body) {
    try {
      const body =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      if (body && typeof body.reason === "string") {
        reason = body.reason.trim();
      }
    } catch {
      /* malformed body — silently ignore, reason stays empty */
    }
  }

  let result;
  try {
    result = await cancelConsultation(consultationId, caller.userId, {
      reason,
    });
  } catch (e) {
    log.error(e, {
      stage: "cancelConsultation",
      consultationId,
      userId: caller.userId,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result.error) {
    log.warn("cancel_rejected", {
      stage: "cancelConsultation",
      reason: result.error,
      consultationId,
    });
    return badRequest(result.error);
  }

  log.end({ cancelled: true });
  return ok(result);
}

// POST /consultations/{id}/feedback
//
// Two role-scoped slices:
//   - student: { rating: 1..5, comment? }
//   - professor: { attended: "yes"|"no"|"late", note? }
// Server figures out which slice to write from the caller's identity on
// the consultation row (not the asserted Cognito role).
async function postFeedback(event, context, log, caller) {
  const consultationId =
    event.pathParameters && event.pathParameters.id;
  if (!consultationId) {
    log.warn("missing_id", { stage: "validate_path" });
    return badRequest("missing consultation id");
  }
  log.withContext({ consultationId });

  let payload = {};
  if (event.body) {
    try {
      payload =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (e) {
      log.warn("invalid_json", { stage: "parse_body", message: e.message });
      return badRequest("invalid JSON body");
    }
  }
  if (!payload || typeof payload !== "object") {
    return badRequest("body must be a JSON object");
  }

  let result;
  try {
    result = await submitFeedback({
      consultationId,
      userId: caller.userId,
      payload,
      log,
    });
  } catch (e) {
    // ConditionalCheckFailed maps to "already submitted" — the parallel
    // double-submit case the layer's expression guards against.
    if (e && e.name === "ConditionalCheckFailedException") {
      log.warn("feedback_already_submitted", { consultationId });
      return badRequest("Feedback for this session has already been submitted.");
    }
    log.error(e, { stage: "submitFeedback", consultationId });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result && result.error) {
    log.warn("feedback_rejected", {
      stage: "submitFeedback",
      reason: result.error,
      consultationId,
    });
    return badRequest(result.error);
  }

  log.end({ stage: "feedback", role: result.role });
  return ok(result);
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-consultations", event, context);
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

    if (event.httpMethod === "POST" && path.endsWith("/feedback")) {
      return await postFeedback(event, context, log, caller);
    }

    if (event.httpMethod === "PATCH") {
      return await patchConsultation(event, context, log, caller);
    }

    log.warn("unsupported_method", {
      stage: "route",
      httpMethod: event.httpMethod,
      path,
    });
    return badRequest(`unsupported method: ${event.httpMethod}`);
  } catch (e) {
    log.error(e, { stage: "handler_unhandled" });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
