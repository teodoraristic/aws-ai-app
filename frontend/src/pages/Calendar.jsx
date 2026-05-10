import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import {
  deleteSlot,
  getMyConsultations,
  getProfessors,
  getProfessorSlots,
} from "../api.js";
import { initials } from "../utils/format.js";
import PageHeader from "../components/PageHeader.jsx";
import OfficeHoursDialog from "../components/OfficeHoursDialog.jsx";
import styles from "./Calendar.module.css";

// ── Calendar config ────────────────────────────────────────────────────
// Hours rendered in the day/week grid. Academic schedule fits inside
// 8:00–20:00; padding outside this range is rare and would just bloat
// the canvas. Adjust if the data ever drifts outside.
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const HOUR_HEIGHT_PX = 56;
const SLOT_MINUTES = 30;
const TOTAL_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const TOTAL_HEIGHT_PX = (DAY_END_HOUR - DAY_START_HOUR) * HOUR_HEIGHT_PX;

const WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LONG = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
];

// ── Date helpers ───────────────────────────────────────────────────────
// All calendar logic operates on local-time Date objects so the
// professor sees their own week boundaries, not UTC's. Consultation rows
// arrive as YYYY-MM-DD + HH:MM strings; we parse them as local for the
// same reason.

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeekMonday(d) {
  // Monday-first week. JS getDay() is 0=Sun..6=Sat; convert so Mon=0.
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}

function startOfMonth(d) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(d) {
  return isSameDay(d, new Date());
}

// Convert a local-time Date into "YYYY-MM-DD". Avoids toISOString() so a
// professor in a non-UTC timezone doesn't see their day slip backwards.
function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseConsultationDate(iso, hhmm) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  let hh = 0;
  let mm = 0;
  if (hhmm) {
    const parts = hhmm.split(":").map(Number);
    if (Number.isFinite(parts[0])) hh = parts[0];
    if (Number.isFinite(parts[1])) mm = parts[1];
  }
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function minutesSinceDayStart(date) {
  return (date.getHours() - DAY_START_HOUR) * 60 + date.getMinutes();
}

