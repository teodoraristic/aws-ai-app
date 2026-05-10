"use strict";

const crypto = require("crypto");
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { putItem, queryGsi1, queryGsi1Page } = require("/opt/nodejs/db");
const { createLogger } = require("/opt/nodejs/logger");

// 14-day TTL on stored reports — long enough to comfortably display the
// most-recent generated report on the professor's home page even if the
// schedule misfires once, short enough that we don't accumulate stale rows
// indefinitely.
const REPORT_TTL_SECONDS = 14 * 24 * 60 * 60;

// Required env vars validated at module load. If any of these is missing the
// handler refuses to even page DynamoDB — failing loudly is far better than
// silently producing reports with `undefined` keys / wrong region.
const REQUIRED_ENV = [
  "TABLE_NAME",
  "BEDROCK_REGION",
  "BEDROCK_MODEL_ID",
  "REPORTS_BUCKET",
];

// Eager client construction — both clients are cheap to build but constructing
// at module scope means a misconfigured region throws at cold start (visible
// in CloudWatch as an INIT_REPORT error) instead of on the first send().
let bedrockClient;
let s3Client;
let initError = null;
try {
  bedrockClient = new BedrockRuntimeClient({
    region: process.env.BEDROCK_REGION,
  });
  s3Client = new S3Client({});
} catch (e) {
  // Capture so the handler can log a clean, structured error on first
  // invocation instead of dying with a bare module-load stack.
  initError = e;
}

// Pull AWS-SDK-v3 metadata off any thrown error so CloudWatch lines carry
// the requestId / httpStatus / fault info needed to file an AWS support
// ticket without having to dig further. Always safe to call.
function awsErrorMeta(err) {
  if (!err || typeof err !== "object") return {};
  const md = err.$metadata || {};
  return {
    awsErrorName: err.name,
    awsErrorCode: err.Code || err.code,
    awsHttpStatus: md.httpStatusCode,
    awsRequestId: md.requestId,
    awsExtendedRequestId: md.extendedRequestId,
    awsCfId: md.cfId,
    awsAttempts: md.attempts,
    awsTotalRetryDelay: md.totalRetryDelay,
    awsFault: err.$fault,
    awsService: err.$service,
  };
}

// Translate raw S3 error names into a fix-it-now hint so on-call doesn't
// have to remember which one means what. Conservative — only adds hints
// for the cases we know how to remediate.
function s3ErrorHint(err) {
  // Local-side errors (request never reaches S3). Caught FIRST so the more
  // specific Node-runtime hint wins over the AWS service-name switch below.
  if (err && err.code === "ERR_INVALID_CHAR") {
    return "Non-ASCII character in S3 metadata header value (HTTP/1.1 forbids it). Sanitize Metadata values via asciiHeaderSafe() before PutObject — usually a Serbian name with diacritics like ć/š/đ.";
  }
  switch (err && err.name) {
    case "NoSuchBucket":
      return "Bucket does not exist. Check REPORTS_BUCKET env var matches the deployed CDK output ReportsBucketName.";
    case "AccessDenied":
    case "AccessDeniedException":
      return "IAM denied PutObject. Check the dailyReportFn role still has reportsBucket.grantPut applied in the CDK stack.";
    case "PreconditionFailed":
      return "Object key already exists (IfNoneMatch:'*' guard). Two cron runs likely fired in the same millisecond — investigate EventBridge for duplicate invocations.";
    case "SlowDown":
    case "RequestLimitExceeded":
      return "S3 throttled the put. Re-run will succeed; consider spreading the cron load if this becomes frequent.";
    case "InvalidBucketName":
      return "REPORTS_BUCKET env var is malformed.";
    case "NetworkingError":
    case "TimeoutError":
    case "RequestTimeout":
      return "Transient network issue talking to S3. EventBridge will not retry; next day's run should self-heal this professor.";
    default:
      return null;
  }
}

