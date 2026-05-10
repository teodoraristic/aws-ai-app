"use strict";

const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { putItem } = require("/opt/nodejs/db");
const { createLogger } = require("/opt/nodejs/logger");

const cognitoClient = new CognitoIdentityProviderClient({});

// Only these two values are valid self-service roles. "admin" must be
// granted manually via the Cognito console or admin API — never via signUp.
const ALLOWED_ROLES = new Set(["student", "professor"]);

exports.handler = async (event, context) => {
  const log = createLogger("auth-post-confirmation", event, context);
  const sub =
    event.request &&
    event.request.userAttributes &&
    event.request.userAttributes.sub;

  log.start({
    triggerSource: event.triggerSource,
    userPoolId: event.userPoolId,
    userName: event.userName,
    sub,
  });

  try {
    if (event.triggerSource !== "PostConfirmation_ConfirmSignUp") {
      log.end({ skipped: true, reason: "unhandled_trigger" });
      return event;
    }

    const attrs = (event.request && event.request.userAttributes) || {};
    const email = attrs.email;
    const rawRole = attrs["custom:role"];
    const displayName = attrs["custom:displayName"];
    // Optional professor metadata. Cognito custom attributes don't currently
    // include these (the SPA's signUp form only collects name/role), but we
    // read them defensively so a future schema change Just Works.
    const department = attrs["custom:department"] || "";
    const subjectsRaw = attrs["custom:subjects"] || "";
    const subjects = subjectsRaw
      ? subjectsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Server-side role normalisation — the primary defence against role
    // elevation. The SPA's registration form only presents "student" and
    // "professor", but a direct Cognito SignUp API call could supply any
    // string (including "admin"). We accept only the two valid values and
    // default anything else to "student". When the submitted value was
    // invalid we also call AdminUpdateUserAttributes so the next JWT the
    // user receives carries the corrected value rather than the attacker's
    // supplied string.
    const role = ALLOWED_ROLES.has(rawRole) ? rawRole : "student";

    log.withContext({ sub, role, rawRole });

    if (!sub) {
      log.warn("missing_sub", { stage: "validate_attrs" });
      return event;
    }

    if (role !== rawRole) {
      log.warn("invalid_role_normalized", {
        stage: "normalize_role",
        rawRole,
        normalizedRole: role,
      });
      try {
        await cognitoClient.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: event.userPoolId,
            Username: event.userName,
            UserAttributes: [{ Name: "custom:role", Value: role }],
          })
        );
        log.info("role_overridden_in_cognito", { role });
      } catch (e) {
        // Log but don't abort — the DynamoDB write below still uses the
        // normalised role, so the app's authorization checks are safe even
        // if the Cognito attribute update races. The user will get the
        // corrected JWT on their next sign-in once we retry or they
        // re-authenticate.
        log.error(e, {
          stage: "AdminUpdateUserAttributes",
          hint:
            "Failed to override invalid role in Cognito. DynamoDB profile " +
            "uses the normalised role so Lambda auth is still correct.",
        });
      }
    }

    try {
      await putItem({
        PK: `USER#${sub}`,
        SK: "PROFILE",
        GSI1PK: `ROLE#${role}`,
        GSI1SK: `USER#${sub}`,
        userId: sub,
        email,
        displayName,
        role,
        department: role === "professor" ? department : undefined,
        subjects: role === "professor" && subjects.length > 0 ? subjects : undefined,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      log.error(e, {
        stage: "putItem_profile",
        sub,
        role,
        hasEmail: !!email,
        hasDisplayName: !!displayName,
      });
      // Re-throw so Cognito surfaces the failure to the user instead of
      // silently creating an account with no profile row.
      throw e;
    }

    log.end({ profileCreated: true, role });
    return event;
  } catch (e) {
    // Top-level safety net: any unexpected failure (logger bug, putItem,
    // attr access on a malformed event) is captured with a clear stage so
    // CloudWatch shows exactly where it broke before Cognito retries.
    log.error(e, {
      stage: "handler_unhandled",
      triggerSource: event && event.triggerSource,
      sub,
    });
    throw e;
  }
};