function formatHourLabel(hour) {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12} ${ampm}`;
}

function formatRange(view, cursor) {
  const cur = cursor;
  if (view === "day") {
    return cur.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "month") {
    return `${MONTH_LABELS[cur.getMonth()]} ${cur.getFullYear()}`;
  }
  // Week
  const start = startOfWeekMonday(cur);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${MONTH_LABELS[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
  }
  if (sameYear) {
    return `${MONTH_LABELS[start.getMonth()]} ${start.getDate()} – ${MONTH_LABELS[end.getMonth()]} ${end.getDate()}, ${start.getFullYear()}`;
  }
  return `${MONTH_LABELS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} – ${MONTH_LABELS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

// Snap a y-pixel offset within a day column to the nearest 30-minute
// grid line and return the corresponding "HH:MM" string. The grid is
// half-hourly so the prefill sits on the same lines the user sees.
function pixelOffsetToHHMM(y) {
  const minsFromTop = (y / HOUR_HEIGHT_PX) * 60;
  const total = DAY_START_HOUR * 60 + minsFromTop;
  const snapped = Math.round(total / SLOT_MINUTES) * SLOT_MINUTES;
  const clamped = Math.max(
    DAY_START_HOUR * 60,
    Math.min(snapped, DAY_END_HOUR * 60 - SLOT_MINUTES)
  );
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Open-slot derivation ───────────────────────────────────────────────
// Published slots that the professor put on the schedule but where
// nobody booked yet. We render these as muted "open availability"
// blocks so the professor can see the *shape* of their published week,
// not just the booked density. Anything with at least one active
// booking is drawn from the consultations side instead.

function buildOpenSlots(slots, bookedSlotIds) {
  if (!Array.isArray(slots)) return [];
  const out = [];
  for (const s of slots) {
    if (!s || !s.slotId) continue;
    if (bookedSlotIds.has(s.slotId)) continue;
    if ((s.currentParticipants || 0) > 0) continue;
    const start = parseConsultationDate(s.date, s.time);
    if (!start) continue;
    const dur = Number.isInteger(s.durationMinutes) ? s.durationMinutes : 30;
    const end = new Date(start.getTime() + dur * 60_000);
    out.push({
      id: `open:${s.slotId}`,
      slotId: s.slotId,
      kind: "open",
      start,
      end,
      durationMinutes: dur,
      max: s.maxParticipants || 1,
      consultationType: s.consultationType || "general",
      subject: s.subject || "",
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ── Event derivation ───────────────────────────────────────────────────
// Convert each consultation row from getMyConsultations into a calendar
// event. Slots that share a slotSK collapse to ONE event with a
// `participants` array — group sessions render once with N attendees,
// not N times in the same cell.

function buildEvents(consultations) {
  const bySlot = new Map();
  for (const c of consultations) {
    const key = c.slotSK || `${c.date}T${c.time}#${c.consultationId}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(c);
  }

  const events = [];
  for (const rows of bySlot.values()) {
    const first = rows[0];
    const start = parseConsultationDate(first.date, first.time);
    if (!start) continue;
    const dur = Number.isInteger(first.slotDurationMinutes)
      ? first.slotDurationMinutes
      : 30;
    const end = new Date(start.getTime() + dur * 60_000);
    const booked = rows.filter((r) => r.status === "booked");
    const cancelled = rows.length > 0 && booked.length === 0;
    const cap = first.slotMaxParticipants;
    events.push({
      id: first.slotSK || first.consultationId,
      start,
      end,
      durationMinutes: dur,
      topic: first.topic || "Office hours",
      participants: booked.map((c) => ({
        consultationId: c.consultationId,
        name:
          c.studentName ||
          (c.studentId ? `Student #${c.studentId.slice(0, 6)}` : "Student"),
        email: c.studentEmail || "",
        topic: c.topic && c.topic !== first.topic ? c.topic : null,
        note: c.note || "",
      })),
      max: cap,
      isGroup: cap > 1 || booked.length > 1,
      cancelled,
    });
  }
  events.sort((a, b) => a.start - b.start);
  return events;
}

// ── Component ──────────────────────────────────────────────────────────

// Below this width we default the view to "day" because a 7-column
// time-grid is unreadable on a phone. Past this threshold the
// professor's last manual choice wins, so resizing back up doesn't
// thrash. Kept in sync with the responsive breakpoint in Calendar.module.css.
const NARROW_VIEWPORT_PX = 720;

function pickInitialView() {
  if (typeof window === "undefined") return "week";
  return window.matchMedia(`(max-width: ${NARROW_VIEWPORT_PX}px)`).matches
    ? "day"
    : "week";
}

export default function Calendar() {
  const { idToken, user } = useAuth();
  const { bookingTick } = useChatWidget();
  const professorId = user && user.userId;
  const [view, setView] = useState(pickInitialView);
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [consultations, setConsultations] = useState([]);
  const [openSlots, setOpenSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  // ── Office-hours dialog ─────────────────────────────────────────
  // Single creation surface, opened either via the toolbar button (no
  // prefill) or by clicking on an empty time cell (date + nearest 30-
  // min start prefilled). Closing via Esc / backdrop click / Cancel /
  // successful publish all run through onClose.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogPrefill, setDialogPrefill] = useState(null);
  const [mySubjects, setMySubjects] = useState([]);
  const [deletingSlotId, setDeletingSlotId] = useState("");

  // First-paint nudge to "day" if we mounted on a narrow viewport AND
  // the user hasn't actively switched yet. After that, respect choice.
  // matchMedia listener also covers rotating a tablet from landscape to
  // portrait without remounting the page.
  const userTouchedView = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(`(max-width: ${NARROW_VIEWPORT_PX}px)`);
    const onChange = (ev) => {
      if (userTouchedView.current) return;
      setView(ev.matches ? "day" : "week");
    };
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, []);

  const handlePickView = useCallback((v) => {
    userTouchedView.current = true;
    setView(v);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    // Pull a generous window of published slots so the open-availability
    // overlay covers the same horizon as the consultations endpoint
    // (currently "today + upcoming"). One pass on mount; we don't refetch
    // on view change because the backend already returns enough data
    // and refetching on every prev/next click would be wasteful.
    const today = startOfDay(new Date());
    const slotsFrom = isoDate(today);
    const slotsTo = isoDate(addDays(today, 60));
    try {
      const [consData, slotsData] = await Promise.all([
        getMyConsultations(idToken),
        professorId
          ? getProfessorSlots(idToken, professorId, slotsFrom, slotsTo).catch(
              () => ({ slots: [] }) // overlay is non-critical, swallow
            )
          : Promise.resolve({ slots: [] }),
      ]);
      setConsultations(consData.consultations || []);
      setOpenSlots(slotsData.slots || []);
    } catch (err) {
      setError(err.message || "Could not load calendar.");
    } finally {
      setLoading(false);
    }
  }, [idToken, professorId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch whenever the chatbot reports a booking-mutating tool call
  // so a session the student just booked / joined / cancelled in the
  // floating assistant shows up here without a manual refresh.
  useEffect(() => {
    if (bookingTick === 0) return;
    load();
  }, [bookingTick, load]);

  // Load the calling professor's subject list once. The user object
  // from useAuth doesn't carry subjects (those live on the DDB profile),
  // so we fetch the public directory and self-locate. Only used to
  // populate the exam-prep subject picker inside the dialog.
  useEffect(() => {
    if (!idToken || !professorId) return undefined;
    let alive = true;
    (async () => {
      try {
        const data = await getProfessors(idToken);
        if (!alive) return;
        const me = (data.professors || []).find(
          (p) => p.professorId === professorId
        );
        const subs = Array.isArray(me?.subjects) ? me.subjects : [];
        setMySubjects(subs);
      } catch {
        /* directory fetch failures are non-blocking — the subject
           dropdown just stays empty and the professor publishes
           without one */
      }
    })();
    return () => {
      alive = false;
    };
  }, [idToken, professorId]);

  // Auto-dismiss success notices so they don't pile up between actions.
  // 4.5s is long enough to read "Published 12 slots across 4 days" but
  // short enough that the next publish gets a fresh banner.
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const events = useMemo(() => buildEvents(consultations), [consultations]);

  // Set of slotSKs that already have an active booking — used so we
  // don't render an open-availability overlay on top of a real event.
  const bookedSlotIds = useMemo(() => {
    const s = new Set();
    for (const e of events) if (!e.cancelled) s.add(e.id);
    return s;
  }, [events]);

  const opens = useMemo(
    () => buildOpenSlots(openSlots, bookedSlotIds),
    [openSlots, bookedSlotIds]
  );

  // Tick the now-line every minute so it doesn't go stale while the
  // tab stays open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  function goPrev() {
    if (view === "day") setCursor((c) => addDays(c, -1));
    else if (view === "week") setCursor((c) => addDays(c, -7));
    else setCursor((c) => addMonths(c, -1));
  }
  function goNext() {
    if (view === "day") setCursor((c) => addDays(c, 1));
    else if (view === "week") setCursor((c) => addDays(c, 7));
    else setCursor((c) => addMonths(c, 1));
  }
  function goToday() {
    setCursor(startOfDay(new Date()));
  }

  // Open the dialog from the toolbar button (no prefill) or from a
  // click on an empty time cell (prefilled with that date + the nearest
  // 30-min grid line above the click point).
  const openCreate = useCallback((prefill) => {
    setDialogPrefill(prefill || null);
    setDialogOpen(true);
  }, []);

  const closeCreate = useCallback(() => {
    setDialogOpen(false);
  }, []);

  const onPublished = useCallback(
    ({ created, skipped, days }) => {
      const dayWord = days === 1 ? "day" : "days";
      const slotWord = created === 1 ? "slot" : "slots";
      const skipNote =
        skipped > 0
          ? ` Skipped ${skipped} unavailable day${skipped === 1 ? "" : "s"}.`
          : "";
      setNotice(`Published ${created} ${slotWord} across ${days} ${dayWord}.${skipNote}`);
      load();
    },
    [load]
  );

  // Delete a single open (unbooked) slot. The backend rejects deletes
  // on slots that already have bookings — that case is handled inside
  // the event detail dialog (where the professor can cancel with a
  // note). Sequential rather than optimistic so a failed delete leaves
  // the calendar in a known state.
  const onDeleteOpen = useCallback(
    async (slot) => {
      if (!slot || !slot.slotId) return;
      if (deletingSlotId) return;
      setError("");
      setDeletingSlotId(slot.slotId);
      try {
        await deleteSlot(idToken, professorId, slot.slotId);
        setNotice("Open slot removed.");
        await load();
      } catch (err) {
        setError(err.message || "Could not delete that slot.");
      } finally {
        setDeletingSlotId("");
      }
    },
    [deletingSlotId, idToken, professorId, load]
  );

  // Convert a click on an empty cell into a creation prefill. Snap to
  // the same 30-min grid the user sees so the start time lines up with
  // the gridline above their pointer.
  const handleCreateAtCell = useCallback(
    (date, y) => {
      const startTime = pixelOffsetToHHMM(y);
      openCreate({ date: isoDate(date), startTime });
    },
    [openCreate]
  );

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedId) || null,
    [events, selectedId]
  );

  const stats = useMemo(() => {
    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const weekStart = startOfWeekMonday(today);
    const weekEnd = addDays(weekStart, 7);
    let todayCount = 0;
    let weekCount = 0;
    for (const e of events) {
      if (e.cancelled) continue;
      if (isSameDay(e.start, today)) todayCount += 1;
      if (e.start >= weekStart && e.start < weekEnd) weekCount += 1;
    }
    const next = events.find((e) => !e.cancelled && e.start >= now);
    return { todayCount, weekCount, tomorrow, next };
  }, [events, now]);

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Schedule"
        title="Calendar"
        lead="Plan your office hours and review the sessions students have booked. Click an empty time on the grid to publish a new block, or hover an open slot to remove it."
      />

      <div className={styles.toolbar}>
        <section className={styles.statRow} aria-label="Calendar summary">
          <div className={styles.stat}>
            <span className={styles.statValue}>
              {loading ? "—" : stats.todayCount}
            </span>
            <span className={styles.statLabel}>today</span>
          </div>
          <div className={styles.statDivider} aria-hidden />
          <div className={styles.stat}>
            <span className={styles.statValue}>
              {loading ? "—" : stats.weekCount}
            </span>
            <span className={styles.statLabel}>this week</span>
          </div>
          <div className={styles.statDivider} aria-hidden />
          <div className={`${styles.stat} ${styles.statNext}`}>
            <span className={styles.statValueSmall}>
              {loading
                ? "—"
                : stats.next
                  ? `${stats.next.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${stats.next.start.toTimeString().slice(0, 5)}`
                  : "Nothing scheduled"}
            </span>
            <span className={styles.statLabel}>next session</span>
          </div>
        </section>

        <section className={styles.controls} aria-label="Calendar controls">
          <div className={styles.navGroup}>
            <button
              type="button"
              className={styles.todayBtn}
              onClick={goToday}
              aria-label="Jump to today"
            >
              Today
            </button>
            <div className={styles.arrowGroup}>
              <button
                type="button"
                className={styles.arrowBtn}
                onClick={goPrev}
                aria-label="Previous"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.arrowBtn}
                onClick={goNext}
                aria-label="Next"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <h2 className={styles.rangeLabel}>{formatRange(view, cursor)}</h2>
          </div>

          <div className={styles.controlsRight}>
            <div className={styles.viewSwitch} role="tablist" aria-label="View">
              {["day", "week", "month"].map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  className={`${styles.viewBtn} ${view === v ? styles.viewBtnActive : ""}`}
                  onClick={() => handlePickView(v)}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>

            <button
              type="button"
              className={styles.addBtn}
              onClick={() => openCreate(null)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M6 1.5v9M1.5 6h9"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              <span>New office hours</span>
            </button>
          </div>
        </section>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {notice && (
        <div className={styles.notice} role="status" aria-live="polite">
          {notice}
        </div>
      )}

      <div className={styles.canvas}>
        {view === "month" && (
          <MonthGrid
            cursor={cursor}
            events={events}
            opens={opens}
            onSelect={(e) => {
              setCursor(startOfDay(e.start));
              handlePickView("day");
            }}
            onPickDay={(d) => {
              setCursor(startOfDay(d));
              handlePickView("day");
            }}
          />
        )}
        {view === "week" && (
          <WeekGrid
            cursor={cursor}
            events={events}
            opens={opens}
            now={now}
            onSelect={(e) => setSelectedId(e.id)}
            onCreateAt={handleCreateAtCell}
            onDeleteOpen={onDeleteOpen}
            deletingSlotId={deletingSlotId}
          />
        )}
        {view === "day" && (
          <DayGrid
            cursor={cursor}
            events={events}
            opens={opens}
            now={now}
            onSelect={(e) => setSelectedId(e.id)}
            onCreateAt={handleCreateAtCell}
            onDeleteOpen={onDeleteOpen}
            deletingSlotId={deletingSlotId}
          />
        )}
      </div>

      {selectedEvent && (
        <EventDetailDialog
          event={selectedEvent}
          onClose={() => setSelectedId(null)}
        />
      )}

      <OfficeHoursDialog
        open={dialogOpen}
        initialDate={dialogPrefill?.date}
        initialStartTime={dialogPrefill?.startTime}
        existingSlots={openSlots}
        mySubjects={mySubjects}
        idToken={idToken}
        professorId={professorId}
        onClose={closeCreate}
        onPublished={onPublished}
      />
    </div>
  );
}

