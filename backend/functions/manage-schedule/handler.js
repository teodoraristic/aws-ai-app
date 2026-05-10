"use strict";

const { randomUUID } = require("crypto");
const { queryPk, putItem, getItem } = require("/opt/nodejs/db");
const {
  ok,
  badRequest,
  unauthorized,
  notFound,
  error,
} = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");
const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const TABLE = process.env.TABLE_NAME;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

async function deleteItem(pk, sk) {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: pk, SK: sk } })
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Cap how many days a single range request can write so a misclick like
// 2026 → 2030 can't pollute the table with thousands of items.
const MAX_RANGE_DAYS = 60;

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function expandDateRange(fromDate, toDate) {
  const out = [];
  let cursor = fromDate;
  for (let i = 0; i < MAX_RANGE_DAYS && cursor <= toDate; i++) {
    out.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return out;
}

// ---------- /professors/{id}/unavailable ----------
//
// GET    list unavailable days (anyone authed — students may want to know
//        why no slots show up on a date)
// POST   add an unavailable day (owner only)
// DELETE remove (owner only)
//
// Schema: PK = PROFESSOR#<id>, SK = UNAVAILABLE#<date>

async function listUnavailable(professorId, log) {
  const items = await queryPk(`PROFESSOR#${professorId}`, "UNAVAILABLE#");
  log.end({ stage: "listUnavailable", count: items.length });
  return ok({
    unavailable: items.map((i) => ({
      date: i.date,
      reason: i.reason || "",
      createdAt: i.createdAt,
    })),
  });
}

async function addUnavailable(professorId, body, log) {
  // Accept either a single `date` (legacy/back-compat) or a `dateFrom` +
  // `dateTo` pair. When only `dateFrom` is provided, treat it as a one-day
  // range so the client can use the new shape uniformly.
  const fromInput = body.dateFrom || body.date;
  const toInput = body.dateTo || body.dateFrom || body.date;

  if (!fromInput || !DATE_RE.test(fromInput)) {
    log.warn("invalid_date_from", { stage: "validate_body", dateFrom: fromInput });
    return badRequest("dateFrom (or date) is required (YYYY-MM-DD)");
  }
  if (!DATE_RE.test(toInput)) {
    log.warn("invalid_date_to", { stage: "validate_body", dateTo: toInput });
    return badRequest("dateTo must be YYYY-MM-DD");
  }
  if (toInput < fromInput) {
    log.warn("range_inverted", {
      stage: "validate_body",
      dateFrom: fromInput,
      dateTo: toInput,
    });
    return badRequest("dateTo must be on or after dateFrom");
  }

  const dates = expandDateRange(fromInput, toInput);
  const reason = (body.reason || "").trim();
  const createdAt = new Date().toISOString();

  for (const date of dates) {
    await putItem({
      PK: `PROFESSOR#${professorId}`,
      SK: `UNAVAILABLE#${date}`,
      professorId,
      date,
      reason,
      createdAt,
    });
  }

  log.end({
    stage: "addUnavailable",
    dateFrom: fromInput,
    dateTo: toInput,
    count: dates.length,
  });
  return ok({ dates, count: dates.length });
}

async function removeUnavailable(professorId, date, log) {
  if (!date || !DATE_RE.test(date)) {
    log.warn("invalid_date", { stage: "validate_path", date });
    return badRequest("date in path must be YYYY-MM-DD");
  }
  await deleteItem(`PROFESSOR#${professorId}`, `UNAVAILABLE#${date}`);
  log.end({ stage: "removeUnavailable", date });
  return ok({ date });
}

// ---------- /professors/{id}/classes ----------
//
// Class schedule entries — when the professor is teaching, NOT consultations.
// Owner-only visibility: this MUST never appear to students.
//
// Schema: PK = PROFESSOR#<id>, SK = CLASS#<classId>

async function listClasses(professorId, log) {
  const items = await queryPk(`PROFESSOR#${professorId}`, "CLASS#");
  log.end({ stage: "listClasses", count: items.length });
  return ok({
    classes: items.map((i) => ({
      classId: i.classId,
      subject: i.subject || "",
      date: i.date,
      startTime: i.startTime,
      endTime: i.endTime,
      room: i.room || "",
    })),
  });
}

async function addClass(professorId, body, log) {
  const { subject, date, startTime, endTime, room } = body;
  if (!subject || !date || !startTime || !endTime) {
    log.warn("missing_fields", {
      stage: "validate_body",
      hasSubject: !!subject,
      hasDate: !!date,
      hasStartTime: !!startTime,
      hasEndTime: !!endTime,
    });
    return badRequest(
      "subject, date, startTime, endTime are required"
    );
  }
  if (!DATE_RE.test(date)) {
    return badRequest("date must be YYYY-MM-DD");
  }
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return badRequest("startTime / endTime must be HH:MM");
  }
  if (endTime <= startTime) {
    return badRequest("endTime must be after startTime");
  }

  const classId = randomUUID();
  await putItem({
    PK: `PROFESSOR#${professorId}`,
    SK: `CLASS#${classId}`,
    professorId,
    classId,
    subject: String(subject).trim(),
    date,
    startTime,
    endTime,
    room: (room || "").trim(),
    createdAt: new Date().toISOString(),
  });
  log.end({ stage: "addClass", classId, date });
  return ok({ classId });
}

