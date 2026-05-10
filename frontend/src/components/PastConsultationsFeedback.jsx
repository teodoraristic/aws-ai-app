import { useMemo, useState } from "react";
import { dayNumber, monthShort, weekdayShort } from "../utils/format.js";
import { submitConsultationFeedback } from "../api.js";
import styles from "./PastConsultationsFeedback.module.css";

// ── PastConsultationsFeedback ─────────────────────────────────────
//
// A collapsible section pinned to the bottom of MyConsultations that lets
// the current user fill in the feedback slice for sessions they've already
// attended. The two roles see different composers:
//   - student   → 1-5 star rating + optional comment
//   - professor → attendance toggle (yes / late / no) + optional note
//
// Both sides are gated server-side too (slot start instant must be in the
// past, only one submission per side), so the UI is a UX layer — the server
// is the source of truth.
//
// Props:
//   consultations — full row list returned by getMyConsultations (we filter
//                   for past + booked + missing-feedback rows here so the
//                   parent doesn't have to know the rules).
//   role          — "student" | "professor"
//   idToken       — Cognito ID token forwarded to the API helper.
//   onSubmitted   — called after a successful submission; the parent
//                   typically refetches the list so the row drops off.

function pastBookedRowsForRole(consultations, role) {
  if (!Array.isArray(consultations)) return [];
  const now = Date.now();
  return consultations.filter((c) => {
    if (!c) return false;
    if (c.status !== "booked") return false;
    if (!c.date) return false;
    const t = c.time || "00:00";
    // Mirror the server's combineSlotInstantUtc: treat date+time as UTC.
    const inst = new Date(`${c.date}T${t}:00Z`);
    if (Number.isNaN(inst.getTime())) return false;
    if (inst.getTime() > now) return false;
    if (role === "student") {
      return !c.studentFeedback;
    }
    if (role === "professor") {
      return !c.professorFeedback;
    }
    return false;
  });
}

export default function PastConsultationsFeedback({
  consultations,
  role,
  idToken,
  onSubmitted,
}) {
  const pending = useMemo(
    () => pastBookedRowsForRole(consultations, role),
    [consultations, role]
  );

  if (pending.length === 0) return null;

  return (
    <section className={styles.section} aria-label="Feedback for past sessions">
      <header className={styles.head}>
        <p className={styles.eyebrow}>Past consultations</p>
        <h2 className={styles.title}>
          {role === "student"
            ? "How were these sessions?"
            : "Did the students show up?"}
        </h2>
        <p className={styles.lead}>
          {role === "student"
            ? "Your rating helps the faculty office spot what's working — it's never shared with the professor by name."
            : "Marking attendance keeps the analytics honest and helps spot students who repeatedly miss sessions."}
        </p>
      </header>

      <ul className={styles.list}>
        {pending.map((c) => (
          <FeedbackCard
            key={c.consultationId}
            c={c}
            role={role}
            idToken={idToken}
            onSubmitted={onSubmitted}
          />
        ))}
      </ul>
    </section>
  );
}

function FeedbackCard({ c, role, idToken, onSubmitted }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  // Student state
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");

  // Professor state
  const [attended, setAttended] = useState("");
  const [note, setNote] = useState("");

  const partnerLabel =
    role === "student"
      ? c.professorName || "Faculty"
      : c.studentName ||
        (c.studentId ? `Student #${c.studentId.slice(0, 6)}` : "Student");

  const canSubmit =
    role === "student" ? rating >= 1 && rating <= 5 : !!attended;

  async function onSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const payload =
        role === "student"
          ? {
              rating,
              ...(comment.trim() ? { comment: comment.trim() } : {}),
            }
          : {
              attended,
              ...(note.trim() ? { note: note.trim() } : {}),
            };
      await submitConsultationFeedback(idToken, c.consultationId, payload);
      setDone(true);
      // Tiny visual delay so the "Thanks" state is perceivable before the
      // parent refetches and the card vanishes.
      setTimeout(() => {
        onSubmitted?.();
      }, 600);
    } catch (err) {
      setError(err.message || "Could not submit feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className={`${styles.card} ${done ? styles.cardDone : ""}`}>
      <div className={styles.stamp}>
        <span className={styles.stampWeek}>{weekdayShort(c.date)}</span>
        <span className={styles.stampDay}>{dayNumber(c.date)}</span>
        <span className={styles.stampMonth}>{monthShort(c.date)}</span>
      </div>

      <div className={styles.body}>
        <p className={styles.partner}>
          <span className={styles.partnerLabel}>
            {role === "student" ? "with" : "from"}
          </span>{" "}
          {partnerLabel}
        </p>
        <h3 className={styles.topic}>{c.topic || "Consultation"}</h3>
        <p className={styles.metaLine}>
          {c.time || "—"}
          {c.subject ? ` · ${c.subject}` : ""}
        </p>

        {done ? (
          <p className={styles.thanks}>Thanks — recorded.</p>
        ) : role === "student" ? (
          <div className={styles.composer}>
            <div className={styles.stars} role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  onClick={() => setRating(n)}
                  className={`${styles.star} ${
                    rating >= n ? styles.starActive : ""
                  }`}
                  title={`${n} star${n === 1 ? "" : "s"}`}
                  disabled={submitting}
                >
                  ★
                </button>
              ))}
              <span className={styles.starsHint}>
                {rating === 0
                  ? "Tap a star"
                  : rating === 5
                    ? "Excellent"
                    : rating === 1
                      ? "Poor"
                      : `${rating} / 5`}
              </span>
            </div>
            <textarea
              className={styles.textarea}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional — what worked, what could be better?"
              maxLength={600}
              rows={2}
              disabled={submitting}
            />
            <div className={styles.actionsRow}>
              {error && <p className={styles.error}>{error}</p>}
              <button
                type="button"
                className={styles.submit}
                onClick={onSubmit}
                disabled={!canSubmit || submitting}
              >
                {submitting ? "Sending…" : "Submit rating"}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.composer}>
            <div
              className={styles.attendOptions}
              role="radiogroup"
              aria-label="Attendance"
            >
              {[
                { value: "yes", label: "Showed up" },
                { value: "late", label: "Came late" },
                { value: "no", label: "No-show" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={attended === opt.value}
                  onClick={() => setAttended(opt.value)}
                  className={`${styles.attendBtn} ${
                    attended === opt.value ? styles.attendBtnActive : ""
                  } ${
                    opt.value === "no" && attended === "no"
                      ? styles.attendBtnDanger
                      : ""
                  }`}
                  disabled={submitting}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <textarea
              className={styles.textarea}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional — short note (e.g. came 15 min late, asked about exam)."
              maxLength={600}
              rows={2}
              disabled={submitting}
            />
            <div className={styles.actionsRow}>
              {error && <p className={styles.error}>{error}</p>}
              <button
                type="button"
                className={styles.submit}
                onClick={onSubmit}
                disabled={!canSubmit || submitting}
              >
                {submitting ? "Sending…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
