"use strict";

// Notification management API.
//
//   GET    /me/notifications                  list (newest-first, limit=50 default)
//   POST   /me/notifications/mark-all-read    flip every unread to read
//   PATCH  /me/notifications/{notifId}        mark a single notification read
//   DELETE /me/notifications/{notifId}        delete a single notification
//
// All routes are scoped to the caller (PK = USER#<their cognito sub>) so a
// user can only ever see / mutate their own notifications. The `notifId`
// path param is the row's full SK (e.g. NOTIF#1717459200000#abcd-...);
// it's URL-encoded by the client and decoded once here.

const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} = require("/opt/nodejs/consultations");
const {
  ok,
  badRequest,
  unauthorized,
  notFound,
  error,
} = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(qs) {
  const raw = parseInt((qs && qs.limit) || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

function readNotifId(event) {
  const raw = event.pathParameters && event.pathParameters.notifId;
  if (!raw) return null;
  // API Gateway already URL-decodes path params once, but keep the explicit
  // decode for symmetry with manage-slots/manage-schedule and to defend
  // against double-encoded clients.
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (!decoded.startsWith("NOTIF#")) return null;
  return decoded;
}

async function handleList(event, caller, log) {
  const limit = parseLimit(event.queryStringParameters);
  const notifications = await listNotifications(caller.userId, { limit });
  const unreadCount = notifications.filter((n) => !n.read).length;
  log.end({ stage: "list", count: notifications.length, unreadCount, limit });
  return ok({ notifications, unreadCount });
}

async function handleMarkAll(caller, log) {
  const updated = await markAllNotificationsRead(caller.userId);
  log.end({ stage: "mark_all_read", updated });
  return ok({ markedRead: updated });
}

async function handleMarkOne(event, caller, log) {
  const notifId = readNotifId(event);
  if (!notifId) {
    log.warn("invalid_notif_id", { stage: "validate_path" });
    return badRequest("notifId path parameter is required and must start with NOTIF#");
  }
  const flipped = await markNotificationRead(caller.userId, notifId);
  if (!flipped) {
    log.warn("notif_not_found", { stage: "mark_one", notifId });
    return notFound("Notification not found.");
  }
  log.end({ stage: "mark_one", notifId });
  return ok({ id: notifId, read: true });
}

async function handleDelete(event, caller, log) {
  const notifId = readNotifId(event);
  if (!notifId) {
    log.warn("invalid_notif_id", { stage: "validate_path" });
    return badRequest("notifId path parameter is required and must start with NOTIF#");
  }
  const removed = await deleteNotification(caller.userId, notifId);
  if (!removed) {
    log.warn("notif_not_found", { stage: "delete", notifId });
    return notFound("Notification not found.");
  }
  log.end({ stage: "delete", notifId });
  return ok({ id: notifId, deleted: true });
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-notifications", event, context);
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

    const method = event.httpMethod;
    const resource = event.resource || event.path || "";

    if (method === "GET" && resource.endsWith("/notifications")) {
      return await handleList(event, caller, log);
    }
    if (method === "POST" && resource.endsWith("/mark-all-read")) {
      return await handleMarkAll(caller, log);
    }
    if (method === "PATCH" && resource.endsWith("/{notifId}")) {
      return await handleMarkOne(event, caller, log);
    }
    if (method === "DELETE" && resource.endsWith("/{notifId}")) {
      return await handleDelete(event, caller, log);
    }

    log.warn("unsupported_route", { stage: "route", method, resource });
    return badRequest(`unsupported route: ${method} ${resource}`);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      httpMethod: event && event.httpMethod,
      resource: event && event.resource,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
