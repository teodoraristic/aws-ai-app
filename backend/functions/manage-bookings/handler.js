"use strict";

const { bookSlotCore } = require("/opt/nodejs/consultations");
const {
  ok,
  created,
  badRequest,
  unauthorized,
  error,
} = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

// POST /bookings — manual reservation entry point used by the Professors page
// "Reserve" modal. All booking invariants (slot existence, past-slot,
// self-booking, duplicate booking, capacity) live in `bookSlotCore` so that
// this REST handler and the chat tool path stay in lock-step. This handler
// only enforces the transport-layer rule the chat path enforces differently:
// the caller MUST be a student.
async function createBooking(event, context, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "student") {
    log.warn("forbidden_role", { stage: "authorize", role: caller.role });
    return unauthorized("Only students can reserve sessions.");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    log.warn("invalid_json", { stage: "parse_body", message: e.message });
    return badRequest("invalid JSON body");
  }

  const {
    professorId,
    slotId,
    slotSK: rawSlotSK,
    note,
    reason,
    thesisTheme,
  } = body;
  // Frontend uses `slotId` as the slot's sort key; we accept both names so
  // either can be sent without breaking older clients.
  const slotSK = rawSlotSK || slotId;

  if (!professorId || !slotSK) {
    log.warn("missing_fields", {
      stage: "validate_body",
      hasProfessorId: !!professorId,
      hasSlotSK: !!slotSK,
    });
    return badRequest("professorId and slotId are required");
  }

  // The frontend lets the student attach a mandatory "reason for
  // consultation" (the topic) and an optional free-form message. We feed
  // the reason into the embedded topic field so it can still be used for
  // topic-grouping (same as the chat path); the message is preserved
  // verbatim in the response. Topic is required so manual reservations
  // match the chat flow — every consultation must have a topic.
  const trimmedNote = typeof note === "string" ? note.trim() : "";
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  const topicSeed = trimmedReason || trimmedNote || "";

  if (trimmedNote.length > 500 || trimmedReason.length > 500) {
    log.warn("input_too_long", {
      stage: "validate_body",
      noteLen: trimmedNote.length,
      reasonLen: trimmedReason.length,
    });
    return badRequest("note and reason must each be 500 characters or fewer");
  }

  if (!topicSeed) {
    log.warn("missing_topic", { stage: "validate_body" });
    return badRequest(
      "Please add a topic for the consultation so the professor knows what you'd like to discuss."
    );
  }

  let result;
  try {
    result = await bookSlotCore({
      professorId,
      slotSK,
      studentId: caller.userId,
      note: topicSeed,
      thesisTheme: typeof thesisTheme === "string" ? thesisTheme : "",
      log,
    });
  } catch (e) {
    log.error(e, {
      stage: "bookSlotCore",
      professorId,
      slotSK,
      studentId: caller.userId,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }

  if (result && result.error) {
    // bookSlotCore returns soft errors ("Slot is full" etc.) in the same
    // shape as the chat path. Re-emit them as 400 so the UI can surface
    // them inline in the modal.
    log.warn("booking_rejected_by_core", {
      stage: "bookSlotCore",
      reason: result.error,
      slotSK,
    });
    return badRequest(result.error);
  }

  const isGroup = (result.maxParticipants || 1) > 1;

  log.end({
    stage: "createBooking",
    consultationId: result.consultationId,
    slotSK,
    professorId,
    isGroup,
  });

  // 201 Created for a fresh resource, with the full booking payload so the
  // UI can update the slot card without a round-trip refetch.
  return created({
    booking: {
      consultationId: result.consultationId,
      professorId: result.professorId,
      slotId: result.slotSK,
      slotSK: result.slotSK,
      date: result.date,
      time: result.time,
      topic: result.topic,
      note: trimmedNote,
      reason: trimmedReason,
      status: "booked",
      slotStatus: result.status,
      currentParticipants: result.currentParticipants,
      maxParticipants: result.maxParticipants,
      isGroupSession: isGroup,
    },
  });
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-bookings", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    if (event.httpMethod === "POST") {
      return await createBooking(event, context, log);
    }

    log.warn("unsupported_method", {
      stage: "route",
      httpMethod: event.httpMethod,
    });
    return badRequest(`unsupported method: ${event.httpMethod}`);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      httpMethod: event && event.httpMethod,
      path: event && event.path,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
