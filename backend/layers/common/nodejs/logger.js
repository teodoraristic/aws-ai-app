"use strict";

// Module-level flag so we can mark the first invocation after a cold start
// in CloudWatch. Lambda keeps the module loaded between invocations on a
// warm container, so this flips to false and stays false until the next
// container is spun up.
let isFirstInvocation = true;

function consumeColdStart() {
  const wasCold = isFirstInvocation;
  isFirstInvocation = false;
  return wasCold;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (_e) {
    // Fall back to a minimal payload so logging itself never throws and
    // poisons the handler.
    return JSON.stringify({ logSerializeError: true, evt: obj && obj.evt });
  }
}

function buildBase(event, context) {
  const reqCtx = (event && event.requestContext) || {};
  const identity = reqCtx.identity || {};
  return {
    awsRequestId: context && context.awsRequestId,
    apigwRequestId: reqCtx.requestId,
    fn: context && context.functionName,
    fnVersion: context && context.functionVersion,
    coldStart: consumeColdStart(),
    sourceIp: identity.sourceIp,
    userAgent: identity.userAgent,
    stage: reqCtx.stage,
  };
}

// Returns a logger bound to a single Lambda invocation.
//
// Usage:
//   const log = createLogger("get-professors", event, context);
//   log.start();
//   ...do work, optionally log.withContext({ userId, role })...
//   log.end({ count: professors.length });
//
// On error:
//   log.error(e, { hint: "DDB query failed" });
//
// Every emitted line is JSON and shares the same base fields
// (awsRequestId, apigwRequestId, coldStart, fn, etc.) so it's trivial
// to filter the entire request lifecycle in CloudWatch Insights.
function createLogger(prefix, event, context) {
  const base = buildBase(event, context);
  const startedAt = Date.now();
  let bound = {};

  function emit(stream, evtName, fields) {
    const line = {
      evt: `${prefix}.${evtName}`,
      ...base,
      ...bound,
      ...fields,
    };
    const text = safeStringify(line);
    if (stream === "error") console.error(text);
    else if (stream === "warn") console.warn(text);
    else console.log(text);
  }

  return {
    // Attach extra fields (e.g. userId/role) to every subsequent line so
    // you don't have to repeat them on each log call.
    withContext(ctx) {
      bound = { ...bound, ...(ctx || {}) };
    },
    start(fields = {}) {
      emit("log", "start", {
        method: event && event.httpMethod,
        path: event && event.path,
        pathParameters: event && event.pathParameters,
        queryStringParameters: event && event.queryStringParameters,
        bodyBytes:
          event && typeof event.body === "string" ? event.body.length : 0,
        ...fields,
      });
    },
    info(evtName, fields = {}) {
      emit("log", evtName, fields);
    },
    warn(evtName, fields = {}) {
      emit("warn", evtName, fields);
    },
    end(fields = {}) {
      emit("log", "done", {
        ok: true,
        durationMs: Date.now() - startedAt,
        ...fields,
      });
    },
    error(err, fields = {}) {
      emit("error", "error", {
        ok: false,
        durationMs: Date.now() - startedAt,
        name: err && err.name,
        message: err && err.message,
        stack: err && err.stack,
        ...fields,
      });
    },
    elapsedMs() {
      return Date.now() - startedAt;
    },
  };
}

module.exports = { createLogger };
