import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import {
  getMyConsultations,
  getMyWaitlist,
  getProfessors,
  getProfessorSlots,
  joinWaitlist,
  updateSlotCapacity,
} from "../api.js";
import {
  dayNumber,
  initials,
  monthShort,
  weekdayShort,
} from "../utils/format.js";
import PageHeader from "../components/PageHeader.jsx";
import styles from "./Professors.module.css";

// Build the natural-language message we hand off to the chatbot when a
// student clicks "Reserve". The assistant's system prompt knows how to
// pick up from here: it identifies the professor, optionally asks for
// the topic, verifies the slot, and runs the regular confirm + book_slot
// flow.
//
// Two flavours of message:
//   - Fresh slot (currentParticipants === 0): we leave the topic out so
//     the assistant asks for it. Same contract as the manual-modal flow
//     where topic was always mandatory.
//   - Partially-filled group session (currentParticipants > 0 with a
//     topic already on the slot): the student is joining an in-progress
//     group session that has its own running topic. Re-asking for the
//     topic here would be silly — they're not setting it, the group
//     already has one. We thread that topic into the hand-off message so
//     the chatbot's "topic in hand" gate is satisfied immediately and it
//     can jump to confirmation via the pre-selected-slot SHORTCUT.
//
// We deliberately don't qualify the booking as "1-on-1" — the slot's
// capacity is already on the backend record, and saying it here just
// echoes back the same label in the assistant's confirmation. Keeping
// the message capacity-agnostic also means the user-facing copy reads
// the same whether the slot is a private hour or an empty group seat.
function buildBookingMessage(professor, slot) {
  if (!professor || !slot) return "";
  let when = slot.date || "";
  try {
    // Use Z so the date is parsed as UTC — slots are stored and compared as
    // UTC on the backend (combineSlotInstantUtc). Without Z, JS interprets
    // the string as local time, which can shift the displayed day for slots
    // near midnight UTC.
    const d = new Date(`${slot.date}T${slot.time || "00:00"}:00Z`);
    if (!Number.isNaN(d.getTime())) {
      // Include the year so the assistant never has to guess it. Without a
      // year in the message Nova Lite miscalculates dateFrom/dateTo for slots
      // that fall in the next calendar year and reports "time not available".
      when = d.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    }
  } catch {
    /* fall back to ISO date */
  }
  const time = slot.time || "";
  const max = slot.maxParticipants || 1;
  const cur = slot.currentParticipants || 0;
  // Use the first topic only. slot.topic is topics.join(" · ") which becomes
  // an ambiguous multi-topic string when different students booked with
  // different notes; slot.topics[0] is the earliest student's topic.
  const existingTopic = (
    (Array.isArray(slot.topics) && slot.topics[0]) || ""
  ).trim();
  const whenTime = time ? ` at ${time}` : "";

  if (max > 1 && cur > 0 && existingTopic) {
    return `I'd like to join the existing group session with Professor ${professor.name} on ${when}${whenTime} to discuss ${existingTopic}.`;
  }

  return `I'd like to book a session with Professor ${professor.name} on ${when}${whenTime}.`;
}

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// Same backend interpretation we use elsewhere: status=full OR booked-out
// derives FULL; >0 booked but < max derives PARTIAL; otherwise AVAILABLE.
function slotState(s) {
  const max = s.maxParticipants || 1;
  const cur = s.currentParticipants || 0;
  if (s.status === "full" || cur >= max) return "full";
  if (cur > 0) return "partial";
  return "free";
}

// Academic-style status copy: less "FREE/FULL/BOOKED" SaaS shorthand,
// more "Available / Partially booked / Full capacity" portal language.
const STATE_COPY = {
  free: { label: "Available", className: "stateFree" },
  partial: { label: "Partially booked", className: "stateBooked" },
  full: { label: "Full capacity", className: "stateFull" },
};

const TYPE_LABEL = {
  general: "General",
  exam_prep: "Exam prep",
  thesis: "Thesis",
};

// 14 days gives the student two full weeks of visibility. Same window the
// chat assistant defaults to when no date range is specified, so manual
// browsing and the AI flow surface the same set of opportunities.
const SLOT_LOOKAHEAD_DAYS = 14;

// How many slots are shown per day at once. Long office-hour blocks would
// otherwise stretch the right rail down by a screen — paginating to 4 keeps
// each day's card the same height and lets the user step through with the
// arrows.
const SLOTS_PER_PAGE = 4;