async function removeClass(professorId, classId, log) {
  if (!classId) {
    return badRequest("classId is required in path");
  }
  const existing = await getItem(`PROFESSOR#${professorId}`, `CLASS#${classId}`);
  if (!existing) {
    log.warn("class_not_found", { classId });
    return notFound("class not found");
  }
  await deleteItem(`PROFESSOR#${professorId}`, `CLASS#${classId}`);
  log.end({ stage: "removeClass", classId });
  return ok({ classId });
}

// ---------- Routing ----------
//
// API Gateway maps these to the same handler:
//   /professors/{id}/unavailable           GET, POST
//   /professors/{id}/unavailable/{date}    DELETE
//   /professors/{id}/classes               GET, POST
//   /professors/{id}/classes/{classId}     DELETE

function pathSegment(event) {
  // Decide between "unavailable" and "classes" based on the resource path
  // template (which API Gateway provides). Falls back to inspecting the URL
  // if needed.
  const resource = event.resource || event.path || "";
  if (resource.includes("/unavailable")) return "unavailable";
  if (resource.includes("/classes")) return "classes";
  return null;
}

async function route(event, log) {
  const caller = getCaller(event);
  log.withContext({ userId: caller.userId, role: caller.role });

  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId) {
    log.warn("missing_professor_id", { stage: "validate_path" });
    return badRequest("missing professor id");
  }
  log.withContext({ professorId });

  const segment = pathSegment(event);
  if (!segment) {
    log.warn("unknown_resource", { resource: event.resource });
    return badRequest("unknown resource");
  }

  const isMutation = ["POST", "DELETE", "PUT"].includes(event.httpMethod);
  const isPrivateView = segment === "classes" && event.httpMethod === "GET";

  // Owner-only writes for everything; class schedule is owner-only even
  // for reads (students must not see when a professor is teaching).
  if ((isMutation || isPrivateView) && caller.userId !== professorId) {
    log.warn("forbidden", {
      stage: "authorize",
      segment,
      method: event.httpMethod,
    });
    return unauthorized();
  }
  if (isMutation && caller.role !== "professor") {
    log.warn("forbidden_role", { stage: "authorize", segment });
    return unauthorized();
  }

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      log.warn("invalid_json", { stage: "parse_body", message: e.message });
      return badRequest("invalid JSON body");
    }
  }

  if (segment === "unavailable") {
    if (event.httpMethod === "GET") return listUnavailable(professorId, log);
    if (event.httpMethod === "POST") return addUnavailable(professorId, body, log);
    if (event.httpMethod === "DELETE") {
      const date = event.pathParameters && event.pathParameters.date;
      return removeUnavailable(professorId, date, log);
    }
  }

  if (segment === "classes") {
    if (event.httpMethod === "GET") return listClasses(professorId, log);
    if (event.httpMethod === "POST") return addClass(professorId, body, log);
    if (event.httpMethod === "DELETE") {
      const classId = event.pathParameters && event.pathParameters.classId;
      return removeClass(professorId, classId, log);
    }
  }

  log.warn("unsupported_method", { stage: "route", segment, method: event.httpMethod });
  return badRequest(`unsupported method: ${event.httpMethod}`);
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-schedule", event, context);
  log.start();
  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }
    return await route(event, log);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      httpMethod: event && event.httpMethod,
      resource: event && event.resource,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
