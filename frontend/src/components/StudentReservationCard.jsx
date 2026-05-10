import { useRef, useState } from "react";
import {
  dayNumber,
  initials,
  monthShort,
  statusLabel,
  weekdayShort,
} from "../utils/format.js";
import styles from "./StudentReservationCard.module.css";

// ── Student reservation card (shared) ─────────────────────────────
// Editorial layout — colour-coded rail + calendar stamp + body — used
// by both the Home upcoming list and the My Reservations page. Booked
// rows render with a gold rail, group sessions with a sage tint,
// cancelled rows render as muted tombstones.
//
// Props:
//   c          — consultation row (the shape returned by
//                getMyConsultations for a student).
//   onCancel   — optional handler. When omitted the cancel control is
//                hidden, which is what Home wants for its read-only
//                preview list.
//   cancelling — when true the cancel button shows the in-flight label.
//   index      — used for staggered entry animations on lists.
//   compact    — pass true to shrink the card chrome (smaller stamp,
//                tighter padding) for dashboard previews.
export default function StudentReservationCard({
  c,
  onCancel,
  cancelling = false,
  index = 0,
  compact = false,
}) {
  const isBooked = c.status === "booked";
  const isCancelled = c.status === "cancelled";
  const isPast = (() => {
    if (!isBooked || !c.date) return false;
    const d = new Date(`${c.date}T${c.time || "00:00"}:00Z`);
    return Number.isFinite(d.getTime()) && d.getTime() <= Date.now();
  })();
  const profName = c.professorName || "Faculty";
  const profDept = c.professorDepartment;
  const profInitials = initials(profName);

  // Inline cancel composer — clicking the "cancel" link opens an optional
  // reason textarea right inside the card. Keeps the affordance local
  // (no modal, no extra state plumbing) and the reason rides through
  // onCancel into the existing PATCH /consultations/{id} call.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const reasonInputRef = useRef(null);

  function openCancel() {
    setCancelOpen(true);
    setCancelReason("");
    setTimeout(() => reasonInputRef.current?.focus(), 50);
  }
  function closeCancel() {
    if (cancelling) return;
    setCancelOpen(false);
    setCancelReason("");
  }
  function confirmCancel() {
    if (cancelling) return;
    onCancel(c.consultationId, cancelReason.trim());
  }

  const cardClass = [
    styles.card,
    isBooked && !isPast && styles.cardBooked,
    isCancelled && styles.cardCancelled,
    isPast && styles.cardPast,
    c.isGroupSession && !isCancelled && !isPast && styles.cardGroup,
    compact && styles.cardCompact,
  ]
    .filter(Boolean)
    .join(" ");

  // Type chip is meaningful for exam_prep / thesis only; "general" is the
  // implicit baseline so we don't add visual clutter for it.
  const consultationType = c.consultationType || "general";
  const showTypeChip = consultationType !== "general";
  const typeChipLabel =
    consultationType === "exam_prep" ? "Exam prep" : "Thesis";
  const typeChipClass =
    consultationType === "exam_prep"
      ? styles.typeChipPrep
      : styles.typeChipThesis;

  return (
    <li
      className={cardClass}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className={styles.cardRail} aria-hidden />

      <div className={styles.cardStamp}>
        <span className={styles.cardStampWeek}>{weekdayShort(c.date)}</span>
        <span className={styles.cardStampDay}>{dayNumber(c.date)}</span>
        <span className={styles.cardStampMonth}>{monthShort(c.date)}</span>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardTopRow}>
          <div className={styles.profBlock}>
            <span className={styles.profAvatar} aria-hidden>
              {profInitials}
            </span>
            <div className={styles.profMeta}>
              <span className={styles.profLabel}>with</span>
              <span className={styles.profName}>{profName}</span>
              {profDept && <span className={styles.profDept}>{profDept}</span>}
            </div>
          </div>

          <div className={styles.cardTags}>
            {showTypeChip && !isCancelled && (
              <span className={`${styles.typeChip} ${typeChipClass}`}>
                {typeChipLabel}
              </span>
            )}
            {c.isGroupSession && !isCancelled && (
              <span className={styles.groupPill}>Group</span>
            )}
            <span
              className={`${styles.statusTag} ${
                isCancelled
                  ? styles.statusTagCancelled
                  : isPast
                    ? styles.statusTagPast
                    : styles.statusTagBooked
              }`}
            >
              {isCancelled && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden="true"
                  className={styles.statusTagIcon}
                >
                  <path
                    d="M1 1l8 8M9 1L1 9"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              {isCancelled
                ? c.cancelledBy === "professor"
                  ? "Cancelled by professor"
                  : c.cancelledBy === "student"
                    ? "Cancelled by you"
                    : statusLabel(c.status)
                : isPast
                  ? "Past"
                  : statusLabel(c.status)}
            </span>
          </div>
        </div>

        <h3 className={styles.cardTopic}>{c.topic || "Consultation"}</h3>

        {c.subject && (
          <p className={styles.cardSubject}>Subject: {c.subject}</p>
        )}

        {isCancelled && c.cancellationReason && (
          <p className={styles.cancelledReason}>
            <span className={styles.cancelledReasonLabel}>
              {c.cancelledBy === "professor" ? "Professor wrote" : "You wrote"}:
            </span>{" "}
            “{c.cancellationReason}”
          </p>
        )}

        <div className={styles.cardMetaRow}>
          <span className={styles.timeChip}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="6"
                cy="6"
                r="4.6"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M6 3.4V6l1.8 1.1"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {c.time || "—"}
          </span>
          {c.note && c.note.trim() !== (c.topic || "").trim() && (
            <span className={styles.cardNote} title={c.note}>
              “{c.note}”
            </span>
          )}
        </div>
      </div>

      {isBooked && !isPast && onCancel && !cancelOpen && (
        <button
          type="button"
          className={styles.cancel}
          onClick={openCancel}
          disabled={cancelling}
        >
          {cancelling ? "cancelling…" : "cancel"}
        </button>
      )}

      {isBooked && !isPast && onCancel && cancelOpen && (
        <div className={styles.cancelComposer}>
          <label className={styles.cancelLabel} htmlFor={`reason-${c.consultationId}`}>
            Reason <span className={styles.cancelLabelHint}>optional</span>
          </label>
          <textarea
            id={`reason-${c.consultationId}`}
            ref={reasonInputRef}
            className={styles.cancelInput}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeCancel();
            }}
            placeholder="e.g. I'm sick, I have a clash with another lecture, …"
            maxLength={240}
            rows={2}
            disabled={cancelling}
          />
          <div className={styles.cancelActions}>
            <button
              type="button"
              className={styles.cancelBack}
              onClick={closeCancel}
              disabled={cancelling}
            >
              Back
            </button>
            <button
              type="button"
              className={styles.cancelConfirm}
              onClick={confirmCancel}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel session"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
