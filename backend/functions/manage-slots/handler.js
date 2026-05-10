"use strict";

const {
  queryPk,
  queryGsi1,
  putItem,
  getItem,
  updateItem,
  deleteItem,
} = require("/opt/nodejs/db");
const { ok, badRequest, unauthorized, error } = require("/opt/nodejs/response");
const { getCaller } = require("/opt/nodejs/auth");
const { createLogger } = require("/opt/nodejs/logger");
const { cancelConsultation } = require("/opt/nodejs/consultations");

function parseHHMM(s) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!match) throw new Error(`invalid time: ${s}`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error(`invalid time: ${s}`);
  return h * 60 + m;
}

function formatHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Legacy slots (created before we started persisting `durationMinutes`) and
// the seed data are all 30-minute blocks. Use that as the conservative
// fallback when we can't read a duration off the existing item.
const LEGACY_SLOT_DURATION_MIN = 30;

// Allowed values for slot.consultationType. Undefined / unknown values on
// existing rows are coerced back to "general" at read time so back-compat
// requires no migration.
const CONSULTATION_TYPES = new Set(["general", "exam_prep", "thesis"]);
const DEFAULT_CONSULTATION_TYPE = "general";

function normalizeConsultationType(raw) {
  if (raw == null) return DEFAULT_CONSULTATION_TYPE;
  const t = String(raw).trim();
  if (!t) return DEFAULT_CONSULTATION_TYPE;
  return CONSULTATION_TYPES.has(t) ? t : DEFAULT_CONSULTATION_TYPE;
}

// Combine a YYYY-MM-DD + HH:MM into an absolute instant, interpreted as UTC.
// The rest of the codebase already treats `date` as the UTC calendar day
// (see `isoDate` above), so keeping the comparison in UTC keeps things
// internally consistent.
function combineDateTimeUtc(dateStr, timeStr) {
  const [hh, mm] = String(timeStr).split(":").map(Number);
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCHours(hh, mm, 0, 0);
  return d;
}

// Classic half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd).
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function getUnavailableSet(professorId) {
  const items = await queryPk(`PROFESSOR#${professorId}`, "UNAVAILABLE#");
  return new Set(items.map((i) => i.date));
}

// Hard ceiling on the number of dates a single recurrence expansion
// can produce. Bumped from 26 (~6 months weekly) to 60 so multi-day
// patterns like Mon/Wed/Fri can cover ~3 months without truncation,
// while still keeping a typo from mass-writing thousands of items.
const MAX_RECURRENCE_OCCURRENCES = 60;

// One year of safety scanning. Even with a single weekday selected,
// `recurUntil` is already capped to the request — this just bounds the
// `cursor <= recurUntil` walk in case of a malformed input.
const MAX_RECURRENCE_SCAN_DAYS = 366;

// Builds the list of dates a slot block should be created on.
//
//   - Non-recurring submissions return `[date]`.
//   - Recurring submissions WITHOUT a `weekdays` array fall back to the
//     legacy behaviour: weekly on the same weekday as `date`
//     (`date`, `date + 7d`, `date + 14d`, …).
//   - Recurring submissions WITH a non-empty `weekdays` array expand to
//     every matching weekday in `[date, recurUntil]`. The anchor date's
//     weekday does NOT need to be in `weekdays` — that just decides
//     whether the first slot lands on `date` itself or on the next
//     selected weekday after.
//
// `weekdays` is an array of integers 0–6 with the standard JS Date
// convention: 0 = Sunday, 1 = Monday, …, 6 = Saturday.
function expandDates(date, recurring, recurUntil, weekdays) {
  if (!recurring) return [date];
  if (!recurUntil || recurUntil < date) return [date];

  const validWeekdays = Array.isArray(weekdays)
    ? weekdays.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)
    : [];

  if (validWeekdays.length === 0) {
    // Legacy "+7d" mode. Kept verbatim so existing callers (chat tools,
    // older clients) keep behaving exactly as before.
    const out = [];
    let cursor = date;
    for (
      let i = 0;
      i < MAX_RECURRENCE_OCCURRENCES && cursor <= recurUntil;
      i++
    ) {
      out.push(cursor);
      cursor = addDaysIso(cursor, 7);
    }
    return out;
  }

  const weekdaySet = new Set(validWeekdays);
  const out = [];
  let cursor = date;
  let scanned = 0;
  while (
    cursor <= recurUntil &&
    out.length < MAX_RECURRENCE_OCCURRENCES &&
    scanned < MAX_RECURRENCE_SCAN_DAYS
  ) {
    const dow = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (weekdaySet.has(dow)) out.push(cursor);
    cursor = addDaysIso(cursor, 1);
    scanned += 1;
  }
  return out;
}

