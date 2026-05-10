import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import {
  cancelConsultation,
  getMyConsultations,
  updateSlotCapacity,
} from "../api.js";
import PageHeader from "../components/PageHeader.jsx";
import StudentReservationCard from "../components/StudentReservationCard.jsx";
import ProfessorReservationBlock from "../components/ProfessorReservationBlock.jsx";
import PastConsultationsFeedback from "../components/PastConsultationsFeedback.jsx";
import MyWaitlistPanel from "../components/MyWaitlistPanel.jsx";
import { buildProfessorBlocks } from "../utils/professorBlocks.js";
import styles from "./MyConsultations.module.css";

const COPY = {
  student: {
    eyebrow: "My schedule",
    title: "Your consultations",
    lead: (
      <>
        Your upcoming consultations with faculty. Cancelled sessions stay here
        as a record. Browse the{" "}
        <Link to="/professors">faculty directory</Link> to add another, or open
        the floating Academic Assistant to ask in plain language.
      </>
    ),
    statTotal: "total",
    statActive: "active",
    emptyEyebrow: "Empty schedule",
    emptyTitle: "No consultations yet.",
    emptyHint:
      "Browse the faculty directory or ask the Academic Assistant to find a session that fits your week.",
    emptyCta: { to: "/professors", label: "Browse faculty" },
  },
  professor: {
    eyebrow: "Reservations",
    title: "Sessions reserved with you",
    lead: (
      <>
        Students who have reserved your published office hours. Open the{" "}
        <Link to="/calendar">Calendar</Link> to publish new blocks or remove
        unbooked ones in a week-at-a-glance grid.
      </>
    ),
    statTotal: "reservations",
    statActive: "active",
    emptyEyebrow: "Quiet calendar",
    emptyTitle: "No reservations yet.",
    emptyHint:
      "Once students reserve a session you've published, you'll see them here.",
    emptyCta: { to: "/calendar", label: "Open calendar" },
  },
};

