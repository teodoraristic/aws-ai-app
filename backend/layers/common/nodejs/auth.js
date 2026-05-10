"use strict";

function getCaller(event) {
  const claims =
    event &&
    event.requestContext &&
    event.requestContext.authorizer &&
    event.requestContext.authorizer.claims;

  if (!claims) {
    throw new Error("Missing Cognito claims on request");
  }

  return {
    userId: claims.sub,
    role: claims["custom:role"],
    email: claims.email,
    displayName: claims["custom:displayName"],
  };
}

module.exports = { getCaller };