async function createSlots(event, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "professor") {
    log.warn("forbidden_role", { stage: "authorize" });
    return unauthorized();
  }

  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId || professorId !== caller.userId) {
    log.warn("forbidden_id_mismatch", { stage: "authorize", professorId });
    return unauthorized();
  }
  log.withContext({ professorId });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    log.warn("invalid_json", { stage: "parse_body", message: e.message });
    return badRequest("invalid JSON body");
  }

  const {
    date,
    startTime,
    endTime,
    slotDurationMinutes,
    maxParticipants,
    recurring,
    recurUntil,
    weekdays: rawWeekdays,
    consultationType: rawConsultationType,
    subject: rawSubject,
  } = body;

  if (!date || !startTime || !endTime || !maxParticipants) {
    log.warn("missing_fields", {
      stage: "validate_body",
      hasDate: !!date,
      hasStartTime: !!startTime,
      hasEndTime: !!endTime,
      hasMaxParticipants: !!maxParticipants,
    });
    return badRequest(
      "missing required fields: date, startTime, endTime, maxParticipants"
    );
  }
  if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes <= 0) {
    log.warn("invalid_duration", {
      stage: "validate_body",
      slotDurationMinutes,
    });
    return badRequest("slotDurationMinutes must be a positive integer");
  }

  // Normalize the new consultationType + subject fields. Both are optional
  // for back-compat (older clients still POST without them), but exam_prep
  // blocks REQUIRE a subject — a "midterm prep" slot without a subject is
  // useless to the student picking it.
  const consultationType = normalizeConsultationType(rawConsultationType);
  const subject =
    typeof rawSubject === "string" ? rawSubject.trim() : "";
  if (subject.length > 200) {
    log.warn("subject_too_long", { stage: "validate_body", subjectLen: subject.length });
    return badRequest("subject must be 200 characters or fewer");
  }
  if (consultationType === "exam_prep" && !subject) {
    log.warn("exam_prep_missing_subject", { stage: "validate_body" });
    return badRequest(
      "Exam preparation blocks require a subject — pick the course this prep session is for."
    );
  }
  // Thesis slots are 1-on-1 by definition; reject any other capacity so a
  // misconfigured form can't publish a "group thesis" slot.
  if (consultationType === "thesis" && maxParticipants !== 1) {
    log.warn("thesis_invalid_capacity", {
      stage: "validate_body",
      maxParticipants,
    });
    return badRequest(
      "Thesis slots are always 1-on-1; capacity must be 1."
    );
  }

  let startMin;
  let endMin;
  try {
    startMin = parseHHMM(startTime);
    endMin = parseHHMM(endTime);
  } catch (e) {
    log.warn("invalid_time", { stage: "parseHHMM", message: e.message });
    return badRequest(e.message);
  }
  if (endMin <= startMin) {
    log.warn("invalid_range", {
      stage: "validate_body",
      startTime,
      endTime,
    });
    return badRequest("endTime must be after startTime");
  }

  // Past-time guard. Only the first occurrence needs to be checked: every
  // recurrence is +7d from `date`, so if the first start is in the future
  // they all are.
  const firstStart = combineDateTimeUtc(date, startTime);
  if (Number.isNaN(firstStart.getTime()) || firstStart.getTime() <= Date.now()) {
    log.warn("past_start", {
      stage: "validate_body",
      date,
      startTime,
      now: new Date().toISOString(),
    });
    return badRequest("You cannot create consultation slots in the past.");
  }

  if (recurring && (!recurUntil || recurUntil < date)) {
    log.warn("invalid_recurUntil", {
      stage: "validate_body",
      date,
      recurUntil,
    });
    return badRequest(
      "when recurring=true, recurUntil must be >= date"
    );
  }

  // Optional weekdays array — ints 0–6 (0=Sun..6=Sat). When omitted /
  // empty AND recurring=true we keep the legacy weekly-on-the-same-
  // weekday behaviour so older clients (chat tools, third-party scripts)
  // don't have to change. When provided we validate it strictly so a
  // typo doesn't silently fall back to legacy mode.
  let weekdays = null;
  if (rawWeekdays != null) {
    if (!Array.isArray(rawWeekdays)) {
      log.warn("invalid_weekdays_type", {
        stage: "validate_body",
        rawWeekdays,
      });
      return badRequest("weekdays must be an array of integers between 0 and 6");
    }
    const allValid = rawWeekdays.every(
      (w) => Number.isInteger(w) && w >= 0 && w <= 6
    );
    if (!allValid) {
      log.warn("invalid_weekdays_values", {
        stage: "validate_body",
        rawWeekdays,
      });
      return badRequest("weekdays must be an array of integers between 0 and 6");
    }
    if (recurring && rawWeekdays.length === 0) {
      log.warn("empty_weekdays", { stage: "validate_body" });
      return badRequest(
        "Pick at least one weekday to repeat on, or turn off the recurrence."
      );
    }
    weekdays = rawWeekdays;
  }

  const dates = expandDates(date, !!recurring, recurUntil, weekdays);
  log.info("dates_resolved", {
    recurring: !!recurring,
    recurUntil: recurUntil || null,
    weekdays: weekdays || null,
    dates,
  });

  // Pull unavailable days once and skip those across the whole expansion.
  let unavailable;
  try {
    unavailable = await getUnavailableSet(professorId);
  } catch (e) {
    log.error(e, { stage: "load_unavailable", professorId });
    throw e;
  }

  // Overlap guard. We pull every existing SLOT for this professor (one Query
  // per request — slot counts are small per-professor, so this is cheap) and
  // bucket them by date. For each candidate date in the expansion we then
  // check the new block [startMin, endMin) against every existing slot's
  // [start, start + duration) window. This blocks partial, full, and exact
  // duplicates in one shot.
  let existingSlots;
  try {
    existingSlots = await queryPk(`PROFESSOR#${professorId}`, "SLOT#");
  } catch (e) {
    log.error(e, { stage: "load_existing_slots", professorId });
    throw e;
  }

  const existingByDate = new Map();
  for (const s of existingSlots) {
    if (!s.date || !s.time) continue;
    if (!existingByDate.has(s.date)) existingByDate.set(s.date, []);
    existingByDate.get(s.date).push(s);
  }

  for (const d of dates) {
    if (unavailable.has(d)) continue;
    const existing = existingByDate.get(d) || [];
    for (const s of existing) {
      let eStart;
      try {
        eStart = parseHHMM(s.time);
      } catch (_err) {
        continue;
      }
      const eDur = Number.isInteger(s.durationMinutes)
        ? s.durationMinutes
        : LEGACY_SLOT_DURATION_MIN;
      const eEnd = eStart + eDur;
      if (rangesOverlap(startMin, endMin, eStart, eEnd)) {
        log.warn("overlap_detected", {
          stage: "validate_overlap",
          date: d,
          newRange: `${startTime}-${endTime}`,
          existing: { time: s.time, durationMinutes: eDur, sk: s.SK },
        });
        return badRequest(
          "This time range overlaps with existing consultation slots."
        );
      }
    }
  }

  const created = [];
  const skipped = [];

  try {
    for (const d of dates) {
      if (unavailable.has(d)) {
        skipped.push({ date: d, reason: "unavailable" });
        continue;
      }
      for (let t = startMin; t < endMin; t += slotDurationMinutes) {
        const time = formatHHMM(t);
        const sk = `SLOT#${d}T${time}`;
        await putItem({
          PK: `PROFESSOR#${professorId}`,
          SK: sk,
          GSI1PK: "SLOT_STATUS#available",
          GSI1SK: `PROFESSOR#${professorId}#DATE#${d}T${time}`,
          professorId,
          date: d,
          time,
          status: "available",
          maxParticipants,
          currentParticipants: 0,
          durationMinutes: slotDurationMinutes,
          consultationType,
          subject: subject || undefined,
          createdAt: new Date().toISOString(),
        });
        created.push(sk);
      }
    }
  } catch (e) {
    log.error(e, {
      stage: "putItem_loop",
      professorId,
      dates,
      createdCount: created.length,
      lastSk: created[created.length - 1],
    });
    throw e;
  }

  log.end({
    stage: "createSlots",
    createdCount: created.length,
    skippedCount: skipped.length,
    dates: dates.length,
  });
  return ok({ created, skipped });
}