// Per-day slot pager — renders SLOTS_PER_PAGE rows from `daySlots` at a
// time and exposes prev/next arrows + an "x–y of N" counter. Owns its own
// page state, keyed by the parent's React `key` (the day's date), so
// flipping pages on Tuesday doesn't reset Wednesday.
function DaySlots({ daySlots, renderSlot }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(daySlots.length / SLOTS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * SLOTS_PER_PAGE;
  const visible = daySlots.slice(start, start + SLOTS_PER_PAGE);

  // If the underlying list shrinks past the current page (e.g. a slot
  // gets booked elsewhere and falls off), snap back to a valid page.
  useEffect(() => {
    if (safePage !== page) setPage(safePage);
  }, [safePage, page]);

  if (daySlots.length <= SLOTS_PER_PAGE) {
    return (
      <ul className={styles.slots}>{daySlots.map((s) => renderSlot(s))}</ul>
    );
  }

  return (
    <div className={styles.slotsPager}>
      <ul className={styles.slots}>{visible.map((s) => renderSlot(s))}</ul>
      <nav
        className={styles.slotsPagerNav}
        aria-label="Slots within this day"
      >
        <button
          type="button"
          className={styles.slotsPagerArrow}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={safePage === 0}
          aria-label="Earlier slots in this day"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M9 2 4 7l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className={styles.slotsPagerStatus}>
          {Math.min(daySlots.length, start + 1)}–
          {Math.min(daySlots.length, start + visible.length)}
          <span className={styles.slotsPagerStatusOf}>of</span>
          {daySlots.length}
        </span>
        <button
          type="button"
          className={styles.slotsPagerArrow}
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          disabled={safePage >= totalPages - 1}
          aria-label="Later slots in this day"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M5 2l5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </nav>
    </div>
  );
}

export default function Professors() {
  const { idToken, user } = useAuth();
  const { openWidget, bookingTick } = useChatWidget();
  const [professors, setProfessors] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [error, setError] = useState("");

  // Set of slotIds the current student has already reserved. Loaded once
  // per session so the Reserve button on a slot card flips to "Already
  // reserved" while they're on the page. Booking now happens through the
  // chatbot, so this set is no longer mutated locally — a refresh picks
  // up any new bookings the assistant made. Professors don't read this
  // set; it stays empty for them.
  const [bookedSlotIds, setBookedSlotIds] = useState(() => new Set());

  // Set of slotIds the current student is on the waitlist for. Drives
  // the "On waitlist" button label so they don't try to re-join. Refetched
  // alongside bookedSlotIds.
  const [waitlistedSlotIds, setWaitlistedSlotIds] = useState(() => new Set());

  // Join-waitlist confirmation state — opens a tiny inline panel below a
  // full slot row asking the student to confirm before we POST. The
  // waitlist is notify-only; there's nothing else to collect.
  const [waitlistOpenSlotId, setWaitlistOpenSlotId] = useState(null);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistError, setWaitlistError] = useState("");

  const [editingSlotId, setEditingSlotId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const editInputRef = useRef(null);

  // Map of professorId -> { topics: string[], examPrep: { subject, count }[] }
  // describing the active group consultations and any open exam-prep blocks
  // in the next 14 days. Populated lazily after the professor list loads
  // (one slots fetch per professor in parallel). Empty / undefined entries
  // mean the chip row stays hidden for that card.
  const [groupInfoByProfId, setGroupInfoByProfId] = useState(
    () => new Map()
  );

  useEffect(() => {
    (async () => {
      try {
        const data = await getProfessors(idToken);
        setProfessors(data.professors || []);
      } catch (err) {
        setError(err.message || "Could not load professors.");
      } finally {
        setLoading(false);
      }
    })();
  }, [idToken]);

  // Lazily compute per-professor group info (active topics + open exam
  // prep blocks) by fetching their upcoming slots. Done AFTER the
  // directory is on screen so the page is interactive immediately and
  // chips fade in as data arrives. Failures per-professor are swallowed —
  // the card just renders without chips.
  useEffect(() => {
    if (!idToken || professors.length === 0) return undefined;
    let alive = true;
    (async () => {
      const dateFrom = isoDate(0);
      const dateTo = isoDate(SLOT_LOOKAHEAD_DAYS);
      const results = await Promise.all(
        professors.map(async (p) => {
          try {
            const data = await getProfessorSlots(
              idToken,
              p.professorId,
              dateFrom,
              dateTo
            );
            const topics = new Set();
            const examPrepBySubject = new Map();
            for (const s of data.slots || []) {
              const cap = s.maxParticipants || 1;
              const cur = s.currentParticipants || 0;
              const slotType = s.consultationType || "general";

              if (slotType === "exam_prep" && cur < cap) {
                const subj = s.subject || "Exam prep";
                examPrepBySubject.set(
                  subj,
                  (examPrepBySubject.get(subj) || 0) + 1
                );
              }

              if (cap <= 1) continue;
              if (cur <= 0) continue;
              const ts = Array.isArray(s.topics) && s.topics.length
                ? s.topics
                : s.topic
                  ? [s.topic]
                  : [];
              for (const t of ts) {
                if (t && t.trim()) topics.add(t.trim());
              }
            }
            return [
              p.professorId,
              {
                topics: [...topics],
                examPrep: [...examPrepBySubject.entries()].map(
                  ([subject, count]) => ({ subject, count })
                ),
              },
            ];
          } catch {
            return [p.professorId, { topics: [], examPrep: [] }];
          }
        })
      );
      if (!alive) return;
      setGroupInfoByProfId(new Map(results));
    })();
    return () => {
      alive = false;
    };
  }, [idToken, professors]);

  // Pull the student's existing reservations so we can flag slots they
  // already booked. The effect re-runs whenever the chatbot reports a
  // booking-mutating tool (book_slot / join_group_session /
  // cancel_consultation) via bookingTick — that's how the "Reserve"
  // button on the slot card flips to "Already reserved" the moment the
  // student confirms in the assistant, no page refresh required.
  // Failures are silent — worst case the UI still shows a "Reserve"
  // button and the backend rejects the duplicate booking.
  useEffect(() => {
    if (!idToken || user?.role !== "student") return;
    let alive = true;
    (async () => {
      try {
        const [cons, wl] = await Promise.all([
          getMyConsultations(idToken),
          getMyWaitlist(idToken).catch(() => ({ entries: [] })),
        ]);
        if (!alive) return;
        const ids = new Set(
          (cons.consultations || [])
            .filter((c) => c.status !== "cancelled")
            .map((c) => c.slotSK)
            .filter(Boolean)
        );
        setBookedSlotIds(ids);
        const wlIds = new Set(
          (wl.entries || []).map((e) => e.slotSK).filter(Boolean)
        );
        setWaitlistedSlotIds(wlIds);
      } catch {
        /* noop */
      }
    })();
    return () => {
      alive = false;
    };
  }, [idToken, user?.role, bookingTick]);

  // Refetch the selected professor's slots whenever the chatbot makes
  // a booking-mutating tool call. Without this, the slot the student
  // just booked still renders as "Available" until they refresh the
  // page. We deliberately key off `selected?.professorId` (not the
  // whole object) so unrelated state changes don't trigger an extra
  // network round-trip.
  useEffect(() => {
    if (!idToken || !selected?.professorId) return undefined;
    if (bookingTick === 0) return undefined;
    let alive = true;
    (async () => {
      try {
        const data = await getProfessorSlots(
          idToken,
          selected.professorId,
          isoDate(0),
          isoDate(SLOT_LOOKAHEAD_DAYS)
        );
        if (alive) setSlots(data.slots || []);
      } catch {
        /* fall back to stale list — error already surfaced elsewhere */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingTick]);

  async function pick(p) {
    setSelected(p);
    setSlots([]);
    setError("");
    setSlotsLoading(true);
    try {
      const data = await getProfessorSlots(
        idToken,
        p.professorId,
        isoDate(0),
        isoDate(SLOT_LOOKAHEAD_DAYS)
      );
      setSlots(data.slots || []);
    } catch (err) {
      setError(err.message || "Could not load sessions.");
    } finally {
      setSlotsLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return professors;
    return professors.filter((p) => {
      const haystack = [
        p.name || "",
        p.department || "",
        ...(p.subjects || []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [professors, query]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of slots) {
      const key = s.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    }
    return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [slots]);

  // First slot in the future that is still bookable — used to render the
  // "Next available session" highlight at the top of the panel.
  const nextAvailable = useMemo(() => {
    const now = new Date();
    return slots.find((s) => {
      const max = s.maxParticipants || 1;
      const cur = s.currentParticipants || 0;
      if (s.status === "full" || cur >= max) return false;
      if (!s.date || !s.time) return false;
      const [hh, mm] = s.time.split(":").map(Number);
      const inst = new Date(`${s.date}T00:00:00`);
      inst.setHours(hh || 0, mm || 0, 0, 0);
      return inst.getTime() > now.getTime();
    });
  }, [slots]);

  const isOwnProfile =
    user &&
    user.role === "professor" &&
    selected &&
    selected.professorId === user.userId;

  const isStudent = user?.role === "student";

  function openEdit(slotId, currentMax) {
    setEditingSlotId(slotId);
    setEditValue(String(currentMax + 1));
    setTimeout(() => editInputRef.current && editInputRef.current.focus(), 50);
  }

  function closeEdit() {
    setEditingSlotId(null);
    setEditValue("");
  }

  async function saveCapacity(slotId, currentMax) {
    const next = parseInt(editValue, 10);
    if (!Number.isInteger(next) || next <= currentMax) return;
    setEditSaving(true);
    try {
      await updateSlotCapacity(idToken, selected.professorId, slotId, next);
      setSlots((prev) =>
        prev.map((s) => {
          if (s.slotId !== slotId) return s;
          const newStatus =
            (s.currentParticipants || 0) >= next ? "full" : "available";
          return { ...s, maxParticipants: next, status: newStatus };
        })
      );
      closeEdit();
    } catch (err) {
      setError(err.message || "Could not update capacity.");
    } finally {
      setEditSaving(false);
    }
  }

  // Reserving a slot now hands off to the floating Academic Assistant:
  // it pops the chatbot open with a pre-filled message describing who and
  // when, and the assistant runs the rest of the booking flow (asks for
  // the topic, verifies the slot, confirms, books). This keeps every
  // booking in one place and avoids a second confirm-modal codepath.
  function openBooking(slot) {
    if (!selected || !slot) return;
    const message = buildBookingMessage(selected, slot);
    if (message) openWidget(message);
  }

  // Waitlist composer — when a slot is full, instead of "Reserve" we offer
  // "Join waitlist" inline. The waitlist is notify-only, so we don't
  // collect topic/note here; the panel just asks for an explicit confirm
  // and POSTs to the manage-waitlist Lambda. We keep the widget out of
  // the loop on purpose: joining a waitlist isn't the same as booking,
  // so it shouldn't open the chat.
  function openWaitlist(slot) {
    setWaitlistOpenSlotId(slot.slotId);
    setWaitlistError("");
  }

  function closeWaitlist() {
    setWaitlistOpenSlotId(null);
    setWaitlistError("");
  }

  async function confirmJoinWaitlist(slot) {
    if (!selected || !slot || waitlistSubmitting) return;
    setWaitlistSubmitting(true);
    setWaitlistError("");
    try {
      await joinWaitlist(idToken, selected.professorId, slot.slotId, {});
      setWaitlistedSlotIds((prev) => {
        const next = new Set(prev);
        next.add(slot.slotId);
        return next;
      });
      closeWaitlist();
    } catch (err) {
      setWaitlistError(
        err?.message || "Could not join the waitlist. Try again."
      );
    } finally {
      setWaitlistSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Faculty directory"
        title="Office hours & available sessions"
        lead="Browse the faculty directory by name, department, or subject. Select a professor to see their published office hours for the next two weeks, and reserve a session directly."
      />

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span className={styles.searchIcon} aria-hidden>
            ⌕
          </span>
          <input
            type="search"
            placeholder="Search by name, department, or subject…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={styles.searchInput}
          />
        </div>
        <div className={styles.count}>
          {loading ? "—" : `${filtered.length} / ${professors.length}`}
          <span className={styles.countLabel}>professors</span>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.layout}>
        <section className={styles.roster} aria-label="Professor list">
          {loading && (
            <div className={styles.skeletonList}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={styles.skeletonCard} />
              ))}
            </div>
          )}

          {!loading && filtered.length === 0 && (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No matches.</p>
              <span>Try a different name, department, or subject.</span>
            </div>
          )}

          <ul className={styles.list}>
            {filtered.map((p, i) => {
              const active =
                selected && selected.professorId === p.professorId;
              const groupInfo = groupInfoByProfId.get(p.professorId) || {
                topics: [],
                examPrep: [],
              };
              const groupTopics = groupInfo.topics || [];
              const examPrep = groupInfo.examPrep || [];
              const visibleTopics = groupTopics.slice(0, 3);
              const extraTopics = Math.max(0, groupTopics.length - 3);
              return (
                <li
                  key={p.professorId}
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <button
                    type="button"
                    onClick={() => pick(p)}
                    className={`${styles.card} ${
                      active ? styles.cardActive : ""
                    }`}
                  >
                    <span className={styles.avatar} aria-hidden>
                      {initials(p.name)}
                    </span>
                    <span className={styles.cardBody}>
                      <span className={styles.cardName}>
                        {p.name || "(no name)"}
                      </span>
                      {p.department && (
                        <span className={styles.cardDept}>{p.department}</span>
                      )}
                      {p.subjects && p.subjects.length > 0 && (
                        <span className={styles.cardChips}>
                          {p.subjects.slice(0, 3).map((s) => (
                            <span key={s} className={styles.chip}>
                              {s}
                            </span>
                          ))}
                          {p.subjects.length > 3 && (
                            <span className={styles.chipMore}>
                              +{p.subjects.length - 3}
                            </span>
                          )}
                        </span>
                      )}
                      {examPrep.length > 0 && (
                        <span
                          className={styles.cardTopics}
                          title="Open exam-prep blocks in the next two weeks"
                        >
                          <span className={styles.cardTopicsLabel} aria-hidden>
                            Exam prep
                          </span>
                          <span className={styles.cardTopicsChips}>
                            {examPrep.slice(0, 3).map(({ subject }) => (
                              <span
                                key={subject}
                                className={`${styles.topicChip} ${styles.topicChipPrep}`}
                              >
                                {subject}
                              </span>
                            ))}
                            {examPrep.length > 3 && (
                              <span className={styles.chipMore}>
                                +{examPrep.length - 3}
                              </span>
                            )}
                          </span>
                        </span>
                      )}
                      {visibleTopics.length > 0 && (
                        <span
                          className={styles.cardTopics}
                          title="Topics being discussed in active group sessions"
                        >
                          <span
                            className={styles.cardTopicsLabel}
                            aria-hidden
                          >
                            Group topics
                          </span>
                          <span className={styles.cardTopicsChips}>
                            {visibleTopics.map((t) => (
                              <span key={t} className={styles.topicChip}>
                                {t}
                              </span>
                            ))}
                            {extraTopics > 0 && (
                              <span className={styles.chipMore}>
                                +{extraTopics}
                              </span>
                            )}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className={styles.cardArrow} aria-hidden>
                      →
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <aside
          className={`${styles.panel} ${selected ? styles.panelActive : ""}`}
          aria-label="Sessions for selected professor"
        >
          {!selected ? (
            <div className={styles.panelEmpty}>
              <p className={styles.eyebrow}>Available sessions</p>
              <p className={styles.panelEmptyTitle}>
                Select a professor to view sessions.
              </p>
              <p className={styles.panelEmptyHint}>
                Once selected, this panel lists each published office-hour
                block for the next two weeks, with topic, capacity, and a
                Reserve button when seats are still open.
              </p>
            </div>
          ) : (
            <>
              <div className={styles.panelHead}>
                <p className={styles.eyebrow}>Office hours · next 14 days</p>
                <h2 className={styles.panelTitle}>{selected.name}</h2>
                {selected.department && (
                  <p className={styles.panelDept}>{selected.department}</p>
                )}
                {selected.subjects && selected.subjects.length > 0 && (
                  <p className={styles.panelSubjects}>
                    {selected.subjects.join(" · ")}
                  </p>
                )}
              </div>

              {slotsLoading && (
                <div className={styles.panelLoading}>
                  <span />
                  <span />
                  <span />
                </div>
              )}

              {!slotsLoading && nextAvailable && (
                <div className={styles.nextHint}>
                  <span className={styles.nextHintLabel}>
                    Next available session
                  </span>
                  <span className={styles.nextHintBody}>
                    {weekdayShort(nextAvailable.date)} ·{" "}
                    {dayNumber(nextAvailable.date)}{" "}
                    {monthShort(nextAvailable.date)} · {nextAvailable.time}
                  </span>
                </div>
              )}

              {!slotsLoading && grouped.length === 0 && (
                <div className={styles.empty}>
                  <p className={styles.emptyTitle}>
                    No office hours scheduled yet.
                  </p>
                  <span>
                    This professor has not published sessions for the next
                    two weeks.
                  </span>
                </div>
              )}

              <div className={styles.days}>
                {grouped.map(([date, daySlots]) => (
                  <article key={date} className={styles.day}>
                    <header className={styles.dayHead}>
                      <div className={styles.stamp}>
                        <span className={styles.stampDay}>
                          {dayNumber(date)}
                        </span>
                        <span className={styles.stampMonth}>
                          {monthShort(date)}
                        </span>
                      </div>
                      <div className={styles.dayMeta}>
                        <span className={styles.dayWeek}>
                          {weekdayShort(date)}
                        </span>
                        <span className={styles.dayDate}>{date}</span>
                      </div>
                    </header>

                    <DaySlots
                      daySlots={daySlots}
                      renderSlot={(s) => {
                        const state = slotState(s);
                        const copy = STATE_COPY[state];
                        const cap = s.maxParticipants || 1;
                        const cur = s.currentParticipants || 0;
                        const slotType = s.consultationType || "general";
                        const canExpand =
                          isOwnProfile &&
                          (state === "partial" || state === "full");
                        const isEditing = editingSlotId === s.slotId;
                        const editNext = parseInt(editValue, 10);
                        const editValid =
                          Number.isInteger(editNext) && editNext > cap;

                        const alreadyBooked =
                          isStudent && bookedSlotIds.has(s.slotId);
                        const onWaitlist =
                          isStudent && waitlistedSlotIds.has(s.slotId);
                        const canReserve =
                          isStudent &&
                          state !== "full" &&
                          !alreadyBooked &&
                          !isEditing;
                        // Full + not booked + not already waitlisted →
                        // student can join the waitlist. Already-booked
                        // students never see the waitlist button (they
                        // have a seat, joining would be nonsense).
                        const canJoinWaitlist =
                          isStudent &&
                          state === "full" &&
                          !alreadyBooked &&
                          !onWaitlist &&
                          !isEditing;
                        const showReserveDisabled =
                          isStudent &&
                          alreadyBooked &&
                          !isEditing;
                        const showOnWaitlistBadge =
                          isStudent && onWaitlist && !isEditing;
                        const isWaitlistOpen =
                          waitlistOpenSlotId === s.slotId;

                        const headline = (() => {
                          if (slotType === "exam_prep") {
                            return s.subject
                              ? `Exam prep · ${s.subject}`
                              : "Exam prep";
                          }
                          if (slotType === "thesis") {
                            return "Thesis consultation";
                          }
                          return s.topic || (state === "free"
                            ? "Open consultation"
                            : "—");
                        })();

                        return (
                          <li
                            key={s.slotId}
                            className={`${styles.slot} ${
                              styles[copy.className]
                            } ${isEditing ? styles.slotEditing : ""}`}
                          >
                            <span className={styles.slotTime}>{s.time}</span>
                            <span className={styles.slotMid}>
                              <span className={styles.slotTopic}>
                                {headline}
                              </span>
                              {slotType !== "general" && (
                                <span
                                  className={`${styles.typeChip} ${
                                    slotType === "exam_prep"
                                      ? styles.typeChipPrep
                                      : styles.typeChipThesis
                                  }`}
                                >
                                  {TYPE_LABEL[slotType]}
                                </span>
                              )}
                              {/* Capacity hint: published cap on its own
                                  doesn't make a slot a "group session" —
                                  that label only applies once 2+ students
                                  actually share the time. So we just show
                                  the raw "X/Y reserved" count for any
                                  multi-cap slot, and keep the "Reserved"
                                  label for a filled 1-on-1 slot. */}
                              {(cap > 1 || (cap === 1 && cur > 0)) && (
                                <span className={styles.slotMetaRow}>
                                  <span className={styles.slotPeople}>
                                    {cap > 1
                                      ? `${cur}/${cap} reserved`
                                      : "Reserved"}
                                  </span>
                                </span>
                              )}
                            </span>

                            {/* Professor (own profile) — capacity editor */}
                            {canExpand && !isEditing && (
                              <button
                                type="button"
                                className={styles.expandBtn}
                                onClick={() => openEdit(s.slotId, cap)}
                                title="Increase capacity"
                                aria-label="Increase session capacity"
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 14 14"
                                  fill="none"
                                  aria-hidden="true"
                                >
                                  <circle
                                    cx="7"
                                    cy="7"
                                    r="6"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                  />
                                  <path
                                    d="M7 4v6M4 7h6"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                  />
                                </svg>
                              </button>
                            )}

                            {/* Student — Reserve button (or disabled fallback) */}
                            {canReserve && (
                              <button
                                type="button"
                                className={styles.reserveBtn}
                                onClick={() => openBooking(s)}
                              >
                                Reserve
                              </button>
                            )}
                            {canJoinWaitlist && (
                              <button
                                type="button"
                                className={styles.waitlistBtn}
                                onClick={() => openWaitlist(s)}
                                title="Get notified when a seat opens"
                              >
                                Join waitlist
                              </button>
                            )}
                            {showOnWaitlistBadge && (
                              <button
                                type="button"
                                className={`${styles.reserveBtn} ${styles.reserveBtnDisabled}`}
                                disabled
                              >
                                On waitlist
                              </button>
                            )}
                            {showReserveDisabled && (
                              <button
                                type="button"
                                className={`${styles.reserveBtn} ${styles.reserveBtnDisabled}`}
                                disabled
                              >
                                Already reserved
                              </button>
                            )}

                            {/* Non-student / non-owner viewers — status badge */}
                            {!canExpand &&
                              !canReserve &&
                              !canJoinWaitlist &&
                              !showOnWaitlistBadge &&
                              !showReserveDisabled &&
                              !isEditing && (
                                <span
                                  className={`${styles.stateBadge} ${
                                    styles[copy.className + "Badge"]
                                  }`}
                                >
                                  {copy.label}
                                </span>
                              )}

                            {/* Inline waitlist confirm — opens below the
                                row when the student clicks Join waitlist.
                                The waitlist is notify-only, so we just
                                confirm intent; no topic/note collection. */}
                            {isWaitlistOpen && (
                              <div className={styles.waitlistComposer}>
                                <p className={styles.waitlistHint}>
                                  This slot is full. Joining the waitlist
                                  will notify you if a seat opens — you'll
                                  still need to confirm the booking from
                                  the notification.
                                </p>
                                {waitlistError && (
                                  <p className={styles.waitlistError}>
                                    {waitlistError}
                                  </p>
                                )}
                                <div className={styles.waitlistActions}>
                                  <button
                                    type="button"
                                    onClick={closeWaitlist}
                                    disabled={waitlistSubmitting}
                                    className={styles.waitlistCancel}
                                  >
                                    Back
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => confirmJoinWaitlist(s)}
                                    disabled={waitlistSubmitting}
                                    className={styles.waitlistConfirm}
                                  >
                                    {waitlistSubmitting
                                      ? "Joining…"
                                      : "Join waitlist"}
                                  </button>
                                </div>
                              </div>
                            )}

                            {isEditing && (
                              <div className={styles.capacityEditor}>
                                <label className={styles.capacityLabel}>
                                  New max
                                </label>
                                <input
                                  ref={editInputRef}
                                  type="number"
                                  min={cap + 1}
                                  value={editValue}
                                  onChange={(e) =>
                                    setEditValue(e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && editValid)
                                      saveCapacity(s.slotId, cap);
                                    if (e.key === "Escape") closeEdit();
                                  }}
                                  className={styles.capacityInput}
                                  disabled={editSaving}
                                  aria-label="New maximum participants"
                                />
                                <button
                                  type="button"
                                  onClick={() => saveCapacity(s.slotId, cap)}
                                  disabled={!editValid || editSaving}
                                  className={styles.capacitySave}
                                >
                                  {editSaving ? "…" : "Save"}
                                </button>
                                <button
                                  type="button"
                                  onClick={closeEdit}
                                  disabled={editSaving}
                                  className={styles.capacityCancel}
                                >
                                  ✕
                                </button>
                              </div>
                            )}
                          </li>
                        );
                      }}
                    />
                  </article>
                ))}
              </div>

              {grouped.length > 0 && isStudent && (
                <p className={styles.panelHint}>
                  Need help finding the right session? Ask the{" "}
                  <a href="/chat">Academic Assistant</a>.
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