// ── Time-grid shared rendering ─────────────────────────────────────────
// The day and week views share the same vertical time grid (8 AM–8 PM,
// gridlines every 30 min). The hour-label gutter is rendered once per
// view and the day columns are positioned absolutely against it.

function TimeGutter() {
  const hours = [];
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    hours.push(h);
  }
  return (
    <div className={styles.gutter} aria-hidden>
      {hours.map((h, i) => (
        <div
          key={h}
          className={styles.gutterRow}
          style={{ top: `${(h - DAY_START_HOUR) * HOUR_HEIGHT_PX}px` }}
        >
          {i === 0 ? null : (
            <span className={styles.gutterLabel}>{formatHourLabel(h)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function GridLines() {
  const lines = [];
  const total = (DAY_END_HOUR - DAY_START_HOUR) * 2;
  for (let i = 0; i <= total; i++) {
    const top = i * (HOUR_HEIGHT_PX / 2);
    lines.push(
      <div
        key={i}
        className={`${styles.gridLine} ${i % 2 === 0 ? styles.gridLineHour : styles.gridLineHalf}`}
        style={{ top: `${top}px` }}
      />
    );
  }
  return <>{lines}</>;
}

function NowLine({ now, columnIndex, columnCount }) {
  const startMin = minutesSinceDayStart(now);
  if (startMin < 0 || startMin > TOTAL_MINUTES) return null;
  const top = (startMin / 60) * HOUR_HEIGHT_PX;
  // For week view we want the dot only on today's column, but the line
  // can extend across the full grid. Caller passes columnIndex == null
  // to skip the dot (e.g. day view never needs one).
  return (
    <div className={styles.nowLine} style={{ top: `${top}px` }}>
      {columnIndex !== null && (
        <span
          className={styles.nowDot}
          style={{
            left: `calc((100% / ${columnCount}) * ${columnIndex})`,
          }}
        />
      )}
    </div>
  );
}

// ── Day column (interactive empty area + child blocks) ────────────────
// Wraps the absolutely-positioned events / open slots and intercepts
// clicks on the underlying grid so professors can publish new office
// hours by tapping any empty time. We rely on `e.target ===
// e.currentTarget` so clicks that bubble up from a child block don't
// double-fire — the child's own onClick is responsible for its own
// behaviour.

function DayColumn({
  date,
  dayEvents,
  dayOpens,
  compact,
  onSelect,
  onCreateAt,
  onDeleteOpen,
  deletingSlotId,
  emptyMessage,
  todayHighlight,
}) {
  function handleClick(e) {
    if (e.target !== e.currentTarget) return;
    if (!onCreateAt) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    onCreateAt(date, y);
  }
  return (
    <div
      className={`${styles.dayCol} ${todayHighlight ? styles.dayColToday : ""} ${onCreateAt ? styles.dayColInteractive : ""}`}
      onClick={handleClick}
      role={onCreateAt ? "button" : undefined}
      aria-label={onCreateAt ? "Tap to publish office hours" : undefined}
      tabIndex={-1}
    >
      <GridLines />
      {emptyMessage && dayEvents.length === 0 && dayOpens.length === 0 && (
        <div className={styles.dayEmpty} aria-hidden>
          <p>{emptyMessage}</p>
        </div>
      )}
      {/* Open availability sits BEHIND booked events because a slot
          that's part-cancelled but still has bookings is represented
          by the EventBlock; the OpenSlotBlock is just a hint of "this
          time is published". */}
      {dayOpens.map((o) => (
        <OpenSlotBlock
          key={o.id}
          slot={o}
          compact={compact}
          onDelete={onDeleteOpen}
          deleting={deletingSlotId === o.slotId}
        />
      ))}
      {dayEvents.map((e) => (
        <EventBlock key={e.id} event={e} compact={compact} onSelect={onSelect} />
      ))}
    </div>
  );
}

// ── Week view ──────────────────────────────────────────────────────────

function WeekGrid({
  cursor,
  events,
  opens = [],
  now,
  onSelect,
  onCreateAt,
  onDeleteOpen,
  deletingSlotId,
}) {
  const weekStart = startOfWeekMonday(cursor);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  // Bucket events by (yyyy-mm-dd). Avoid recomputing per column.
  const eventsByDay = useMemo(() => {
    const m = new Map();
    for (const e of events) {
      const k = `${e.start.getFullYear()}-${e.start.getMonth()}-${e.start.getDate()}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return m;
  }, [events]);

  const opensByDay = useMemo(() => {
    const m = new Map();
    for (const o of opens) {
      const k = `${o.start.getFullYear()}-${o.start.getMonth()}-${o.start.getDate()}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(o);
    }
    return m;
  }, [opens]);

  // Auto-scroll to ~8 AM (top) on mount; if "now" is within range,
  // scroll closer to it so the professor lands near "right now".
  const scrollerRef = useRef(null);
  useEffect(() => {
    if (!scrollerRef.current) return;
    const min = minutesSinceDayStart(now);
    if (min > 60 && min < TOTAL_MINUTES - 60) {
      scrollerRef.current.scrollTop = Math.max(
        0,
        (min / 60) * HOUR_HEIGHT_PX - HOUR_HEIGHT_PX * 1.5
      );
    }
  }, [now]);

  // Index of today within the visible week, or -1.
  const todayIndex = days.findIndex((d) => isToday(d));

  return (
    <div className={styles.weekWrap}>
      <div className={styles.weekHead}>
        <div className={styles.weekHeadGutter} aria-hidden />
        {days.map((d) => {
          const today = isToday(d);
          return (
            <div
              key={d.toISOString()}
              className={`${styles.weekHeadDay} ${today ? styles.weekHeadDayToday : ""}`}
            >
              <span className={styles.weekHeadWeek}>
                {WEEKDAY_LABELS[(d.getDay() + 6) % 7]}
              </span>
              <span className={styles.weekHeadNum}>{d.getDate()}</span>
            </div>
          );
        })}
      </div>

      <div className={styles.scroller} ref={scrollerRef}>
        <div
          className={styles.weekBody}
          style={{ height: `${TOTAL_HEIGHT_PX}px` }}
        >
          <TimeGutter />
          <div className={styles.weekColumns}>
            {days.map((d) => {
              const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
              const dayEvents = eventsByDay.get(k) || [];
              const dayOpens = opensByDay.get(k) || [];
              return (
                <DayColumn
                  key={d.toISOString()}
                  date={d}
                  dayEvents={dayEvents}
                  dayOpens={dayOpens}
                  compact
                  onSelect={onSelect}
                  onCreateAt={onCreateAt}
                  onDeleteOpen={onDeleteOpen}
                  deletingSlotId={deletingSlotId}
                  todayHighlight={isToday(d)}
                />
              );
            })}
            {todayIndex >= 0 && (
              <NowLine now={now} columnIndex={todayIndex} columnCount={7} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Day view ───────────────────────────────────────────────────────────

function DayGrid({
  cursor,
  events,
  opens = [],
  now,
  onSelect,
  onCreateAt,
  onDeleteOpen,
  deletingSlotId,
}) {
  const day = startOfDay(cursor);
  const dayEvents = useMemo(
    () => events.filter((e) => isSameDay(e.start, day)),
    [events, day]
  );
  const dayOpens = useMemo(
    () => opens.filter((o) => isSameDay(o.start, day)),
    [opens, day]
  );

  const scrollerRef = useRef(null);
  useEffect(() => {
    if (!scrollerRef.current) return;
    const min = minutesSinceDayStart(now);
    if (isToday(day) && min > 60 && min < TOTAL_MINUTES - 60) {
      scrollerRef.current.scrollTop = Math.max(
        0,
        (min / 60) * HOUR_HEIGHT_PX - HOUR_HEIGHT_PX * 1.5
      );
    } else {
      scrollerRef.current.scrollTop = 0;
    }
  }, [now, day]);

  return (
    <div className={styles.dayWrap}>
      <div className={styles.dayHead}>
        <div className={styles.dayHeadGutter} aria-hidden />
        <div
          className={`${styles.dayHeadDay} ${isToday(day) ? styles.weekHeadDayToday : ""}`}
        >
          <span className={styles.weekHeadWeek}>
            {WEEKDAY_LONG[(day.getDay() + 6) % 7]}
          </span>
          <span className={styles.weekHeadNum}>{day.getDate()}</span>
          <span className={styles.dayHeadMonth}>
            {MONTH_LABELS[day.getMonth()]}
          </span>
        </div>
      </div>

      <div className={styles.scroller} ref={scrollerRef}>
        <div
          className={styles.dayBody}
          style={{ height: `${TOTAL_HEIGHT_PX}px` }}
        >
          <TimeGutter />
          <div className={`${styles.dayColumns} ${isToday(day) ? styles.dayColumnsToday : ""}`}>
            <DayColumn
              date={day}
              dayEvents={dayEvents}
              dayOpens={dayOpens}
              onSelect={onSelect}
              onCreateAt={onCreateAt}
              onDeleteOpen={onDeleteOpen}
              deletingSlotId={deletingSlotId}
              emptyMessage={
                onCreateAt
                  ? "Click any empty time to publish office hours."
                  : "No reservations on this day."
              }
            />
            {isToday(day) && (
              <NowLine now={now} columnIndex={0} columnCount={1} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Month view ─────────────────────────────────────────────────────────

function MonthGrid({ cursor, events, opens = [], onSelect, onPickDay }) {
  // Render the standard 6-week grid that covers the visible month plus
  // the tail end of the previous month and the head of the next so day
  // numbers always line up under MON–SUN columns.
  const monthStart = startOfMonth(cursor);
  const gridStart = startOfWeekMonday(monthStart);
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    [gridStart]
  );

  const eventsByDay = useMemo(() => {
    const m = new Map();
    for (const e of events) {
      const k = `${e.start.getFullYear()}-${e.start.getMonth()}-${e.start.getDate()}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.start - b.start);
    }
    return m;
  }, [events]);

  // Count of open (unbooked) slots per day so the month grid can show a
  // small "·N open" hint — gives the professor a sense of where they
  // still have free capacity without leaving the month view.
  const opensByDay = useMemo(() => {
    const m = new Map();
    for (const o of opens) {
      const k = `${o.start.getFullYear()}-${o.start.getMonth()}-${o.start.getDate()}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [opens]);

  const currentMonth = monthStart.getMonth();

  return (
    <div className={styles.monthWrap}>
      <div className={styles.monthHead}>
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className={styles.monthHeadDay}>
            {w}
          </div>
        ))}
      </div>
      <div className={styles.monthGrid}>
        {cells.map((d) => {
          const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          const dayEvents = eventsByDay.get(k) || [];
          const openCount = opensByDay.get(k) || 0;
          const inMonth = d.getMonth() === currentMonth;
          const today = isToday(d);
          const visible = dayEvents.slice(0, 3);
          const overflow = dayEvents.length - visible.length;
          return (
            <button
              type="button"
              key={d.toISOString()}
              className={`${styles.monthCell} ${
                inMonth ? "" : styles.monthCellOut
              } ${today ? styles.monthCellToday : ""}`}
              onClick={() => onPickDay(d)}
            >
              <div className={styles.monthCellTop}>
                <span className={styles.monthCellNum}>{d.getDate()}</span>
                {openCount > 0 && (
                  <span
                    className={styles.monthOpenPip}
                    title={`${openCount} open slot${openCount === 1 ? "" : "s"}`}
                  >
                    {openCount}
                  </span>
                )}
              </div>
              <ul className={styles.monthCellList}>
                {visible.map((e) => (
                  <li
                    key={e.id}
                    className={`${styles.monthChip} ${
                      e.cancelled ? styles.monthChipCancelled : ""
                    } ${e.isGroup && !e.cancelled ? styles.monthChipGroup : ""}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onSelect(e);
                    }}
                    title={`${e.start.toTimeString().slice(0, 5)} — ${e.topic}`}
                  >
                    <span className={styles.monthChipTime}>
                      {e.start.toTimeString().slice(0, 5)}
                    </span>
                    <span className={styles.monthChipTopic}>{e.topic}</span>
                  </li>
                ))}
                {overflow > 0 && (
                  <li className={styles.monthMore}>+{overflow} more</li>
                )}
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Event block (shared by week + day views) ───────────────────────────

function EventBlock({ event, compact, onSelect }) {
  const startMin = minutesSinceDayStart(event.start);
  const top = (startMin / 60) * HOUR_HEIGHT_PX;
  const height = Math.max(
    22,
    (event.durationMinutes / 60) * HOUR_HEIGHT_PX - 2
  );
  const timeLabel = `${event.start
    .toTimeString()
    .slice(0, 5)}–${event.end.toTimeString().slice(0, 5)}`;

  // Slim layout when the event is short or when we're in week view (less
  // horizontal room). The day view passes `compact={false}` so we get
  // more breathing room and student names spelled out.
  const cls = [
    styles.event,
    event.cancelled && styles.eventCancelled,
    event.isGroup && !event.cancelled && styles.eventGroup,
    compact && styles.eventCompact,
    height < 36 && styles.eventTiny,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cls}
      style={{ top: `${top}px`, height: `${height}px` }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(event);
      }}
      aria-label={`${event.topic} at ${timeLabel}`}
    >
      <span className={styles.eventTime}>{timeLabel}</span>
      <span className={styles.eventTopic}>{event.topic}</span>
      {!compact && event.participants.length > 0 && (
        <span className={styles.eventParticipants}>
          {event.participants
            .slice(0, 3)
            .map((p) => p.name)
            .join(", ")}
          {event.participants.length > 3
            ? ` +${event.participants.length - 3}`
            : ""}
        </span>
      )}
      {compact && event.participants.length > 0 && height >= 50 && (
        <span className={styles.eventParticipantsCompact}>
          {event.participants[0].name}
          {event.participants.length > 1
            ? ` +${event.participants.length - 1}`
            : ""}
        </span>
      )}
      {event.isGroup && !event.cancelled && (
        <span className={styles.eventBadge} aria-hidden>
          {event.participants.length}
          <span className={styles.eventBadgeSep}>/</span>
          {event.max}
        </span>
      )}
    </button>
  );
}

// ── Open-availability overlay ──────────────────────────────────────────
// Muted block that sits behind real events. Tells the professor "this
// time is on the public schedule, no one has booked yet". On hover a
// small ✕ button appears so an unbooked slot can be removed without
// leaving the calendar.

function OpenSlotBlock({ slot, compact, onDelete, deleting }) {
  const startMin = minutesSinceDayStart(slot.start);
  const top = (startMin / 60) * HOUR_HEIGHT_PX;
  const height = Math.max(
    18,
    (slot.durationMinutes / 60) * HOUR_HEIGHT_PX - 2
  );
  const timeLabel = `${slot.start
    .toTimeString()
    .slice(0, 5)}–${slot.end.toTimeString().slice(0, 5)}`;

  const cls = [
    styles.openSlot,
    compact && styles.openSlotCompact,
    height < 28 && styles.openSlotTiny,
    deleting && styles.openSlotBusy,
  ]
    .filter(Boolean)
    .join(" ");

  const labelText =
    slot.consultationType === "exam_prep"
      ? `Exam prep${slot.subject ? ` · ${slot.subject}` : ""}`
      : slot.consultationType === "thesis"
        ? "Thesis"
        : slot.max > 1
          ? `Open · ${slot.max}-seat`
          : "Open";

  return (
    <div
      className={cls}
      style={{ top: `${top}px`, height: `${height}px` }}
      title={`Open · ${timeLabel}`}
    >
      <span className={styles.openSlotLabel}>{labelText}</span>
      {height >= 30 && (
        <span className={styles.openSlotTime}>{timeLabel}</span>
      )}
      {onDelete && (
        <button
          type="button"
          className={styles.openSlotDelete}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(slot);
          }}
          disabled={deleting}
          aria-label={`Remove open slot at ${timeLabel}`}
          title="Remove this open slot"
        >
          {deleting ? (
            <span className={styles.openSlotSpinner} aria-hidden />
          ) : (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d="M1.5 1.5l7 7M8.5 1.5l-7 7"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

// ── Event detail dialog ────────────────────────────────────────────────
// Lightweight click-target — opens when the professor taps an event in
// any view. Closes on backdrop click or Escape.

function EventDetailDialog({ event, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const longDate = event.start.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = `${event.start
    .toTimeString()
    .slice(0, 5)} – ${event.end.toTimeString().slice(0, 5)}`;

  return (
    <div
      className={styles.dialogScrim}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cal-event-title"
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.dialogHead}>
          <span
            className={`${styles.dialogTag} ${
              event.cancelled
                ? styles.dialogTagCancelled
                : event.isGroup
                  ? styles.dialogTagGroup
                  : styles.dialogTag1on1
            }`}
          >
            {event.cancelled
              ? "Cancelled"
              : event.isGroup
                ? `${event.participants.length}/${event.max}`
                : "1-on-1"}
          </span>
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <h3 id="cal-event-title" className={styles.dialogTitle}>
          {event.topic}
        </h3>
        <p className={styles.dialogMeta}>
          {longDate}
          <span className={styles.dialogMetaDot} aria-hidden>·</span>
          <span className={styles.dialogMetaTime}>{time}</span>
        </p>

        {event.participants.length === 0 ? (
          <p className={styles.dialogEmpty}>
            This session has no booked students.
          </p>
        ) : (
          <ul className={styles.dialogStudents}>
            {event.participants.map((p) => (
              <li key={p.consultationId} className={styles.dialogStudent}>
                <span className={styles.dialogAvatar} aria-hidden>
                  {initials(p.name)}
                </span>
                <div className={styles.dialogStudentMeta}>
                  <span className={styles.dialogStudentName}>{p.name}</span>
                  {p.topic && (
                    <span className={styles.dialogStudentTopic}>
                      Personal topic — {p.topic}
                    </span>
                  )}
                  {p.note && (
                    <span className={styles.dialogStudentNote}>
                      “{p.note}”
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