async function listSlots(event, log) {
  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId) {
    log.warn("missing_professor_id", { stage: "validate_path" });
    return badRequest("missing professor id");
  }
  log.withContext({ professorId });

  const qs = event.queryStringParameters || {};
  const dateFrom = qs.from || isoDate(0);
  const dateTo = qs.to || isoDate(7);

  let items;
  try {
    items = await queryPk(`PROFESSOR#${professorId}`, "SLOT#");
  } catch (e) {
    log.error(e, {
      stage: "queryPk_slots",
      professorId,
      dateFrom,
      dateTo,
    });
    throw e;
  }

  const lower = `SLOT#${dateFrom}`;
  const upper = `SLOT#${dateTo}T99:99`;

  // Return EVERY slot in the date window (available + booked + full) so the
  // UI can render distinct states. Filtering out "full" here was the source
  // of the confusing "1/1 for everything" — students literally couldn't see
  // the difference between a fresh slot and one that someone had booked.
  const filtered = items.filter((i) => i.SK >= lower && i.SK <= upper);

  // For booked/full slots, fetch consultation topics so the UI can display
  // what students want to discuss instead of a generic "—". `slot.topic` is
  // gone — topics are exclusively driven by the consultations that landed
  // on the slot, not anything the professor sets at publish time.
  const bookedSlots = filtered.filter((s) => (s.currentParticipants || 0) > 0);
  const topicsBySlotSK = new Map();

  if (bookedSlots.length > 0) {
    await Promise.all(
      bookedSlots.map(async (s) => {
        const dateTime = s.SK.replace(/^SLOT#/, "");
        const consultations = await queryGsi1(
          `PROFESSOR#${professorId}`,
          `DATE#${dateTime}`
        );
        const topics = [
          ...new Set(
            consultations
              .filter((c) => c.SK === "METADATA" && c.status !== "cancelled" && c.topic)
              .map((c) => c.topic)
          ),
        ];
        if (topics.length > 0) topicsBySlotSK.set(s.SK, topics);
      })
    );
  }

  log.end({
    stage: "listSlots",
    dateFrom,
    dateTo,
    scanned: items.length,
    returned: filtered.length,
  });

  return ok({
    slots: filtered.map((i) => {
      const topics = topicsBySlotSK.get(i.SK) || [];
      return {
        slotId: i.SK,
        date: i.date,
        time: i.time,
        topic: topics.length > 0 ? topics.join(" · ") : "",
        topics,
        maxParticipants: i.maxParticipants,
        currentParticipants: i.currentParticipants || 0,
        status: i.status,
        durationMinutes: Number.isInteger(i.durationMinutes)
          ? i.durationMinutes
          : LEGACY_SLOT_DURATION_MIN,
        consultationType: normalizeConsultationType(i.consultationType),
        subject: i.subject || "",
      };
    }),
  });
}