export default function MyConsultations() {
  const { idToken, user } = useAuth();
  const { bookingTick } = useChatWidget();
  const role = user?.role || "student";
  const copy = COPY[role] || COPY.student;
  const isProfessor = role === "professor";

  const [items, setItems] = useState([]);
  const [pastItems, setPastItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState("");

  const [editingSlotSK, setEditingSlotSK] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const editInputRef = useRef(null);

  // Cancel-with-note composer (professor view). Open one composer at a
  // time, keyed by the slot SK so the affordance lives inline next to
  // the row being cancelled. The note (if non-empty) becomes a
  // notification sent to every student booked on that slot.
  const [noteSlotSK, setNoteSlotSK] = useState(null);
  const [noteValue, setNoteValue] = useState("");
  const [noteSending, setNoteSending] = useState(false);
  const noteInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Fetch upcoming + recent-past in parallel: the main list shows the
      // upcoming window (current behaviour) and the feedback composer
      // pulls from the past window so finished sessions can be rated.
      const [upcoming, past] = await Promise.all([
        getMyConsultations(idToken, "upcoming"),
        getMyConsultations(idToken, "past").catch(() => ({
          consultations: [],
        })),
      ]);
      setItems(upcoming.consultations || []);
      setPastItems(past.consultations || []);
    } catch (err) {
      setError(err.message || "Could not load consultations.");
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch the consultation list whenever the chatbot reports a
  // booking-mutating tool call, so a session the student just booked /
  // joined / cancelled in the floating assistant shows up here without
  // a manual refresh.
  useEffect(() => {
    if (bookingTick === 0) return;
    load();
  }, [bookingTick, load]);

  async function onCancel(id, reason = "") {
    setCancelling(id);
    setError("");
    try {
      await cancelConsultation(idToken, id, reason);
      await load();
    } catch (err) {
      setError(err.message || "Could not cancel.");
    } finally {
      setCancelling("");
    }
  }

  function openNote(slotSK) {
    setNoteSlotSK(slotSK);
    setNoteValue("");
    setTimeout(() => noteInputRef.current && noteInputRef.current.focus(), 50);
  }

  function closeNote() {
    setNoteSlotSK(null);
    setNoteValue("");
  }

  async function sendCancelWithNote(bookedIds) {
    if (!bookedIds || bookedIds.length === 0) return;
    const reason = noteValue.trim();
    setNoteSending(true);
    setError("");
    try {
      // Cancel each booking on this slot in parallel and ship the same
      // reason to every affected student. We deliberately don't bail on
      // the first failure — we'd rather have partial cancels than zero.
      await Promise.allSettled(
        bookedIds.map((id) => cancelConsultation(idToken, id, reason))
      );
      closeNote();
      await load();
    } catch (err) {
      setError(err.message || "Could not cancel.");
    } finally {
      setNoteSending(false);
    }
  }

  function openEdit(slotSK, currentMax) {
    setEditingSlotSK(slotSK);
    setEditValue(String(currentMax + 1));
    setTimeout(() => editInputRef.current && editInputRef.current.focus(), 50);
  }

  function closeEdit() {
    setEditingSlotSK(null);
    setEditValue("");
  }

  async function saveCapacity(slotSK, professorId, currentMax) {
    const next = parseInt(editValue, 10);
    if (!Number.isInteger(next) || next <= currentMax) return;
    setEditSaving(true);
    try {
      await updateSlotCapacity(idToken, professorId, slotSK, next);
      setItems((prev) =>
        prev.map((c) =>
          c.slotSK === slotSK ? { ...c, slotMaxParticipants: next } : c
        )
      );
      closeEdit();
    } catch (err) {
      setError(err.message || "Could not update capacity.");
    } finally {
      setEditSaving(false);
    }
  }

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const da = `${a.date} ${a.time || ""}`;
      const db = `${b.date} ${b.time || ""}`;
      return da < db ? -1 : 1;
    });
  }, [items]);

  // Student sections — split into Upcoming / Past / Cancelled
  const { sectionUpcoming, sectionPast, sectionCancelled } = useMemo(() => {
    if (isProfessor) return { sectionUpcoming: [], sectionPast: [], sectionCancelled: [] };
    const nowMs = Date.now();
    const upcoming = [];
    const pastToday = [];
    const cancelled = [];
    for (const c of sorted) {
      if (c.status === "cancelled") { cancelled.push(c); continue; }
      const d = new Date(`${c.date}T${c.time || "00:00"}:00Z`);
      if (Number.isFinite(d.getTime()) && d.getTime() <= nowMs) {
        pastToday.push(c);
      } else {
        upcoming.push(c);
      }
    }
    // Past = today's completed (asc) + previous days from pastItems (desc by date)
    const prevDaysPast = [...(pastItems || [])]
      .filter((c) => c.status !== "cancelled")
      .sort((a, b) => {
        const da = `${a.date} ${a.time || ""}`;
        const db = `${b.date} ${b.time || ""}`;
        return da > db ? -1 : 1;
      });
    const allPast = [...pastToday.reverse(), ...prevDaysPast];
    return { sectionUpcoming: upcoming, sectionPast: allPast, sectionCancelled: cancelled };
  }, [sorted, pastItems, isProfessor]);

  const professorBlocks = useMemo(
    () => (isProfessor ? buildProfessorBlocks(sorted) : null),
    [sorted, isProfessor]
  );

  const stats = useMemo(() => {
    if (isProfessor) {
      const bySlot = new Map();
      for (const c of items) {
        const key = c.slotSK || c.consultationId;
        if (!bySlot.has(key)) bySlot.set(key, []);
        bySlot.get(key).push(c);
      }
      const slotGroups = [...bySlot.values()];
      const total = slotGroups.length;
      const booked = slotGroups.filter((g) =>
        g.some((c) => c.status === "booked")
      ).length;
      const cancelled = slotGroups.filter((g) =>
        g.every((c) => c.status === "cancelled")
      ).length;
      return { total, booked, cancelled };
    }
    return {
      total: sectionUpcoming.length + sectionPast.length + sectionCancelled.length,
      booked: sectionUpcoming.length,
      cancelled: sectionCancelled.length,
    };
  }, [items, isProfessor, sectionUpcoming, sectionPast, sectionCancelled]);

  const manage = isProfessor
    ? {
        editingSlotSK,
        editValue,
        editSaving,
        editInputRef,
        noteSlotSK,
        noteValue,
        noteSending,
        noteInputRef,
        setEditValue,
        setNoteValue,
        openEdit,
        closeEdit,
        saveCapacity,
        openNote,
        closeNote,
        sendCancelWithNote,
      }
    : null;

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={copy.title}
        lead={copy.lead}
      >
        <div className={styles.statRow}>
          <div className={styles.stat}>
            <span className={styles.statValue}>
              {loading ? "—" : stats.booked}
            </span>
            <span className={styles.statLabel}>{copy.statActive}</span>
          </div>
          {!isProfessor && stats.cancelled > 0 && (
            <>
              <div className={styles.statDivider} aria-hidden />
              <div className={styles.stat}>
                <span
                  className={`${styles.statValue} ${styles.statValueDim}`}
                >
                  {loading ? "—" : stats.cancelled}
                </span>
                <span className={styles.statLabel}>cancelled</span>
              </div>
            </>
          )}
          {isProfessor && (
            <>
              <div className={styles.statDivider} aria-hidden />
              <div className={styles.stat}>
                <span className={styles.statValue}>
                  {loading ? "—" : stats.total}
                </span>
                <span className={styles.statLabel}>{copy.statTotal}</span>
              </div>
            </>
          )}
        </div>
      </PageHeader>

      {error && <div className={styles.error}>{error}</div>}

      {loading && (
        <div className={styles.skeletonList}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      )}

      {!loading && !isProfessor &&
        sectionUpcoming.length === 0 && sectionPast.length === 0 && sectionCancelled.length === 0 && !error && (
        <section className={styles.empty}>
          <p className={styles.emptyEyebrow}>{copy.emptyEyebrow}</p>
          <h2 className={styles.emptyTitle}>{copy.emptyTitle}</h2>
          <p className={styles.emptyHint}>{copy.emptyHint}</p>
          <Link to={copy.emptyCta.to} className={styles.ctaLink}>
            {copy.emptyCta.label} <span aria-hidden>→</span>
          </Link>
        </section>
      )}

      {!loading && isProfessor && sorted.length === 0 && !error && (
        <section className={styles.empty}>
          <p className={styles.emptyEyebrow}>{copy.emptyEyebrow}</p>
          <h2 className={styles.emptyTitle}>{copy.emptyTitle}</h2>
          <p className={styles.emptyHint}>{copy.emptyHint}</p>
          <Link to={copy.emptyCta.to} className={styles.ctaLink}>
            {copy.emptyCta.label} <span aria-hidden>→</span>
          </Link>
        </section>
      )}

      {!loading && !isProfessor && sectionUpcoming.length > 0 && (
        <div className={styles.sectionGroup}>
          <div className={styles.sectionDivider}>
            <span className={styles.sectionLabel}>Upcoming</span>
            <span className={styles.sectionLine} aria-hidden />
            <span className={styles.sectionCount}>{sectionUpcoming.length}</span>
          </div>
          <ul className={styles.list}>
            {sectionUpcoming.map((c, i) => (
              <StudentReservationCard
                key={c.consultationId}
                c={c}
                index={i}
                onCancel={onCancel}
                cancelling={cancelling === c.consultationId}
              />
            ))}
          </ul>
        </div>
      )}

      {!loading && !isProfessor && sectionPast.length > 0 && (
        <div className={styles.sectionGroup}>
          <div className={styles.sectionDivider}>
            <span className={styles.sectionLabel}>Past</span>
            <span className={styles.sectionLine} aria-hidden />
            <span className={styles.sectionCount}>{sectionPast.length}</span>
          </div>
          <ul className={styles.list}>
            {sectionPast.map((c, i) => (
              <StudentReservationCard
                key={c.consultationId}
                c={c}
                index={i}
              />
            ))}
          </ul>
        </div>
      )}

      {!loading && !isProfessor && sectionCancelled.length > 0 && (
        <div className={styles.sectionGroup}>
          <div className={styles.sectionDivider}>
            <span className={styles.sectionLabel}>Cancelled</span>
            <span className={styles.sectionLine} aria-hidden />
            <span className={styles.sectionCount}>{sectionCancelled.length}</span>
          </div>
          <ul className={styles.list}>
            {sectionCancelled.map((c, i) => (
              <StudentReservationCard
                key={c.consultationId}
                c={c}
                index={i}
              />
            ))}
          </ul>
        </div>
      )}

      {!loading &&
        isProfessor &&
        professorBlocks &&
        professorBlocks.length > 0 && (
          <ul className={styles.blocks}>
            {professorBlocks.map((block, bi) => (
              <ProfessorReservationBlock
                key={`${block.date}T${block.startMin}`}
                block={block}
                index={bi}
                manage={manage}
              />
            ))}
          </ul>
        )}

      {!loading && !error && !isProfessor && (
        <MyWaitlistPanel
          idToken={idToken}
          role={role}
          refreshKey={bookingTick}
        />
      )}

      {!loading && !error && (
        <PastConsultationsFeedback
          consultations={pastItems}
          role={role}
          idToken={idToken}
          onSubmitted={load}
        />
      )}
    </div>
  );
}