function bedrockErrorHint(err) {
  switch (err && err.name) {
    case "AccessDeniedException":
      return "Bedrock denied InvokeModel. Check the lambda role grants bedrock:InvokeModel for the inference profile AND every member region's foundation-model ARN.";
    case "ResourceNotFoundException":
      return "Model id or inference profile not found in BEDROCK_REGION. Verify BEDROCK_MODEL_ID and that the profile exists in this account.";
    case "ValidationException":
      return "Bedrock rejected the request payload. Likely too-long prompt or invalid inferenceConfig.";
    case "ThrottlingException":
      return "Bedrock throttled. Will be skipped this run; next day will retry.";
    case "ModelTimeoutException":
    case "ModelStreamErrorException":
      return "Bedrock model failed mid-inference. Transient on Nova — next run should succeed.";
    case "ServiceUnavailableException":
    case "InternalServerException":
      return "Bedrock service-side error. Not actionable from our code.";
    default:
      return null;
  }
}

function ddbErrorHint(err) {
  switch (err && err.name) {
    case "ResourceNotFoundException":
      return "DynamoDB table or index missing. TABLE_NAME env var or GSI1 deploy out of sync.";
    case "AccessDeniedException":
      return "IAM denied DynamoDB action. The dailyReportFn role lost its dynamodb:* grant.";
    case "ProvisionedThroughputExceededException":
    case "ThrottlingException":
      return "DynamoDB throttled. Table is PAY_PER_REQUEST so this is unusual — investigate hot partition.";
    case "ValidationException":
      return "DynamoDB rejected the request shape. Likely a code-side bug constructing the query/put.";
    default:
      return null;
  }
}

// File-system-safe ISO timestamp: 2026-05-06T17-00-00-123Z
function safeIsoTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// Slots without durationMinutes default to 30 min — matches the manage-slots
// fallback constant the rest of the codebase already uses.
const DEFAULT_SLOT_MINUTES = 30;

function addMinutes(hhmm, mins) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const total = h * 60 + m + mins;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

// Collapse rows by start time so a group session with 3 students becomes
// one bullet that says "3 students" instead of three duplicate lines.
// Cancelled bookings are dropped — the professor doesn't need to read about
// students that aren't actually showing up.
function buildScheduleLines(consultations) {
  const byTime = new Map();
  for (const c of consultations) {
    if (c && c.status === "cancelled") continue;
    const start = c && c.time;
    if (!start) continue;
    if (!byTime.has(start)) {
      byTime.set(start, {
        start,
        durationMinutes: Number.isInteger(c.durationMinutes)
          ? c.durationMinutes
          : DEFAULT_SLOT_MINUTES,
        topics: new Set(),
        studentCount: 0,
      });
    }
    const entry = byTime.get(start);
    entry.studentCount += 1;
    const rawTopic = (c.topic || c.note || "").trim();
    const topic = rawTopic.length > 200 ? rawTopic.slice(0, 200) : rawTopic;
    if (topic) entry.topics.add(topic);
  }

  return Array.from(byTime.values())
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((entry) => {
      const end = addMinutes(entry.start, entry.durationMinutes);
      // Pipe-separated, labelled fields so each bullet reads like a tiny
      // record instead of prose. Order matches "when -> who -> what".
      const parts = [
        `${entry.start} – ${end}`,
        `Students: ${entry.studentCount}`,
      ];
      if (entry.topics.size > 0) {
        parts.push(`Topic: ${Array.from(entry.topics).join(" / ")}`);
      }
      return `- ${parts.join("  |  ")}`;
    });
}

// S3 user-metadata values are serialized as HTTP headers (`x-amz-meta-<k>`)
// which Node's HTTP client rejects with ERR_INVALID_CHAR if they contain any
// byte outside US-ASCII printable. Strip diacritics first so Serbian names
// stay legible ("Petrović" -> "Petrovic", "Đorđević" -> "Dordevic"), then
// hard-replace anything still non-ASCII with '?'. 1024-char cap is well
// under the 2 KB total user-metadata limit.
function asciiHeaderSafe(value) {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 1024);
}