async function updateSlotCapacity(event, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "professor") {
    log.warn("forbidden_role", { stage: "authorize" });
    return unauthorized();
  }

  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId || professorId !== caller.userId) {
    log.warn("forbidden_id_mismatch", { stage: "authorize", professorId });
    return unauthorized();
  }

  const rawSlotSK = event.pathParameters && event.pathParameters.slotSK;
  if (!rawSlotSK) {
    log.warn("missing_slotSK", { stage: "validate_path" });
    return badRequest("missing slotSK path parameter");
  }
  const slotSK = decodeURIComponent(rawSlotSK);
  if (!slotSK.startsWith("SLOT#")) {
    log.warn("invalid_slotSK", { stage: "validate_path", slotSK });
    return badRequest("slotSK must start with SLOT#");
  }
  log.withContext({ professorId, slotSK });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    log.warn("invalid_json", { stage: "parse_body", message: e.message });
    return badRequest("invalid JSON body");
  }

  const { maxParticipants } = body;
  if (!Number.isInteger(maxParticipants) || maxParticipants <= 0) {
    log.warn("invalid_maxParticipants", { stage: "validate_body", maxParticipants });
    return badRequest("maxParticipants must be a positive integer");
  }

  let slot;
  try {
    slot = await getItem(`PROFESSOR#${professorId}`, slotSK);
  } catch (e) {
    log.error(e, { stage: "getItem_slot" });
    throw e;
  }
  if (!slot) {
    log.warn("slot_not_found", { stage: "getItem_slot", slotSK });
    return badRequest("Slot not found");
  }

  const currentMax = slot.maxParticipants || 1;
  if (maxParticipants <= currentMax) {
    log.warn("capacity_not_increased", { stage: "validate_body", currentMax, maxParticipants });
    return badRequest(
      `maxParticipants must be greater than the current value (${currentMax}). You can only add more spaces, not remove them.`
    );
  }

  const currentCount = slot.currentParticipants || 0;
  const newStatus = currentCount >= maxParticipants ? "full" : "available";

  try {
    await updateItem(`PROFESSOR#${professorId}`, slotSK, {
      maxParticipants,
      status: newStatus,
      GSI1PK: `SLOT_STATUS#${newStatus}`,
    });
  } catch (e) {
    log.error(e, { stage: "updateItem_slot" });
    throw e;
  }

  log.end({ stage: "updateSlotCapacity", slotSK, maxParticipants, newStatus });
  return ok({ slotSK, maxParticipants, status: newStatus });
}

