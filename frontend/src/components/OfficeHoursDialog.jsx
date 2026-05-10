import { useEffect, useMemo, useRef, useState } from "react";
import { createSlots } from "../api.js";
import styles from "./OfficeHoursDialog.module.css";

// ── Office-hours publish dialog ─────────────────────────────────────
// The single creation surface for new office-hour blocks. Opened from
// the Calendar page either via the toolbar `+ Add office hours` button
// or by clicking an empty time cell (which prefills date + start time).
//
// All slot-shape decisions (block type, recurrence, capacity) live in
// here so the calendar grid stays focused on visualisation.

const LEGACY_SLOT_DURATION_MIN = 30;

function isoOffset(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

// Same hard caps the backend uses so the UI preview matches what
// actually gets published. Bumped to 60 occurrences when this file was
// updated to support multi-weekday recurrence (Mon/Wed/Fri patterns).
const MAX_RECURRENCE_OCCURRENCES = 60;
const MAX_RECURRENCE_SCAN_DAYS = 366;

// Mirror the backend's recurrence expansion so the UI rejects the same
// dates the server would. Three modes:
//   - non-recurring  → [date]
//   - recurring, no weekdays  → legacy weekly-on-the-same-weekday
//   - recurring, weekdays set → every matching weekday in the range
function expandDates(date, recurring, recurUntil, weekdays) {
  if (!recurring) return [date];
  if (!recurUntil || recurUntil < date) return [date];

  const validWeekdays = Array.isArray(weekdays)
    ? weekdays.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)
    : [];

  if (validWeekdays.length === 0) {
    const out = [];
    const start = new Date(`${date}T00:00:00Z`);
    const end = new Date(`${recurUntil}T00:00:00Z`);
    for (let i = 0; i < MAX_RECURRENCE_OCCURRENCES; i++) {
      const cursor = new Date(start);
      cursor.setUTCDate(cursor.getUTCDate() + i * 7);
      if (cursor > end) break;
      out.push(cursor.toISOString().slice(0, 10));
    }
    return out;
  }

  const set = new Set(validWeekdays);
  const out = [];
  const cursor = new Date(`${date}T00:00:00Z`);
  const end = new Date(`${recurUntil}T00:00:00Z`);
  let scanned = 0;
  while (
    cursor <= end &&
    out.length < MAX_RECURRENCE_OCCURRENCES &&
    scanned < MAX_RECURRENCE_SCAN_DAYS
  ) {
    if (set.has(cursor.getUTCDay())) {
      out.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    scanned += 1;
  }
  return out;
}

// Local-time weekday for a "YYYY-MM-DD" string. Used to seed the
// weekday picker from the chosen date and to render the anchor hint.
// Local interpretation matches the rest of the calendar UI.
function weekdayOfDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getDay();
}

// Monday-first ordering, matching the calendar grid the dialog opens
// over. The `value` is the standard JS getDay() integer (0=Sun..6=Sat)
// so the array round-trips cleanly through the API.
const WEEKDAY_OPTIONS = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
];

