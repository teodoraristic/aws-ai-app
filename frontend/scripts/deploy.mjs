#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const STACK_NAME = process.env.STACK_NAME || "UniConsultationsStack";
const REGION = process.env.AWS_REGION || "eu-west-1";

function run(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.join(" ")}`;
  console.log(`\n› ${printable}`);
  const r = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`\nCommand failed (exit ${r.status}): ${printable}`);
    process.exit(r.status ?? 1);
  }
  return r.stdout?.toString() ?? "";
}

console.log(`Deploying frontend → stack=${STACK_NAME} region=${REGION}`);

run("npm", ["run", "build"]);

const outputsRaw = run(
  "aws",
  [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    STACK_NAME,
    "--region",
    REGION,
    "--query",
    "Stacks[0].Outputs",
    "--output",
    "json",
  ],
  { capture: true }
);

let outputs;
try {
  outputs = JSON.parse(outputsRaw || "[]");
} catch {
  console.error("Could not parse CloudFormation outputs.");
  process.exit(1);
}

const find = (k) => outputs.find((o) => o.OutputKey === k)?.OutputValue;
const bucket = find("SiteBucketName");
const distribution = find("DistributionId");

if (!bucket || !distribution) {
  console.error(
    `Missing stack outputs. Need SiteBucketName + DistributionId. Got: ${JSON.stringify(
      outputs.map((o) => o.OutputKey)
    )}`
  );
  process.exit(1);
}

console.log(`\nbucket       = ${bucket}`);
console.log(`distribution = ${distribution}`);

run("aws", [
  "s3",
  "sync",
  "dist/",
  `s3://${bucket}/`,
  "--delete",
  "--region",
  REGION,
]);

run("aws", [
  "cloudfront",
  "create-invalidation",
  "--distribution-id",
  distribution,
  "--paths",
  "/*",
]);

console.log("\nDone. Hard-reload the CloudFront URL to see changes.");