// DELETE /professors/{id}/slots/{slotSK}
//
// Removes a single slot row. Only allowed when:
//   - caller is the slot's owning professor, AND
//   - the slot has no active bookings (`currentParticipants === 0`).
//
// We deliberately do NOT cascade into consultations here. If the professor
// wants to wipe a day that has bookings, they must use cancelDay below
// (which cancels each consultation, notifies the students, and then deletes
// the freed slot).
async function deleteSlot(event, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "professor") {
    log.warn("forbidden_role", { stage: "authorize" });
    return unauthorized();
  }

  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId || professorId !== caller.userId) {
    log.warn("forbidden_id_mismatch", { stage: "authorize", professorId });
    return unauthorized();
  }

  const rawSlotSK = event.pathParameters && event.pathParameters.slotSK;
  if (!rawSlotSK) {
    log.warn("missing_slotSK", { stage: "validate_path" });
    return badRequest("missing slotSK path parameter");
  }
  const slotSK = decodeURIComponent(rawSlotSK);
  if (!slotSK.startsWith("SLOT#")) {
    log.warn("invalid_slotSK", { stage: "validate_path", slotSK });
    return badRequest("slotSK must start with SLOT#");
  }
  log.withContext({ professorId, slotSK });

  let slot;
  try {
    slot = await getItem(`PROFESSOR#${professorId}`, slotSK);
  } catch (e) {
    log.error(e, { stage: "getItem_slot" });
    throw e;
  }
  if (!slot) {
    // Idempotent: deleting a slot that's already gone is a success.
    log.end({ stage: "deleteSlot", slotSK, alreadyGone: true });
    return ok({ deleted: true, slotSK, alreadyGone: true });
  }

  if ((slot.currentParticipants || 0) > 0) {
    log.warn("slot_has_bookings", {
      stage: "authorize",
      currentParticipants: slot.currentParticipants,
    });
    return badRequest(
      "This slot has active bookings. Cancel them first, or use 'Cancel whole day' to wipe the day."
    );
  }

  try {
    await deleteItem(`PROFESSOR#${professorId}`, slotSK);
  } catch (e) {
    log.error(e, { stage: "deleteItem_slot" });
    throw e;
  }

  log.end({ stage: "deleteSlot", slotSK });
  return ok({ deleted: true, slotSK });
}

