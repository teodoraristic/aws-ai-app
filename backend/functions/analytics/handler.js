"use strict";

// Analytics Lambda — serves both /analytics/professor and /analytics/admin.
// All aggregation happens in-memory after a couple of key-based DynamoDB
// queries. We deliberately avoid scan() and rely on:
//   - PK = PROFESSOR#<id> for slots (and any unavailable / class rows we
//     filter back out)
//   - GSI1PK = PROFESSOR#<id> for consultation metadata rows
//   - GSI1PK = ROLE#professor for the professor directory (admin view).

const crypto = require("crypto");
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const { queryPk, queryGsi1, getItem, putItem } = require("/opt/nodejs/db");
const { listProfessors } = require("/opt/nodejs/consultations");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");

// Bedrock client is reused across invocations within a warm container so
// the SDK's connection pool gets re-used between calls.
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION,
});

// Type axis for chart legends — every consultation should have one of
// these (server normalises). Keeping the labels separate from the raw
// keys lets the frontend swap copy without touching the aggregator.
const CONSULTATION_TYPE_LABEL = {
  general: "General",
  exam_prep: "Exam prep",
  thesis: "Thesis",
};

function normalizeConsultationType(raw) {
  const t = (raw && String(raw).trim()) || "general";
  return CONSULTATION_TYPE_LABEL[t] ? t : "general";
}

