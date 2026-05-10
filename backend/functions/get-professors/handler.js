"use strict";

const { listProfessorsPage } = require("/opt/nodejs/consultations");
const { ok, badRequest, error } = require("/opt/nodejs/response");
const { createLogger } = require("/opt/nodejs/logger");

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

// AWS SDK v3 names the error classes via `err.name`. Group them by how we
// want to surface them to the caller; the underlying issue is operational,
// not a client mistake, so we still respond 500 but with a message that
// tells ops which sub-class fired.
const THROTTLING_ERRORS = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
]);

const TIMEOUT_ERRORS = new Set([
  "TimeoutError",
  "RequestTimeout",
  "ETIMEDOUT",
]);

function parseLimit(raw) {
  if (raw === undefined || raw === "") return { value: DEFAULT_LIMIT };
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    return {
      errorMessage: `Query parameter 'limit' must be an integer; got '${raw}'.`,
    };
  }
  return { value: Math.min(Math.max(n, MIN_LIMIT), MAX_LIMIT) };
}

function decodeNextToken(raw) {
  // Buffer.from(str, "base64url") never throws on bad input in Node; it just
  // produces garbage bytes, so the failure surfaces at JSON.parse instead.
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {
      errorMessage:
        "Query parameter 'nextToken' is malformed (did not decode to valid JSON).",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      errorMessage:
        "Query parameter 'nextToken' is malformed (must encode a JSON object).",
    };
  }
  return { value: parsed };
}

function mapDynamoQueryError(err, requestId) {
  const name = (err && err.name) || "UnknownError";
  const detail = (err && err.message) || "no detail";

  // ValidationException on a Query almost always means the ExclusiveStartKey
  // (i.e. the client-supplied nextToken) does not match the table key
  // schema. Treat it as a client error so the caller knows their token is
  // stale or tampered with.
  if (name === "ValidationException") {
    return {
      response: badRequest(
        `Query parameter 'nextToken' was rejected by the data store: ${detail}.`
      ),
    };
  }
  if (name === "ResourceNotFoundException") {
    return {
      response: error(
        `Data store is misconfigured: table or index not found (${detail}). requestId=${requestId}`
      ),
    };
  }
  if (name === "AccessDeniedException") {
    return {
      response: error(
        `Data store rejected access for this function: ${detail}. requestId=${requestId}`
      ),
    };
  }
  if (THROTTLING_ERRORS.has(name)) {
    return {
      response: error(
        `Data store is throttling requests (${name}); please retry shortly. requestId=${requestId}`
      ),
    };
  }
  if (TIMEOUT_ERRORS.has(name) || err.code === "ETIMEDOUT") {
    return {
      response: error(
        `Data store did not respond in time (${name}). requestId=${requestId}`
      ),
    };
  }
  return {
    response: error(
      `Failed to list professors due to ${name}: ${detail}. requestId=${requestId}`
    ),
  };
}

exports.handler = async (event, context) => {
  const log = createLogger("get-professors", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    const qs = event.queryStringParameters || {};

    const limitParse = parseLimit(qs.limit);
    if (limitParse.errorMessage) {
      log.warn("invalid_limit", { limitRaw: qs.limit });
      return badRequest(limitParse.errorMessage);
    }
    const limit = limitParse.value;

    let exclusiveStartKey;
    if (qs.nextToken) {
      const decoded = decodeNextToken(qs.nextToken);
      if (decoded.errorMessage) {
        log.warn("invalid_next_token", { reason: decoded.errorMessage });
        return badRequest(decoded.errorMessage);
      }
      exclusiveStartKey = decoded.value;
    }

    let result;
    try {
      result = await listProfessorsPage({ limit, exclusiveStartKey });
    } catch (e) {
      log.error(e, {
        stage: "listProfessorsPage",
        awsErrorName: (e && e.name) || "UnknownError",
      });
      const mapped = mapDynamoQueryError(e, context.awsRequestId);
      return mapped.response;
    }

    if (!result || !Array.isArray(result.professors)) {
      log.error(new Error("listProfessorsPage_returned_unexpected_shape"), {
        stage: "validate_result",
        resultKeys: result ? Object.keys(result) : null,
      });
      return error(
        `Listing professors returned an unexpected shape from the data layer. requestId=${context.awsRequestId}`
      );
    }

    const withName = result.professors.filter((p) => !!p.name).length;
    log.end({
      count: result.professors.length,
      withName,
      withoutName: result.professors.length - withName,
      hasMore: !!result.lastEvaluatedKey,
    });

    const body = { professors: result.professors };
    if (result.lastEvaluatedKey) {
      try {
        body.nextToken = Buffer.from(
          JSON.stringify(result.lastEvaluatedKey)
        ).toString("base64url");
      } catch (e) {
        log.error(e, { stage: "encode_nextToken" });
        return error(
          `Failed to encode pagination token for the response (${
            (e && e.name) || "UnknownError"
          }). requestId=${context.awsRequestId}`
        );
      }
    }
    return ok(body);
  } catch (e) {
    const errName = (e && e.name) || "UnknownError";
    log.error(e, { stage: "handler_unhandled", errName });
    return error(
      `Unexpected ${errName} while handling request: ${
        (e && e.message) || "no detail"
      }. requestId=${context.awsRequestId}`
    );
  }
};