// POST /professors/{id}/slots/cancel-day
// Body: { date: "YYYY-MM-DD" }
//
// "Wipe this day clean" action used by the professor's Availability page.
// For every slot the professor published on `date`:
//   - if it has bookings, cancel each consultation (this notifies the
//     student via the existing cancellation pathway in cancelConsultation)
//   - then delete the slot row itself
//
// Returns counts so the UI can show "Cancelled X bookings, freed Y slots".
async function cancelDay(event, context, log) {
  let caller;
  try {
    caller = getCaller(event);
  } catch (e) {
    log.error(e, { stage: "auth_getCaller" });
    return unauthorized();
  }
  log.withContext({ userId: caller.userId, role: caller.role });

  if (caller.role !== "professor") {
    log.warn("forbidden_role", { stage: "authorize" });
    return unauthorized();
  }

  const professorId = event.pathParameters && event.pathParameters.id;
  if (!professorId || professorId !== caller.userId) {
    log.warn("forbidden_id_mismatch", { stage: "authorize", professorId });
    return unauthorized();
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    log.warn("invalid_json", { stage: "parse_body", message: e.message });
    return badRequest("invalid JSON body");
  }

  const { date } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    log.warn("invalid_date", { stage: "validate_body", date });
    return badRequest("date is required and must be YYYY-MM-DD");
  }
  log.withContext({ professorId, date });

  // Pull every slot for the day so we know what to wipe.
  let slots;
  try {
    slots = await queryPk(`PROFESSOR#${professorId}`, `SLOT#${date}`);
  } catch (e) {
    log.error(e, { stage: "queryPk_slots", professorId, date });
    throw e;
  }

  if (slots.length === 0) {
    log.end({ stage: "cancelDay", date, slots: 0 });
    return ok({ cancelled: 0, deleted: 0, slots: 0 });
  }

  // Pull every consultation row tied to this professor + date so we can
  // cancel each one (fan-out via the per-professor GSI1).
  let consultations;
  try {
    consultations = await queryGsi1(
      `PROFESSOR#${professorId}`,
      `DATE#${date}`
    );
  } catch (e) {
    log.error(e, { stage: "queryGsi1_consultations", professorId, date });
    throw e;
  }

  const active = consultations.filter(
    (c) => c.SK === "METADATA" && c.status !== "cancelled"
  );

  let cancelledCount = 0;
  // Sequential to keep the per-slot decrement in cancelConsultation simple.
  // The day usually has a handful of bookings, so this isn't a hot path.
  // notifyWaitlist=false because the slot itself is about to be deleted —
  // pinging "seat opened" at a student would be a lie.
  for (const c of active) {
    try {
      const res = await cancelConsultation(c.consultationId, caller.userId, {
        notifyWaitlist: false,
      });
      if (res && res.cancelled && !res.alreadyCancelled) cancelledCount += 1;
    } catch (e) {
      log.warn("cancel_failed", {
        stage: "cancelConsultation",
        consultationId: c.consultationId,
        message: e.message,
      });
      // Keep going — partial cancellation is still better than aborting.
    }
  }

  let deletedCount = 0;
  for (const s of slots) {
    try {
      await deleteItem(`PROFESSOR#${professorId}`, s.SK);
      deletedCount += 1;
    } catch (e) {
      log.warn("delete_failed", {
        stage: "deleteItem_slot",
        slotSK: s.SK,
        message: e.message,
      });
    }
  }

  log.end({
    stage: "cancelDay",
    date,
    slots: slots.length,
    cancelled: cancelledCount,
    deleted: deletedCount,
  });
  return ok({
    date,
    cancelled: cancelledCount,
    deleted: deletedCount,
    slots: slots.length,
  });
}

exports.handler = async (event, context) => {
  const log = createLogger("manage-slots", event, context);
  log.start();

  try {
    if (event.httpMethod === "OPTIONS") {
      log.end({ preflight: true });
      return ok({});
    }

    // POST splits two ways: a sub-resource path "/cancel-day" (whole-day
    // wipe) vs the bare collection (create slots).
    if (event.httpMethod === "POST") {
      const path = event.path || event.resource || "";
      if (path.endsWith("/cancel-day")) {
        return await cancelDay(event, context, log);
      }
      return await createSlots(event, log);
    }
    if (event.httpMethod === "GET") return await listSlots(event, log);
    if (event.httpMethod === "PATCH") return await updateSlotCapacity(event, log);
    if (event.httpMethod === "DELETE") return await deleteSlot(event, log);

    log.warn("unsupported_method", {
      stage: "route",
      httpMethod: event.httpMethod,
    });
    return badRequest(`unsupported method: ${event.httpMethod}`);
  } catch (e) {
    log.error(e, {
      stage: "handler_unhandled",
      httpMethod: event && event.httpMethod,
      path: event && event.path,
    });
    return error(`Internal error (requestId=${context.awsRequestId})`);
  }
};