// Snap an arbitrary "HH:MM" prefill to the nearest 30-min grid line so
// click-to-create doesn't produce odd 14:07 starts when the user taps a
// cell mid-row.
function snapToHalfHour(hhmm) {
  const min = parseHHMM(hhmm);
  if (min == null) return hhmm;
  const snapped = Math.round(min / 30) * 30;
  const clamped = Math.max(0, Math.min(snapped, 23 * 60 + 30));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function defaultEndFor(start) {
  const min = parseHHMM(start);
  if (min == null) return start;
  const next = Math.min(min + 60, 23 * 60 + 30);
  const h = Math.floor(next / 60);
  const m = next % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TYPE_PRESETS = {
  general: { maxParticipants: 1 },
  exam_prep: { maxParticipants: 5 },
  thesis: { maxParticipants: 1 },
};

const TYPE_OPTIONS = [
  {
    value: "general",
    label: "General",
    hint: "Regular office-hour consultations.",
  },
  {
    value: "exam_prep",
    label: "Exam prep",
    hint: "Group session for an upcoming exam.",
  },
  {
    value: "thesis",
    label: "Thesis",
    hint: "1-on-1 thesis mentorship.",
  },
];

export default function OfficeHoursDialog({
  open,
  initialDate,
  initialStartTime,
  existingSlots = [],
  mySubjects = [],
  idToken,
  professorId,
  onClose,
  onPublished,
}) {
  const initial = useMemo(() => {
    const d = initialDate || isoOffset(1);
    const st = initialStartTime ? snapToHalfHour(initialStartTime) : "10:00";
    return {
      date: d,
      startTime: st,
      endTime: defaultEndFor(st),
      slotDurationMinutes: 30,
      maxParticipants: 1,
      recurring: false,
      recurUntil: isoOffset(28),
      // Empty until the professor enables recurrence — at which point
      // the toggle handler seeds it with the start date's weekday so
      // the form has a sensible default before they start customising.
      weekdays: [],
      consultationType: "general",
      subject: "",
    };
  }, [initialDate, initialStartTime]);

  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Reset whenever the dialog reopens with new prefill values. Keying on
  // `open` AND the prefill string lets the same dialog instance handle
  // multiple consecutive clicks without state leaking between sessions.
  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setSubmitError("");
  }, [open, initial]);

  // Esc closes; trap a click on the backdrop without dismissing when the
  // user releases inside the dialog (drag-out behaviour).
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock background scroll while the dialog is open so the calendar grid
  // doesn't scroll under the modal when the user taps the form on mobile.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  function update(field, value) {
    setForm((prev) => {
      // Type changes drag a preset along (capacity reset, subject clear)
      // so the form stays internally consistent. Capacity remains
      // overridable for exam_prep — only thesis is hard-locked at 1.
      if (field === "consultationType") {
        const preset = TYPE_PRESETS[value] || {};
        return {
          ...prev,
          consultationType: value,
          ...preset,
          subject: value === "exam_prep" ? prev.subject : "",
        };
      }
      // Enabling recurrence seeds the weekday picker with the start
      // date's weekday so the user doesn't have to immediately also
      // pick days. Disabling it doesn't clear the selection — if the
      // user toggles back on we restore their last set rather than
      // forcing a re-seed.
      if (field === "recurring" && value === true && prev.weekdays.length === 0) {
        const dow = weekdayOfDate(prev.date);
        return {
          ...prev,
          recurring: true,
          weekdays: dow == null ? [] : [dow],
        };
      }
      return { ...prev, [field]: value };
    });
  }

  // Toggle a weekday in/out of the selection. We don't enforce a
  // minimum here (validate() catches the empty case on submit) so the
  // user can rearrange chips freely without the UI fighting them.
  function toggleWeekday(value) {
    setForm((prev) => {
      const set = new Set(prev.weekdays);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...prev, weekdays: [...set].sort((a, b) => a - b) };
    });
  }

  const minStartTime = useMemo(() => {
    if (form.date !== isoOffset(0)) return undefined;
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 1);
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }, [form.date]);

  const slotsPerDay = useMemo(() => {
    const startMin = parseHHMM(form.startTime) ?? 0;
    const endMin = parseHHMM(form.endTime) ?? 0;
    const dur = form.slotDurationMinutes || 0;
    if (!dur || endMin <= startMin) return 0;
    return Math.floor((endMin - startMin) / dur);
  }, [form]);

  // Walk the same expansion the backend will run so the slot-count
  // preview matches the actual publish, including the multi-weekday
  // case ("Mon/Wed/Fri for 8 weeks → 24 days").
  const expectedDays = useMemo(() => {
    const dates = expandDates(
      form.date,
      form.recurring,
      form.recurUntil,
      form.recurring ? form.weekdays : null
    );
    return Math.max(1, dates.length);
  }, [form]);

  const expectedTotal = slotsPerDay * expectedDays;

  // True when the user enabled recurrence but hasn't actually picked
  // any weekdays yet. We treat this as "blocked" — the publish button
  // disables and validate() rejects.
  const recurringWithNoWeekdays =
    form.recurring && form.weekdays.length === 0;

  function validate() {
    const {
      date,
      startTime,
      endTime,
      slotDurationMinutes,
      maxParticipants,
      recurring,
      recurUntil,
      consultationType,
      subject,
    } = form;
    if (!date) return "Pick a date.";
    if (date < isoOffset(0)) return "The date must be today or later.";
    if (!startTime || !endTime) return "Both start and end times are required.";
    if (endTime <= startTime) return "End time must be after start time.";
    if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes < 5) {
      return "Slot length must be at least 5 minutes.";
    }
    if (!Number.isInteger(maxParticipants) || maxParticipants < 1) {
      return "Capacity must be at least 1.";
    }
    if (consultationType === "thesis" && maxParticipants !== 1) {
      return "Thesis slots are always 1-on-1 — capacity must be 1.";
    }
    if (consultationType === "exam_prep" && !(subject || "").trim()) {
      return "Exam prep blocks need a subject.";
    }
    if (recurring) {
      if (!recurUntil) return "Pick an end date for the recurrence.";
      if (recurUntil < date) {
        return "Recurrence end date must be after the start date.";
      }
      if (!Array.isArray(form.weekdays) || form.weekdays.length === 0) {
        return "Pick at least one weekday to repeat on.";
      }
    }

    const firstStart = new Date(`${date}T${startTime}`);
    if (
      Number.isNaN(firstStart.getTime()) ||
      firstStart.getTime() <= Date.now()
    ) {
      return "You cannot create consultation slots in the past.";
    }

    const newStart = parseHHMM(startTime);
    const newEnd = parseHHMM(endTime);
    if (newStart != null && newEnd != null) {
      const candidates = expandDates(
        date,
        recurring,
        recurUntil,
        recurring ? form.weekdays : null
      );
      const slotsByDate = new Map();
      for (const s of existingSlots) {
        if (!slotsByDate.has(s.date)) slotsByDate.set(s.date, []);
        slotsByDate.get(s.date).push(s);
      }
      for (const d of candidates) {
        const existing = slotsByDate.get(d) || [];
        for (const s of existing) {
          const eStart = parseHHMM(s.time);
          if (eStart == null) continue;
          const eDur = Number.isInteger(s.durationMinutes)
            ? s.durationMinutes
            : LEGACY_SLOT_DURATION_MIN;
          if (rangesOverlap(newStart, newEnd, eStart, eStart + eDur)) {
            return "This time range overlaps with existing office hours.";
          }
        }
      }
    }

    return "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    const v = validate();
    if (v) {
      setSubmitError(v);
      return;
    }
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await createSlots(idToken, professorId, {
        date: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        slotDurationMinutes: form.slotDurationMinutes,
        maxParticipants: form.maxParticipants,
        recurring: form.recurring,
        recurUntil: form.recurring ? form.recurUntil : undefined,
        weekdays: form.recurring ? form.weekdays : undefined,
        consultationType: form.consultationType,
        subject: form.subject ? form.subject.trim() : undefined,
      });
      const created = (res.created || []).length;
      const skipped = (res.skipped || []).length;
      onPublished?.({ created, skipped, days: expectedDays });
      onClose();
    } catch (err) {
      setSubmitError(err.message || "Could not publish slots.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ohd-title"
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <p className={styles.eyebrow}>Office hours</p>
            <h2 id="ohd-title" className={styles.title}>
              Publish a new block
            </h2>
            <p className={styles.lead}>
              Define a contiguous block of office hours. Students will be able
              to reserve seats inside it once it&apos;s published.
            </p>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2 2l8 8M10 2l-8 8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ohd-date">
              Date
            </label>
            <input
              id="ohd-date"
              className={styles.input}
              type="date"
              min={isoOffset(0)}
              value={form.date}
              onChange={(e) => update("date", e.target.value)}
              required
            />
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ohd-start">
                Start
              </label>
              <input
                id="ohd-start"
                className={styles.input}
                type="time"
                min={minStartTime}
                value={form.startTime}
                onChange={(e) => update("startTime", e.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ohd-end">
                End
              </label>
              <input
                id="ohd-end"
                className={styles.input}
                type="time"
                min={form.startTime || minStartTime}
                value={form.endTime}
                onChange={(e) => update("endTime", e.target.value)}
                required
              />
            </div>
          </div>

          <fieldset className={styles.typeFieldset} aria-label="Block type">
            <legend className={styles.label}>Block type</legend>
            <div className={styles.typeOptions}>
              {TYPE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`${styles.typeOption} ${
                    form.consultationType === opt.value
                      ? styles.typeOptionActive
                      : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="ohd-type"
                    value={opt.value}
                    checked={form.consultationType === opt.value}
                    onChange={(e) => update("consultationType", e.target.value)}
                  />
                  <span className={styles.typeOptionTitle}>{opt.label}</span>
                  <span className={styles.typeOptionHint}>{opt.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {form.consultationType === "exam_prep" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ohd-subject">
                Subject <span className={styles.requiredTag}>required</span>
              </label>
              {mySubjects.length > 0 ? (
                <select
                  id="ohd-subject"
                  className={styles.input}
                  value={form.subject}
                  onChange={(e) => update("subject", e.target.value)}
                  required
                >
                  <option value="">— pick a subject —</option>
                  {mySubjects.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="ohd-subject"
                  className={styles.input}
                  type="text"
                  value={form.subject}
                  onChange={(e) => update("subject", e.target.value)}
                  placeholder="e.g. Operating Systems"
                  required
                />
              )}
            </div>
          )}

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ohd-duration">
                Slot length (min)
              </label>
              <input
                id="ohd-duration"
                className={styles.input}
                type="number"
                min={5}
                step={5}
                value={form.slotDurationMinutes}
                onChange={(e) =>
                  update("slotDurationMinutes", Number(e.target.value))
                }
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ohd-cap">
                Capacity per slot
              </label>
              <input
                id="ohd-cap"
                className={styles.input}
                type="number"
                min={1}
                value={form.maxParticipants}
                onChange={(e) =>
                  update("maxParticipants", Number(e.target.value))
                }
                disabled={form.consultationType === "thesis"}
                required
              />
              {form.consultationType === "thesis" && (
                <p className={styles.fieldHint}>
                  Thesis sessions are always 1-on-1.
                </p>
              )}
            </div>
          </div>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={form.recurring}
              onChange={(e) => update("recurring", e.target.checked)}
            />
            <span>Repeat weekly until…</span>
          </label>

          {form.recurring && (
            <div className={styles.recurGroup}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="ohd-recur-until">
                  Recurrence ends
                </label>
                <input
                  id="ohd-recur-until"
                  className={styles.input}
                  type="date"
                  min={form.date}
                  value={form.recurUntil}
                  onChange={(e) => update("recurUntil", e.target.value)}
                  required
                />
              </div>

              <fieldset
                className={styles.weekdayFieldset}
                aria-describedby="ohd-weekday-hint"
              >
                <legend className={styles.label}>Repeat on</legend>
                <div className={styles.weekdayPicker} role="group">
                  {WEEKDAY_OPTIONS.map((opt) => {
                    const active = form.weekdays.includes(opt.value);
                    const isAnchor = weekdayOfDate(form.date) === opt.value;
                    return (
                      <button
                        type="button"
                        key={opt.value}
                        className={`${styles.weekdayChip} ${
                          active ? styles.weekdayChipActive : ""
                        } ${isAnchor ? styles.weekdayChipAnchor : ""}`}
                        onClick={() => toggleWeekday(opt.value)}
                        aria-pressed={active}
                        aria-label={`${opt.long}${
                          isAnchor ? " (start date)" : ""
                        }`}
                        title={
                          isAnchor
                            ? `${opt.long} — matches your start date`
                            : opt.long
                        }
                      >
                        <span className={styles.weekdayChipText}>
                          {opt.short}
                        </span>
                        {isAnchor && (
                          <span
                            className={styles.weekdayChipDot}
                            aria-hidden
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                <p id="ohd-weekday-hint" className={styles.weekdayHint}>
                  {recurringWithNoWeekdays
                    ? "Pick at least one weekday."
                    : "The dot marks the weekday of your start date — toggle freely."}
                </p>
              </fieldset>
            </div>
          )}

          {submitError && <div className={styles.error}>{submitError}</div>}

          <footer className={styles.footer}>
            <p className={styles.preview}>
              {expectedTotal > 0 ? (
                <>
                  <strong>{expectedTotal}</strong> slot
                  {expectedTotal === 1 ? "" : "s"} across{" "}
                  <strong>{expectedDays}</strong> day
                  {expectedDays === 1 ? "" : "s"}
                </>
              ) : (
                "—"
              )}
            </p>
            <div className={styles.footerActions}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.submit}
                disabled={
                  submitting || expectedTotal === 0 || recurringWithNoWeekdays
                }
              >
                {submitting ? "Publishing…" : "Publish"}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
