"use strict";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH,DELETE",
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

const ok = (body = {}) => json(200, body);
const created = (body = {}) => json(201, body);
const badRequest = (msg = "Bad Request") => json(400, { message: msg });
const unauthorized = (msg = "Unauthorized") => json(401, { message: msg });
const notFound = (msg = "Not Found") => json(404, { message: msg });
const error = (msg = "Internal Server Error") => json(500, { message: msg });

module.exports = { ok, created, badRequest, unauthorized, notFound, error };
