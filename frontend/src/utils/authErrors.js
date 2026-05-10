// Maps Cognito / Amplify errors to user-friendly messages.
//
// We split errors into three buckets:
//   1. user-actionable -> tell them exactly what to fix
//   2. throttling      -> "try again in a moment"
//   3. backend / config -> generic "something on our end" message,
//      because the user can't fix "User pool client X does not exist"
//      or "NetworkError" by changing what they typed.
//
// The raw err.message is intentionally NEVER returned for unknown errors —
// Cognito's developer-facing messages (e.g. "User pool client ... does not
// exist", "Failed to fetch", "1 validation error detected") are confusing
// and look like the user did something wrong when they didn't.

const PASSWORD_HINT =
  "At least 8 characters, with one lowercase letter and one number.";

const BACKEND_ERROR_NAMES = new Set([
  "ResourceNotFoundException",
  "InternalErrorException",
  "InternalServerError",
  "ServiceUnavailable",
  "ServiceException",
  "UnknownError",
  "TypeError",
  "NetworkError",
  "AuthUserPoolException",
  "AuthApiError",
  "InvalidLambdaResponseException",
  "UnexpectedLambdaException",
  "UserLambdaValidationException",
]);

function isBackendError(name, message) {
  if (BACKEND_ERROR_NAMES.has(name)) return true;
  if (/network|fetch|timeout|cors/i.test(message || "")) return true;
  return false;
}

function isThrottling(name) {
  return name === "TooManyRequestsException" || name === "LimitExceededException";
}

const GENERIC_BACKEND =
  "Something on our end isn't working right now. Please try again in a few minutes.";

const GENERIC_THROTTLING = "Too many attempts. Try again in a moment.";

export function friendlySignUpError(err) {
  const name = err?.name || "";
  const message = err?.message || "";

  if (name === "UsernameExistsException") {
    return "An account with this email already exists. Try signing in instead.";
  }
  if (name === "InvalidPasswordException") {
    return `Password does not meet the requirements. ${PASSWORD_HINT}`;
  }
  if (name === "InvalidParameterException") {
    // Cognito uses this for both empty fields AND email-format violations.
    // The default message is technical ("1 validation error detected: ...")
    // so we replace it unless it clearly references the email field.
    if (/email/i.test(message)) {
      return "Please enter a valid email address.";
    }
    return "Some details are invalid. Please review and try again.";
  }
  if (isThrottling(name)) return GENERIC_THROTTLING;
  if (isBackendError(name, message)) return GENERIC_BACKEND;

  return "Could not create the account. Please try again.";
}

export function friendlySignInError(err) {
  const name = err?.name || "";
  const message = err?.message || "";

  if (name === "UserNotFoundException" || name === "NotAuthorizedException") {
    return "Incorrect email or password.";
  }
  if (name === "UserNotConfirmedException") {
    return "Please confirm your email before signing in.";
  }
  if (name === "PasswordResetRequiredException") {
    return "Password reset required. Please contact support.";
  }
  if (name === "InvalidParameterException") {
    return "Please enter your email and password.";
  }
  if (isThrottling(name)) return GENERIC_THROTTLING;
  if (isBackendError(name, message)) return GENERIC_BACKEND;

  return "Could not sign in. Please try again.";
}

export function friendlyConfirmError(err) {
  const name = err?.name || "";
  const message = err?.message || "";

  if (name === "CodeMismatchException") {
    return "That code doesn't match. Double-check the digits and try again.";
  }
  if (name === "ExpiredCodeException") {
    return "This code has expired. Request a new one and try again.";
  }
  if (name === "UserNotFoundException") {
    return "We can't find an account for that email.";
  }
  if (name === "NotAuthorizedException" && /already confirmed/i.test(message)) {
    return "This account is already verified. Please sign in.";
  }
  if (isThrottling(name)) return GENERIC_THROTTLING;
  if (isBackendError(name, message)) return GENERIC_BACKEND;

  return "Could not verify the code. Please try again.";
}
