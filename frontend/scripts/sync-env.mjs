/**
 * Reads infrastructure/outputs.json (written by `cdk deploy --outputs-file`)
 * and generates frontend/.env so the app always points at the deployed stack.
 *
 * Usage:
 *   node scripts/sync-env.mjs
 *   npm run sync-env
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputsPath = resolve(__dirname, "../../infrastructure/outputs.json");

let raw;
try {
  raw = readFileSync(outputsPath, "utf8");
} catch (e) {
  console.error("Cannot read infrastructure/outputs.json:", e.message);
  console.error("Run `cdk deploy --outputs-file outputs.json` first.");
  process.exit(1);
}

let outputs;
try {
  outputs = JSON.parse(raw);
} catch (e) {
  console.error("outputs.json is not valid JSON:", e.message);
  process.exit(1);
}

const stack = outputs.UniConsultationsStack;
if (!stack) {
  console.error("UniConsultationsStack key not found in outputs.json");
  process.exit(1);
}

const required = ["ApiUrl", "CloudFrontUrl", "UserPoolId", "UserPoolClientId", "UserPoolDomain"];
const missing = required.filter((k) => !stack[k]);
if (missing.length > 0) {
  console.error("Missing output keys:", missing.join(", "));
  process.exit(1);
}

const cfUrl   = stack.CloudFrontUrl.replace(/\/+$/, "");
const apiUrl  = stack.ApiUrl.replace(/\/+$/, "");

const env = [
  `VITE_API_URL=${apiUrl}`,
  `VITE_USER_POOL_ID=${stack.UserPoolId}`,
  `VITE_USER_POOL_CLIENT_ID=${stack.UserPoolClientId}`,
  `VITE_USER_POOL_DOMAIN=${stack.UserPoolDomain}`,
  `VITE_REDIRECT_URL=${cfUrl}/callback`,
  `VITE_LOGOUT_URL=${cfUrl}`,
].join("\n");

const envPath = resolve(__dirname, "../.env");
writeFileSync(envPath, env, "utf8");

console.log("synced .env from CDK outputs");
console.log("  API:        ", apiUrl);
console.log("  CloudFront: ", cfUrl);
console.log("  UserPool:   ", stack.UserPoolId);