exports.handler = async (event, context) => {
  const log = createLogger("daily-report", event, context);
  log.start({
    ruleId: event && event.id,
    scheduledTime: event && event.time,
    eventSource: event && event.source,
  });

  // ---------- Init guards ----------
  // Anything that goes wrong before we even start paging professors lives
  // here and gets its own stage so CloudWatch makes the failure obvious.
  if (initError) {
    log.error(initError, {
      stage: "module_init",
      hint:
        "AWS SDK client construction failed at cold start. Usually a bad BEDROCK_REGION value.",
      ...awsErrorMeta(initError),
    });
    throw initError;
  }

  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    const err = new Error(
      `Missing required env vars: ${missingEnv.join(", ")}`
    );
    err.name = "ConfigError";
    log.error(err, {
      stage: "env_validation",
      missingEnv,
      hint:
        "These are wired by the CDK stack (uni-consultations-stack.js, makeFn / dailyReportFn). " +
        "If you see this in CloudWatch the deploy is out of sync — redeploy the stack.",
    });
    throw err;
  }

  const REPORTS_BUCKET = process.env.REPORTS_BUCKET;
  const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID;

  // ---------- Compute target date ----------
  let tomorrowStr;
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrowStr = tomorrow.toISOString().split("T")[0];
    log.withContext({ targetDate: tomorrowStr, reportsBucket: REPORTS_BUCKET });
  } catch (e) {
    // Practically unreachable, but if Date construction ever fails we want
    // a structured error rather than an opaque crash.
    log.error(e, {
      stage: "compute_target_date",
      hint: "Date arithmetic threw. This should never happen on Node 22.",
    });
    throw e;
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let totalProfessors = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let s3Uploaded = 0;
  let s3Failed = 0;
  let ddbPersisted = 0;
  let ddbFailed = 0;

  try {
    // ---------- Page through all professors ----------
    let lastKey = undefined;
    let pageIndex = 0;
    do {
      pageIndex += 1;
      let pageResult;
      try {
        pageResult = await queryGsi1Page("ROLE#professor", null, {
          limit: 25,
          exclusiveStartKey: lastKey,
        });
      } catch (e) {
        // A failure paging professors is fatal: we have no list to iterate.
        // Log with the exact stage / page index / GSI key so on-call can
        // reproduce the query in the AWS console without guessing.
        log.error(e, {
          stage: "list_professors_page",
          pageIndex,
          gsi1pk: "ROLE#professor",
          targetDate: tomorrowStr,
          hint: ddbErrorHint(e),
          ...awsErrorMeta(e),
        });
        throw e;
      }

      const professors = pageResult.items;
      totalProfessors += professors.length;
      log.info("professors_page_loaded", {
        pageIndex,
        pageSize: professors.length,
        hasMore: !!pageResult.lastEvaluatedKey,
      });

      // ---------- Per-professor work ----------
      for (const professor of professors) {
        const profStartedAt = Date.now();
        const professorId = professor && professor.userId;
        const professorName = professor && professor.displayName;

        if (!professorId) {
          // A professor row with no userId is malformed — log the full row
          // so the data team can fix it, then skip without counting failed.
          failed += 1;
          log.error(new Error("Professor row missing userId"), {
            stage: "validate_professor_row",
            pageIndex,
            professorRow: professor,
            hint:
              "Seed/profile-update bug. The post-confirmation lambda should always populate userId.",
          });
          continue;
        }

        try {
          // ----- Query tomorrow's consultations for this professor -----
          let consultations;
          try {
            consultations = await queryGsi1(
              `PROFESSOR#${professorId}`,
              `DATE#${tomorrowStr}`
            );
          } catch (e) {
            log.error(e, {
              stage: "query_consultations",
              professorId,
              professorName,
              targetDate: tomorrowStr,
              gsi1pk: `PROFESSOR#${professorId}`,
              gsi1skPrefix: `DATE#${tomorrowStr}`,
              hint: ddbErrorHint(e),
              ...awsErrorMeta(e),
            });
            throw e;
          }

          if (!Array.isArray(consultations) || consultations.length === 0) {
            skipped += 1;
            log.info("professor_skipped", {
              professorId,
              reason: "no_consultations",
            });
            continue;
          }

          const scheduleLines = buildScheduleLines(consultations);

          // Every consultation row was cancelled — nothing meaningful to
          // report. Skip and move on so the professor isn't spammed with an
          // empty bullet list.
          if (scheduleLines.length === 0) {
            skipped += 1;
            log.info("professor_skipped", {
              professorId,
              reason: "all_cancelled",
              consultationsRaw: consultations.length,
            });
            continue;
          }

          const scheduleBlock = scheduleLines.join("\n");

          // ----- Bedrock summary -----
          // Hard rules in the system prompt to keep the output predictable:
          //   * one cheerful greeting line, no formal closing
          //   * the schedule list is reproduced *verbatim* — we already
          //     formatted it in buildScheduleLines() so the model can't drift
          //     on time math, student counts, or topic wording.
          const bedrockStartedAt = Date.now();
          let response;
          try {
            response = await bedrockClient.send(
              new ConverseCommand({
                modelId: BEDROCK_MODEL_ID,
                system: [
                  {
                    text:
                      "You write short, cheerful daily schedule notes in English for university professors. " +
                      "Output exactly two parts: (1) one upbeat greeting sentence addressed to the professor by first name, " +
                      "(2) the schedule bullet list copied verbatim from the user message. " +
                      "Do not add a sign-off, do not add commentary, do not reword the bullets, do not add or remove lines.",
                  },
                ],
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        text:
                          `Professor: ${professorName}\n` +
                          `Date: ${tomorrowStr}\n\n` +
                          `Schedule (copy these bullets verbatim under your greeting):\n${scheduleBlock}`,
                      },
                    ],
                  },
                ],
                inferenceConfig: { maxTokens: 256 },
              })
            );
          } catch (e) {
            log.error(e, {
              stage: "bedrock_converse",
              professorId,
              professorName,
              modelId: BEDROCK_MODEL_ID,
              region: process.env.BEDROCK_REGION,
              consultations: consultations.length,
              bedrockMs: Date.now() - bedrockStartedAt,
              hint: bedrockErrorHint(e),
              ...awsErrorMeta(e),
            });
            throw e;
          }
          const bedrockMs = Date.now() - bedrockStartedAt;
          const usage = (response && response.usage) || {};
          totalInputTokens += usage.inputTokens || 0;
          totalOutputTokens += usage.outputTokens || 0;

          // ----- Extract the report text -----
          let reportText;
          try {
            const content =
              (response &&
                response.output &&
                response.output.message &&
                response.output.message.content) ||
              [];
            const textBlock = content.find((b) => b && b.text);
            reportText = (textBlock && textBlock.text) || "";
            if (!reportText) {
              const err = new Error(
                "Bedrock returned no text block in response.output.message.content"
              );
              err.name = "EmptyBedrockResponse";
              throw err;
            }
          } catch (e) {
            log.error(e, {
              stage: "extract_report_text",
              professorId,
              professorName,
              stopReason: response && response.stopReason,
              contentBlocks:
                (response &&
                  response.output &&
                  response.output.message &&
                  Array.isArray(response.output.message.content) &&
                  response.output.message.content.length) ||
                0,
              hint:
                "Bedrock returned successfully but with no text. Likely hit maxTokens with only a tool/structured block — bump maxTokens or simplify the prompt.",
            });
            throw e;
          }

          const generatedAt = new Date().toISOString();
          const ttl = Math.floor(Date.now() / 1000) + REPORT_TTL_SECONDS;

          // ----- Upload to S3 (immutable archive, never overwrites) -----
          // Key shape: reports/<targetDate>/<professorId>/<isoTs>-<rand>.txt
          //   - targetDate prefix makes "all reports for tomorrow" a cheap
          //     prefix-list operation.
          //   - random suffix is belt-and-braces against a hypothetical
          //     duplicate cron firing in the same millisecond.
          //   - IfNoneMatch:"*" makes S3 itself reject overwrites (412).
          const tsForKey = safeIsoTimestamp(new Date(generatedAt));
          const randSuffix = crypto.randomBytes(4).toString("hex");
          const objectKey =
            `reports/${tomorrowStr}/${professorId}/` +
            `${tsForKey}-${randSuffix}.txt`;
          const bodyBytes = Buffer.byteLength(reportText, "utf8");
          const s3StartedAt = Date.now();
          try {
            await s3Client.send(
              new PutObjectCommand({
                Bucket: REPORTS_BUCKET,
                Key: objectKey,
                Body: reportText,
                ContentType: "text/plain; charset=utf-8",
                IfNoneMatch: "*",
                Metadata: {
                  professorid: asciiHeaderSafe(professorId),
                  professorname: asciiHeaderSafe(professorName),
                  date: asciiHeaderSafe(tomorrowStr),
                  generatedat: asciiHeaderSafe(generatedAt),
                  consultations: asciiHeaderSafe(consultations.length),
                },
              })
            );
            s3Uploaded += 1;
            log.info("report_s3_uploaded", {
              professorId,
              bucket: REPORTS_BUCKET,
              key: objectKey,
              bytes: bodyBytes,
              s3Ms: Date.now() - s3StartedAt,
            });
          } catch (e) {
            // S3 failure does NOT abort the per-professor loop — DynamoDB
            // is still our source of truth for the read API. We just lose
            // this run's archive, which the next day's run regenerates.
            s3Failed += 1;
            log.error(e, {
              stage: "s3_put_report",
              professorId,
              professorName,
              bucket: REPORTS_BUCKET,
              key: objectKey,
              bytes: bodyBytes,
              s3Ms: Date.now() - s3StartedAt,
              hint: s3ErrorHint(e),
              ...awsErrorMeta(e),
            });
          }

          // ----- Persist to DynamoDB (read API source of truth) -----
          // Best-effort: a put failure is logged but doesn't fail the cron
          // run for this professor (we still got the model output in
          // CloudWatch + S3 and can regenerate tomorrow).
          try {
            await putItem({
              PK: `USER#${professorId}`,
              SK: `DAILY_REPORT#${tomorrowStr}`,
              entityType: "DailyReport",
              professorId,
              date: tomorrowStr,
              total: consultations.length,
              reportText,
              generatedAt,
              s3Bucket: REPORTS_BUCKET,
              s3Key: objectKey,
              ttl,
            });
            ddbPersisted += 1;
          } catch (e) {
            ddbFailed += 1;
            log.error(e, {
              stage: "ddb_put_report",
              professorId,
              professorName,
              targetDate: tomorrowStr,
              pk: `USER#${professorId}`,
              sk: `DAILY_REPORT#${tomorrowStr}`,
              reportLen: reportText.length,
              hint: ddbErrorHint(e),
              ...awsErrorMeta(e),
            });
          }

          log.info("professor_done", {
            professorId,
            consultations: consultations.length,
            bedrockMs,
            professorMs: Date.now() - profStartedAt,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reportLen: reportText.length,
            s3Key: objectKey,
          });

          processed += 1;
        } catch (e) {
          // Catch-all per professor — the inner stages already logged the
          // specific cause. This line is just the loop-level summary so a
          // single CloudWatch query (`evt: daily-report.error`) shows
          // every failure with the professor it belonged to.
          failed += 1;
          log.error(e, {
            stage: "professor_loop",
            professorId,
            professorName,
            professorMs: Date.now() - profStartedAt,
            ...awsErrorMeta(e),
          });
        }
      }

      lastKey = pageResult.lastEvaluatedKey;
    } while (lastKey);

    log.end({
      total: totalProfessors,
      processed,
      skipped,
      failed,
      s3Uploaded,
      s3Failed,
      ddbPersisted,
      ddbFailed,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });

    return {
      statusCode: 200,
      total: totalProfessors,
      processed,
      skipped,
      failed,
      s3Uploaded,
      s3Failed,
      ddbPersisted,
      ddbFailed,
    };
  } catch (e) {
    // Top-level safety net. By this point a more specific stage has already
    // logged the root cause; this line ties the failed run to the run
    // counters so we know how far we got before crashing.
    log.error(e, {
      stage: "handler_unhandled",
      processedSoFar: processed,
      skippedSoFar: skipped,
      failedSoFar: failed,
      s3UploadedSoFar: s3Uploaded,
      s3FailedSoFar: s3Failed,
      ddbPersistedSoFar: ddbPersisted,
      ddbFailedSoFar: ddbFailed,
      ...awsErrorMeta(e),
    });
    // Re-throw so EventBridge marks the invocation failed and CloudWatch
    // metrics (Errors / FailedInvocations) reflect reality. EventBridge
    // does not retry rule-driven invocations, so this just shows up as a
    // failure on the dashboard — exactly what we want.
    throw e;
  }
};