function normalizeSubject(raw) {
  const t = (raw && String(raw).trim()) || "Unspecified";
  return t || "Unspecified";
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// `range` is one of "7d" | "30d" | "all".
// We make it symmetric (past N days + next N days) so charts cover both
// historical bookings and upcoming demand at the same time.
function resolveRange(range) {
  if (range === "7d") {
    return { from: isoDate(-7), to: isoDate(7), label: "7d" };
  }
  if (range === "30d") {
    return { from: isoDate(-30), to: isoDate(30), label: "30d" };
  }
  return { from: null, to: null, label: "all" };
}

function inRange(item, from, to) {
  if (!item || !item.date) return false;
  if (from && item.date < from) return false;
  if (to && item.date > to) return false;
  return true;
}

function normalizeTopic(s) {
  const t = (s && String(s).trim()) || "Consultation";
  return t || "Consultation";
}

// Bucket cancellation lead-time hours into 5 stable bins so the stacked
// bar chart on the frontend has a fixed legend regardless of data shape.
//   >48h | 24-48h | <24h | same-day | after-start
// `hours` is allowed to be null (legacy rows) — those land in "unknown".
function leadTimeBucket(hours) {
  if (hours == null || !Number.isFinite(hours)) return "unknown";
  if (hours < 0) return "after-start";
  if (hours < 4) return "same-day";
  if (hours < 24) return "<24h";
  if (hours < 48) return "24-48h";
  return ">48h";
}

// ─────────────────────────────────────────────────────────────────────────
// Core aggregation
// ─────────────────────────────────────────────────────────────────────────
// Takes a flat list of slots + consultations and returns the chart-ready
// shapes the frontend renders. `resolveSlot(consultation)` lets the caller
// disambiguate slotSK across professors when aggregating admin-wide.
function buildAnalytics({
  slots,
  consultations,
  waitlistRows = [],
  range,
  filters,
}) {
  const allBookings = consultations.filter((c) => c.SK === "METADATA");

  const matchesType = (c) => {
    if (!filters.consultationType || filters.consultationType === "all") {
      return true;
    }
    return normalizeConsultationType(c.consultationType) === filters.consultationType;
  };

  const matchesGroup = (c) => {
    if (filters.group === "group") return !!c.isGroupSession;
    if (filters.group === "individual") return !c.isGroupSession;
    return true;
  };

  // Date-window filter: consultations and slots both have `date` in YYYY-MM-DD.
  const slotsInWindow = slots.filter((s) => inRange(s, range.from, range.to));
  const bookingsInWindow = allBookings
    .filter((c) => inRange(c, range.from, range.to))
    .filter(matchesType)
    .filter(matchesGroup);

  const booked = bookingsInWindow.filter((c) => c.status !== "cancelled");
  const cancelled = bookingsInWindow.filter((c) => c.status === "cancelled");

  // ── Headline counters ──
  const totalSlots = slotsInWindow.length;
  const totalBookings = booked.length;
  const cancelledBookings = cancelled.length;
  const studentsServed = new Set(
    booked.map((c) => c.studentId).filter(Boolean)
  ).size;

  const freeSlots = slotsInWindow.filter(
    (s) => (s.currentParticipants || 0) === 0
  ).length;
  const bookedSlots = slotsInWindow.filter(
    (s) => (s.currentParticipants || 0) > 0
  ).length;

  const groupSessions = booked.filter((c) => c.isGroupSession).length;
  const individualSessions = booked.length - groupSessions;

  // ── Bookings by consultationType ── (real data now that we snapshot
  // the type onto every consultation row at booking time).
  const typeMap = new Map();
  for (const c of booked) {
    const key = normalizeConsultationType(c.consultationType);
    typeMap.set(key, (typeMap.get(key) || 0) + 1);
  }
  const bookingsByType = [...typeMap.entries()]
    .map(([type, count]) => ({
      type,
      label: CONSULTATION_TYPE_LABEL[type] || type,
      count,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Bookings by subject ── (consultation.subject snapshot from slot).
  const subjectMap = new Map();
  for (const c of booked) {
    if (!c.subject) continue; // skip blanks; "Unspecified" would crowd the chart
    const key = normalizeSubject(c.subject);
    subjectMap.set(key, (subjectMap.get(key) || 0) + 1);
  }
  const bookingsBySubject = [...subjectMap.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── Top topics (consultation.topic = what the student wants to discuss) ──
  const topicMap = new Map();
  for (const c of booked) {
    const t = normalizeTopic(c.topic);
    topicMap.set(t, (topicMap.get(t) || 0) + 1);
  }
  const topTopics = [...topicMap.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // ── Bookings over time ──
  const dateMap = new Map();
  for (const c of booked) {
    if (!c.date) continue;
    dateMap.set(c.date, (dateMap.get(c.date) || 0) + 1);
  }
  const bookingsOverTime = [...dateMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // ── Slot occupancy (mean across the window) ──
  let totalCapacity = 0;
  let totalParticipants = 0;
  for (const s of slotsInWindow) {
    totalCapacity += s.maxParticipants || 1;
    totalParticipants += s.currentParticipants || 0;
  }
  const occupancyPercent =
    totalCapacity > 0
      ? Math.round((totalParticipants / totalCapacity) * 100)
      : 0;

  // ── Cancellations: by who, and by lead-time bucket ──
  // Two parallel breakdowns the UI can stack on the same axis:
  //   - byWho: { student, professor, unknown } simple counts.
  //   - byLeadTime: bucketed counts × cancelledBy → stacked bar chart.
  const cancelByWho = { student: 0, professor: 0, unknown: 0 };
  const leadBuckets = [
    ">48h",
    "24-48h",
    "<24h",
    "same-day",
    "after-start",
    "unknown",
  ];
  // Initialise so the chart axis is stable even when a bucket is empty.
  const leadBreakdown = {};
  for (const b of leadBuckets) {
    leadBreakdown[b] = { bucket: b, student: 0, professor: 0, unknown: 0 };
  }
  for (const c of cancelled) {
    const who =
      c.cancelledBy === "professor"
        ? "professor"
        : c.cancelledBy === "student"
        ? "student"
        : "unknown";
    cancelByWho[who] += 1;
    const bucket = leadTimeBucket(c.cancellationLeadHours);
    leadBreakdown[bucket][who] += 1;
  }
  const cancellationLeadTime = leadBuckets.map((b) => leadBreakdown[b]);

  // ── Feedback rollups ──
  // Student rating: only the rows where studentFeedback was actually
  // submitted (sf.submittedAt != null) — counting "no feedback yet" as a
  // 0 would slam the average. No-show rate is professorFeedback.attended,
  // counted as { yes, late, no, total }.
  let ratingSum = 0;
  let ratingCount = 0;
  const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let attendedYes = 0;
  let attendedLate = 0;
  let attendedNo = 0;
  let attendanceTotal = 0;
  for (const c of bookingsInWindow) {
    const sf = c.studentFeedback;
    if (sf && Number.isInteger(sf.rating)) {
      ratingSum += sf.rating;
      ratingCount += 1;
      if (ratingDistribution[sf.rating] != null) {
        ratingDistribution[sf.rating] += 1;
      }
    }
    const pf = c.professorFeedback;
    if (pf && pf.attended) {
      attendanceTotal += 1;
      if (pf.attended === "yes") attendedYes += 1;
      else if (pf.attended === "late") attendedLate += 1;
      else if (pf.attended === "no") attendedNo += 1;
    }
  }
  const averageRating =
    ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 100) / 100 : null;
  const noShowRate =
    attendanceTotal > 0
      ? Math.round((attendedNo / attendanceTotal) * 1000) / 10
      : null;

  // ── Waitlist demand ──
  // Cheap KPI: how many active waitlist rows are sitting on full slots.
  // We count by consultationType for the type-aware "students waiting on
  // exam-prep slots" UX.
  const today = isoDate(0);
  const waitlistDemandByType = { general: 0, exam_prep: 0, thesis: 0 };
  let waitlistDemandTotal = 0;
  for (const w of waitlistRows) {
    if (w.date && w.date < today) continue; // expired waitlist row
    const t = normalizeConsultationType(w.consultationType);
    waitlistDemandByType[t] = (waitlistDemandByType[t] || 0) + 1;
    waitlistDemandTotal += 1;
  }

  // ── Upcoming bookings in next 7 days (always counted vs today, ignores
  //     the `range` filter so the card always reflects "what's coming up"). ──
  const next7 = isoDate(7);
  const upcomingNext7Days = allBookings.filter(
    (c) =>
      c.status !== "cancelled" && c.date >= today && c.date <= next7
  ).length;

  return {
    totals: {
      totalSlots,
      totalBookings,
      cancelledBookings,
      studentsServed,
      freeSlots,
      bookedSlots,
      groupSessions,
      individualSessions,
      occupancyPercent,
      upcomingNext7Days,
      averageRating,
      ratingCount,
      noShowRate,
      attendanceTotal,
      waitlistDemandTotal,
    },
    bookingsByType,
    bookingsBySubject,
    topTopics,
    bookingsOverTime,
    groupVsIndividual: [
      { type: "Individual", count: individualSessions },
      { type: "Group", count: groupSessions },
    ],
    slotOccupancy: [
      { type: "Free", count: freeSlots },
      { type: "Booked", count: bookedSlots },
    ],
    cancellations: {
      total: cancelledBookings,
      byWho: cancelByWho,
      byLeadTime: cancellationLeadTime,
    },
    feedback: {
      averageRating,
      ratingCount,
      ratingDistribution: Object.entries(ratingDistribution).map(
        ([rating, count]) => ({ rating: Number(rating), count })
      ),
      noShowRate,
      attendance: {
        yes: attendedYes,
        late: attendedLate,
        no: attendedNo,
        total: attendanceTotal,
      },
    },
    waitlist: {
      total: waitlistDemandTotal,
      byType: Object.entries(waitlistDemandByType).map(([type, count]) => ({
        type,
        label: CONSULTATION_TYPE_LABEL[type] || type,
        count,
      })),
    },
  };
}

// Derive the unique consultation-type values that have actually been used
// across the slot + consultation set. Returns the canonical enum keys so
// the frontend can render localised labels.
function uniqueTypes(slots, consultations) {
  const set = new Set();
  for (const s of slots) set.add(normalizeConsultationType(s.consultationType));
  for (const c of consultations) {
    if (c.SK !== "METADATA") continue;
    set.add(normalizeConsultationType(c.consultationType));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ─────────────────────────────────────────────────────────────────────────
// Loaders — hide the DDB query shape from the routing layer.
// ─────────────────────────────────────────────────────────────────────────

async function loadProfessorData(professorId) {
  const profItems = await queryPk(`PROFESSOR#${professorId}`);
  const slots = profItems.filter((i) => i.SK && i.SK.startsWith("SLOT#"));
  const waitlistRows = profItems.filter(
    (i) => i.SK && i.SK.startsWith("WAITLIST#")
  );
  const consultations = await queryGsi1(`PROFESSOR#${professorId}`);
  return { slots, consultations, waitlistRows };
}

// ─────────────────────────────────────────────────────────────────────────
// AI insight — Bedrock Nova Lite (cached for 1h per (caller, filter) hash)
// ─────────────────────────────────────────────────────────────────────────
//
// We hand Nova Lite the totals + cancellation breakdown + top subject +
// rating, and ask for 2-3 short sentences with specific numbers. Output is
// cached on the caller's user row (`AI_INSIGHT#{hash}`) so every chart
// re-render doesn't burn another Bedrock invocation. The `nocache=1` query
// param bypasses the cache and re-runs the model — wired up to a small
// "Regenerate" link in the UI.
const INSIGHT_TTL_SECONDS = 60 * 60; // 1 hour
const INSIGHT_MAX_TOKENS = 160;
const INSIGHT_MODEL_ID = process.env.BEDROCK_MODEL_ID;

function hashFilter(scope, callerId, filters, range) {
  const blob = JSON.stringify({
    scope,
    callerId,
    professorId: filters.professorId || null,
    consultationType: filters.consultationType || "all",
    group: filters.group || "all",
    rangeLabel: range.label,
    rangeFrom: range.from || null,
    rangeTo: range.to || null,
  });
  return crypto.createHash("sha256").update(blob).digest("hex").slice(0, 16);
}

function buildInsightPrompt(scope, data) {
  const t = data.totals || {};
  const c = data.cancellations || { byWho: {}, total: 0 };
  const f = data.feedback || {};
  const topSubject = (data.bookingsBySubject || [])[0];
  const topType = (data.bookingsByType || [])[0];

  const lines = [
    `Scope: ${scope}.`,
    `Bookings (in window): ${t.totalBookings || 0}.`,
    `Cancellations: ${t.cancelledBookings || 0} (students=${c.byWho.student || 0}, professors=${c.byWho.professor || 0}).`,
    `Slots: ${t.totalSlots || 0}, occupancy ${t.occupancyPercent || 0}%, upcoming next 7d ${t.upcomingNext7Days || 0}.`,
    topType
      ? `Most-booked type: ${topType.label || topType.type} (${topType.count}).`
      : "No type breakdown yet.",
    topSubject
      ? `Top subject: ${String(topSubject.subject || "").slice(0, 100)} (${topSubject.count}).`
      : "No subject breakdown yet.",
    f.averageRating != null
      ? `Average student rating: ${f.averageRating} from ${f.ratingCount} responses.`
      : "No student ratings submitted yet.",
    f.noShowRate != null
      ? `No-show rate: ${f.noShowRate}% across ${(f.attendance || {}).total || 0} marked sessions.`
      : "No attendance marks submitted yet.",
    `Waitlist demand: ${(data.waitlist || {}).total || 0} students waiting on full slots.`,
  ];
  return lines.join(" ");
}

async function generateInsight({ scope, callerId, filters, range, data, log }) {
  if (!INSIGHT_MODEL_ID) {
    return null;
  }

  const hash = hashFilter(scope, callerId, filters, range);
  const cacheKey = { PK: `USER#${callerId}`, SK: `AI_INSIGHT#${hash}` };

  if (!filters.nocache) {
    try {
      const cached = await getItem(cacheKey.PK, cacheKey.SK);
      if (cached && cached.text) {
        return { text: cached.text, cached: true, hash };
      }
    } catch (e) {
      log?.warn?.("insight_cache_read_failed", { message: e.message });
    }
  }

  const prompt = buildInsightPrompt(scope, data);
  const system = [
    {
      text:
        "You write short analytics summaries for a university consultations " +
        "dashboard. Reply with 2-3 short English sentences. State the most " +
        "actionable observation. Always cite specific numbers from the data. " +
        "No greeting, no sign-off, no markdown bullet lists, no bold. " +
        "If the dataset is too thin (e.g. zero bookings, zero feedback), " +
        "say so plainly.",
    },
  ];
  const messages = [
    {
      role: "user",
      content: [{ text: prompt }],
    },
  ];

  let text = "";
  try {
    const resp = await bedrockClient.send(
      new ConverseCommand({
        modelId: INSIGHT_MODEL_ID,
        system,
        messages,
        inferenceConfig: { maxTokens: INSIGHT_MAX_TOKENS, temperature: 0.2 },
      })
    );
    const blocks = resp?.output?.message?.content || [];
    text = blocks.map((b) => b.text || "").join("").trim();
  } catch (e) {
    log?.warn?.("insight_invoke_failed", { message: e.message, name: e.name });
    return null;
  }

  if (!text) return null;

  // Persist with TTL so a stale row auto-evicts after an hour without us
  // having to schedule a sweep job.
  try {
    await putItem({
      PK: cacheKey.PK,
      SK: cacheKey.SK,
      text,
      generatedAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + INSIGHT_TTL_SECONDS,
      filters,
      rangeLabel: range.label,
    });
  } catch (e) {
    log?.warn?.("insight_cache_write_failed", { message: e.message });
  }

  return { text, cached: false, hash };
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

async function handleProfessorRoute(event, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  // Students never see analytics. Admins are allowed to call this endpoint
  // and target any professor via ?professorId= for cross-checking.
  if (caller.role !== "professor" && caller.role !== "admin") {
    log.warn("forbidden_role", { stage: "authorize", role: caller.role });
    return unauthorized();
  }

  const qs = event.queryStringParameters || {};
  const targetProfessorId =
    caller.role === "admin" && qs.professorId
      ? qs.professorId
      : caller.userId;

  if (caller.role === "professor" && qs.professorId && qs.professorId !== caller.userId) {
    log.warn("forbidden_cross_professor", {
      stage: "authorize",
      requested: qs.professorId,
      caller: caller.userId,
    });
    return unauthorized();
  }

  log.withContext({ targetProfessorId });

  const range = resolveRange(qs.range);
  const filters = {
    consultationType: qs.type || "all",
    group: qs.group || "all",
    nocache: qs.nocache === "1",
  };

  let slots;
  let consultations;
  let waitlistRows;
  try {
    ({ slots, consultations, waitlistRows } = await loadProfessorData(
      targetProfessorId
    ));
  } catch (e) {
    log.error(e, { stage: "loadProfessorData", targetProfessorId });
    throw e;
  }

  const data = buildAnalytics({
    slots,
    consultations,
    waitlistRows,
    range,
    filters,
  });

  const insight = await generateInsight({
    scope: "professor",
    callerId: caller.userId,
    filters: { ...filters, professorId: targetProfessorId },
    range,
    data,
    log,
  });

  log.end({
    stage: "professor_analytics",
    slotCount: slots.length,
    consultationCount: consultations.length,
    totalBookings: data.totals.totalBookings,
    range: range.label,
    insightCached: insight ? !!insight.cached : null,
  });

  return ok({
    scope: "professor",
    professorId: targetProfessorId,
    range: { from: range.from, to: range.to, applied: range.label },
    filters,
    availableTypes: uniqueTypes(slots, consultations),
    insight,
    ...data,
  });
}

async function handleAdminRoute(event, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "admin") {
    log.warn("forbidden_role", { stage: "authorize", role: caller.role });
    return unauthorized();
  }

  const qs = event.queryStringParameters || {};
  const range = resolveRange(qs.range);
  const filters = {
    consultationType: qs.type || "all",
    group: qs.group || "all",
    professorId: qs.professorId || null,
    nocache: qs.nocache === "1",
  };

  let professors;
  try {
    professors = await listProfessors();
  } catch (e) {
    log.error(e, { stage: "listProfessors" });
    throw e;
  }

  const targets = filters.professorId
    ? professors.filter((p) => p.professorId === filters.professorId)
    : professors;

  // Pull every professor's slots + consultations in parallel. The data set
  // for a single university is small (hundreds of items) so a fan-out of
  // a handful of GetItem-equivalent queries is well within Lambda's reach.
  const perProfessorRaw = await Promise.all(
    targets.map(async (p) => {
      const data = await loadProfessorData(p.professorId);
      return { professor: p, ...data };
    })
  );

  // Flatten everything for the cross-professor aggregation.
  const allSlots = [];
  const allConsultations = [];
  const allWaitlist = [];
  for (const { slots, consultations, waitlistRows } of perProfessorRaw) {
    for (const s of slots) allSlots.push(s);
    for (const c of consultations) allConsultations.push(c);
    for (const w of waitlistRows || []) allWaitlist.push(w);
  }

  const data = buildAnalytics({
    slots: allSlots,
    consultations: allConsultations,
    waitlistRows: allWaitlist,
    range,
    filters,
  });

  // Per-professor leaderboard. Re-run the aggregator per professor so
  // each row reflects the same filters the user picked at the top.
  const perProfessor = perProfessorRaw.map(
    ({ professor, slots, consultations, waitlistRows }) => {
      const local = buildAnalytics({
        slots,
        consultations,
        waitlistRows,
        range,
        filters,
      });
      return {
        professorId: professor.professorId,
        name: professor.name,
        department: professor.department || "",
        totalBookings: local.totals.totalBookings,
        cancelledBookings: local.totals.cancelledBookings,
        studentsServed: local.totals.studentsServed,
        occupancyPercent: local.totals.occupancyPercent,
        groupSessions: local.totals.groupSessions,
        individualSessions: local.totals.individualSessions,
        averageRating: local.totals.averageRating,
        noShowRate: local.totals.noShowRate,
      };
    }
  );

  const topProfessors = [...perProfessor]
    .sort((a, b) => b.totalBookings - a.totalBookings)
    .slice(0, 8);

  // ── By department + by consultation type rollups ── (admin pivot —
  // replaces the awkward "top professors by raw bookings" emphasis with
  // structural views that are less of an incentive minefield).
  const byDeptMap = new Map();
  for (const row of perProfessor) {
    const dept = row.department || "Unspecified";
    const cur = byDeptMap.get(dept) || {
      department: dept,
      totalBookings: 0,
      cancelledBookings: 0,
      studentsServed: 0,
      occupancySum: 0,
      occupancyN: 0,
    };
    cur.totalBookings += row.totalBookings;
    cur.cancelledBookings += row.cancelledBookings;
    cur.studentsServed += row.studentsServed;
    if (Number.isFinite(row.occupancyPercent)) {
      cur.occupancySum += row.occupancyPercent;
      cur.occupancyN += 1;
    }
    byDeptMap.set(dept, cur);
  }
  const byDepartment = [...byDeptMap.values()]
    .map((d) => ({
      department: d.department,
      totalBookings: d.totalBookings,
      cancelledBookings: d.cancelledBookings,
      studentsServed: d.studentsServed,
      occupancyPercent:
        d.occupancyN > 0 ? Math.round(d.occupancySum / d.occupancyN) : 0,
    }))
    .sort((a, b) => b.totalBookings - a.totalBookings);

  // Cross-professor type set (still scoped to the selected professor when
  // filters.professorId is set, since `targets` was already narrowed).
  const availableTypes = uniqueTypes(allSlots, allConsultations);

  const insight = await generateInsight({
    scope: "admin",
    callerId: caller.userId,
    filters,
    range,
    data,
    log,
  });

  log.end({
    stage: "admin_analytics",
    professorCount: targets.length,
    slotCount: allSlots.length,
    consultationCount: allConsultations.length,
    totalBookings: data.totals.totalBookings,
    range: range.label,
    insightCached: insight ? !!insight.cached : null,
  });

  return ok({
    scope: "admin",
    range: { from: range.from, to: range.to, applied: range.label },
    filters,
    availableTypes,
    professors: professors.map((p) => ({
      professorId: p.professorId,
      name: p.name,
      department: p.department,
    })),
    perProfessor,
    topProfessors,
    byDepartment,
    insight,
    ...data,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

exports.handler = async (event, context) => {
  const log = createLogger("analytics", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    if (event.httpMethod !== "GET") {
      log.warn("unsupported_method", { httpMethod: event.httpMethod });
      return badRequest(`unsupported method: ${event.httpMethod}`);
    }

    const path = event.path || "";
    if (path.endsWith("/analytics/professor")) {
      return await handleProfessorRoute(event, log);
    }
    if (path.endsWith("/analytics/admin")) {
      return await handleAdminRoute(event, log);
    }

    log.warn("unknown_path", { path });
    return badRequest(`unknown path: ${path}`);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      httpMethod: event && event.httpMethod,
      path: event && event.path,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
