import { useCallback, useEffect, useMemo, useState } from "react";
import { getMyWaitlist, leaveWaitlist } from "../api.js";
import { useNotifications } from "../context/NotificationContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import styles from "./MyWaitlistPanel.module.css";

const TYPE_LABEL = {
  general: "General",
  exam_prep: "Exam prep",
  thesis: "Thesis",
};

// Format a date the same way the Reserve button on the faculty directory
// does, so the chat widget receives identical-looking hand-off messages
// from both surfaces and the assistant doesn't see two dialects.
function formatWhen(date, time) {
  if (!date) return "";
  try {
    const d = new Date(`${date}T${time || "00:00"}:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
    }
  } catch {
    /* fall through to ISO date */
  }
  return date;
}

// Mirror Professors.jsx#buildBookingMessage so the chatbot's
// pre-selected-slot SHORTCUT path treats both entrypoints identically.
// We deliberately keep this capacity-agnostic — the slot's actual cap
// is on the backend record, the assistant doesn't need it spelled out
// in the user-facing message.
function buildSeatOpenedMessage(entry) {
  if (!entry) return "";
  const when = formatWhen(entry.date, entry.time);
  const time = entry.time || "";
  const whenTime = time ? ` at ${time}` : "";
  const prof = entry.professorName || "the professor";
  return `I'd like to book a session with Professor ${prof} on ${when}${whenTime}.`;
}

// Format "moment a seat opened" relative to now, in the lightweight
// "3 min ago / 2h ago" cadence the rest of the app uses for transient
// signals. Falls back to "just now" if we can't parse the timestamp.
function formatRelative(iso) {
  if (!iso) return "just now";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) {
    const m = Math.round(diffSec / 60);
    return `${m} min ago`;
  }
  if (diffSec < 86400) {
    const h = Math.round(diffSec / 3600);
    return `${h}h ago`;
  }
  const d = Math.round(diffSec / 86400);
  return `${d}d ago`;
}

/**
 * Compact "On my waitlist" panel for students. Lists all the slots the
 * student joined a waitlist on, with a Leave button per row. We render
 * nothing at all when the list is empty so the panel doesn't clutter
 * the page for students who never used the feature.
 *
 * Mounting fetches the list once. The parent page already triggers a
 * refresh via `bookingTick`, but the waitlist isn't booking-driven so
 * we expose a `refreshKey` prop the parent can bump if it wants to
 * force a reload (e.g. after a cancellation that may free a seat the
 * student is queued for).
 *
 * Seat-opened cross-fade: the backend creates a `seat_opened`
 * notification (carrying the same `slotSK` we list here) the moment a
 * waitlisted student moves to the front of the queue. We pick that
 * signal up from NotificationContext and surface it inline on the
 * affected row instead of forcing the student to context-switch into
 * the bell menu — they're already on the page that holds their queue,
 * so a "Reserve now" CTA right there is the shortest path to acting.
 */
export default function MyWaitlistPanel({ idToken, role, refreshKey = 0 }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [leaving, setLeaving] = useState("");
  const [error, setError] = useState("");

  const { notifs, markRead } = useNotifications();
  const { openWidget } = useChatWidget();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getMyWaitlist(idToken);
      setEntries(data.entries || []);
    } catch (err) {
      setError(err?.message || "Could not load your waitlist.");
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    if (role !== "student" || !idToken) return;
    load();
  }, [load, role, idToken, refreshKey]);

  // Index seat_opened notifications by slotSK so each row's render is a
  // cheap O(1) lookup. We keep the LATEST per slot — if the same seat
  // opened twice (e.g. someone booked, cancelled, booked again), the
  // newest signal is the one the student should act on.
  const seatOpenedBySlot = useMemo(() => {
    const map = new Map();
    if (!Array.isArray(notifs)) return map;
    for (const n of notifs) {
      if (!n || n.type !== "seat_opened" || !n.slotSK) continue;
      const prev = map.get(n.slotSK);
      const prevTs = prev?.createdAt ? Date.parse(prev.createdAt) : 0;
      const curTs = n.createdAt ? Date.parse(n.createdAt) : 0;
      if (!prev || curTs >= prevTs) map.set(n.slotSK, n);
    }
    return map;
  }, [notifs]);

  if (role !== "student") return null;
  if (loading) return null;
  if (entries.length === 0) return null;

  const onLeave = async (entry) => {
    if (leaving) return;
    setLeaving(entry.slotSK);
    setError("");
    try {
      await leaveWaitlist(idToken, entry.professorId, entry.slotSK);
      setEntries((prev) => prev.filter((e) => e.slotSK !== entry.slotSK));
    } catch (err) {
      setError(err?.message || "Could not leave the waitlist.");
    } finally {
      setLeaving("");
    }
  };

  const onReserveOpenedSeat = (entry, notif) => {
    const message = buildSeatOpenedMessage(entry);
    if (message) openWidget(message);
    // Mark the notification read on click — the student is acting on
    // it, the bell badge shouldn't keep counting it. We don't await:
    // the optimistic flip in NotificationContext means the alert UI
    // updates instantly; the network call is fire-and-forget.
    if (notif?.id) markRead(notif.id);
  };

  return (
    <section className={styles.section} aria-label="On my waitlist">
      <header className={styles.header}>
        <p className={styles.eyebrow}>Heads up</p>
        <h2 className={styles.title}>On my waitlist</h2>
        <p className={styles.lead}>
          You'll get a notification the moment a seat opens. Joining the
          waitlist doesn't book the slot — you still need to reserve it
          when notified.
        </p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <ul className={styles.list}>
        {entries.map((e) => {
          const type = e.consultationType || "general";
          const typeLabel = TYPE_LABEL[type] || TYPE_LABEL.general;
          const seatOpened = seatOpenedBySlot.get(e.slotSK) || null;
          const reserveBusy = leaving === e.slotSK;
          return (
            <li
              key={e.slotSK}
              className={`${styles.row} ${seatOpened ? styles.rowAlert : ""}`}
            >
              {seatOpened && (
                <div className={styles.alertBanner} role="status">
                  <span className={styles.alertPulse} aria-hidden>
                    <span className={styles.alertDot} />
                    <span className={styles.alertRing} />
                  </span>
                  <span className={styles.alertText}>
                    <strong>Seat available now.</strong>{" "}
                    Opened {formatRelative(seatOpened.createdAt)} — reserve
                    before someone else does.
                  </span>
                </div>
              )}
              <div className={styles.rowBody}>
                <div className={styles.rowMain}>
                  <span className={styles.when}>
                    {e.date}
                    {e.time ? ` · ${e.time}` : ""}
                  </span>
                  <span className={styles.who}>
                    with{" "}
                    <strong>{e.professorName || "professor"}</strong>
                  </span>
                  {(type !== "general" || e.subject) && (
                    <span
                      className={`${styles.typeChip} ${
                        type === "thesis"
                          ? styles.typeChipThesis
                          : type === "exam_prep"
                          ? styles.typeChipPrep
                          : ""
                      }`}
                    >
                      {typeLabel}
                      {e.subject ? ` · ${e.subject}` : ""}
                    </span>
                  )}
                  {e.topic && (
                    <span className={styles.topic}>{e.topic}</span>
                  )}
                </div>
                <div className={styles.actions}>
                  {seatOpened && (
                    <button
                      type="button"
                      className={styles.reserveBtn}
                      onClick={() => onReserveOpenedSeat(e, seatOpened)}
                      disabled={reserveBusy}
                    >
                      Reserve now
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.leaveBtn}
                    onClick={() => onLeave(e)}
                    disabled={reserveBusy}
                  >
                    {reserveBusy ? "Leaving…" : "Leave"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
