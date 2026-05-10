#!/usr/bin/env node
//
// One-shot maintenance script: stamp legacy cancelled consultation rows
// with `cancelledBy` + `cancelledAt` so the My Reservations page can show
// a uniform "Cancelled by ..." label across history.
//
// Runs once, then can be deleted.
//
// Usage (from this folder):
//   node backfill-cancelled-by.mjs            # dry-run, prints what would change
//   node backfill-cancelled-by.mjs --apply    # actually writes the updates
//
// Strategy:
//   - Scan the table for items with PK = CONSULTATION#... and SK = METADATA
//     where status = "cancelled" AND cancelledBy is missing.
//   - For each such row, write `cancelledBy = "unknown"` and a best-guess
//     `cancelledAt` (the row's createdAt, since we have no better signal).
//   - The UI already treats anything that isn't exactly "professor" or
//     "student" as a generic "Cancelled" label, so this preserves history
//     without inventing attribution we can't justify.
//
// Why a one-time scan is acceptable here:
//   The PROJECT_CONTEXT rule "no scan() at runtime" applies to hot-path
//   Lambdas. This is a manual maintenance script, runs interactively, and
//   touches each item at most once. A scan is the simplest correct tool.

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const STACK_NAME = process.env.STACK_NAME || "UniConsultationsStack";
const REGION = process.env.AWS_REGION || "eu-west-1";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");

const cfn = new CloudFormationClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

async function getTableName() {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const outputs = r.Stacks?.[0]?.Outputs || [];
  const map = Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue]));
  if (!map.TableName) {
    throw new Error(
      `Could not find TableName output on stack ${STACK_NAME}. ` +
        `Got: ${Object.keys(map).join(", ")}`
    );
  }
  return map.TableName;
}

async function* scanCancelledMissingAttribution(tableName) {
  let exclusiveStartKey = undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        // Only items in the CONSULTATION partition family with the
        // METADATA sort key, status = cancelled, and no cancelledBy yet.
        FilterExpression:
          "begins_with(PK, :p) AND SK = :sk AND #status = :cancelled AND attribute_not_exists(cancelledBy)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":p": "CONSULTATION#",
          ":sk": "METADATA",
          ":cancelled": "cancelled",
        },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of r.Items || []) yield item;
    exclusiveStartKey = r.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

async function stamp(tableName, item) {
  // Best-guess cancelledAt: fall back to createdAt, then to "now". The
  // exact instant is lost; the goal here is just to make the row
  // self-describing.
  const cancelledAt = item.cancelledAt || item.createdAt || new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: item.PK, SK: item.SK },
      // Defensive: only stamp rows that are still both cancelled and
      // unattributed. If a real cancellation lands between scan and update
      // (extremely unlikely on a demo, but free to guard) we leave it alone.
      ConditionExpression:
        "#status = :cancelled AND attribute_not_exists(cancelledBy)",
      UpdateExpression:
        "SET cancelledBy = :who, cancelledAt = if_not_exists(cancelledAt, :at)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":who": "unknown",
        ":at": cancelledAt,
      },
    })
  );
}

async function main() {
  const tableName = await getTableName();
  console.log(
    `[backfill] table=${tableName} mode=${APPLY ? "APPLY" : "dry-run"}`
  );

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for await (const item of scanCancelledMissingAttribution(tableName)) {
    scanned += 1;
    const id = item.consultationId || item.PK;
    if (!APPLY) {
      console.log(
        `  - would stamp ${id}  (date=${item.date} time=${item.time})`
      );
      continue;
    }
    try {
      await stamp(tableName, item);
      updated += 1;
      console.log(`  ✓ stamped ${id}`);
    } catch (e) {
      skipped += 1;
      console.warn(`  ! skipped ${id} — ${e.name || "Error"}: ${e.message}`);
    }
  }

  console.log(
    `[backfill] done · matched=${scanned} updated=${updated} skipped=${skipped}`
  );
  if (!APPLY && scanned > 0) {
    console.log("[backfill] re-run with --apply to write the changes.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
