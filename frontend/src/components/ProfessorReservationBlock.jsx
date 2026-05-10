import {
  dayNumber,
  monthShort,
  weekdayShort,
} from "../utils/format.js";
import styles from "./ProfessorReservationBlock.module.css";

// ── Professor reservation block (shared) ──────────────────────────
// One block = a contiguous run of office-hour slots that all carry at
// least one active or cancelled booking. Renders as a "publication
// section" — a date stamp + time range header above a list of slot
// rows. Used both on the Home dashboard preview (read-only) and on
// the My Reservations page (with editing affordances).
//
// Props:
//   block — shape:
//     {
//       date: "YYYY-MM-DD",
//       startMin: number,
//       endMin: number,
//       rows: [
//         {
//           group: consultation[],     // every booking on this slot
//           first: consultation,        // representative row
//           duration: number,
//         },
//       ],
//     }
//   index — animation stagger index.
//   manage — optional management bundle. When omitted the rows are
//            rendered read-only (no capacity editor, no cancel
//            composer, no action icons). The Home page passes nothing;
//            My Reservations passes the full bundle.
export default function ProfessorReservationBlock({ block, index = 0, manage }) {
  const activeRowCount = block.rows.filter((r) =>
    r.group.some((c) => c.status === "booked")
  ).length;

  return (
    <li
      className={styles.block}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <header className={styles.blockHead}>
        <div className={styles.stamp}>
          <span className={styles.stampDay}>{dayNumber(block.date)}</span>
          <span className={styles.stampMonth}>{monthShort(block.date)}</span>
        </div>
        <div className={styles.blockMeta}>
          <span className={styles.blockWeek}>{weekdayShort(block.date)}</span>
          <span className={styles.blockRange}>
            {formatHHMM(block.startMin)}
            <span className={styles.blockRangeDash} aria-hidden>
              {" – "}
            </span>
            {formatHHMM(block.endMin)}
          </span>
        </div>
        {activeRowCount === 0 ? (
          <span
            className={`${styles.blockCount} ${styles.blockCountCancelled}`}
          >
            Cancelled
          </span>
        ) : (
          <span className={styles.blockCount}>
            {activeRowCount === 1 ? "1 session" : `${activeRowCount} sessions`}
          </span>
        )}
      </header>

      <ul className={styles.blockRows}>
        {block.rows.map((row) => (
          <ProfessorReservationRow
            key={row.first.slotSK || row.first.consultationId}
            row={row}
            manage={manage}
          />
        ))}
      </ul>
    </li>
  );
}

function ProfessorReservationRow({ row, manage }) {
  const { group, first, duration } = row;
  const anyBooked = group.some((c) => c.status === "booked");
  const slotSK = first.slotSK;
  const cap = first.slotMaxParticipants;
  const cur =
    first.slotCurrentParticipants ??
    group.filter((c) => c.status === "booked").length;
  const bookedStudents = group.filter((c) => c.status === "booked");

  const isManage = Boolean(manage);
  const isEditing = isManage && manage.editingSlotSK === slotSK;
  const isWritingNote = isManage && manage.noteSlotSK === slotSK;
  const editNext = isManage ? parseInt(manage.editValue, 10) : NaN;
  const editValid = Number.isInteger(editNext) && editNext > cap;
  const bookedIds = group
    .filter((c) => c.status === "booked")
    .map((c) => c.consultationId);

  if (!anyBooked && group.length > 0) {
    return <CancelledRowTombstone group={group} first={first} duration={duration} />;
  }

  return (
    <li className={styles.proRow}>
      <div className={styles.proTime}>
        <span className={styles.proTimeStart}>{first.time || "—"}</span>
        <span className={styles.proTimeDur}>{duration}m</span>
      </div>

      <div className={styles.proBody}>
        <h3 className={styles.proTopic}>
          {first.topic || "Office hours"}
          {first.consultationType === "exam_prep" && (
            <span className={`${styles.typeChip} ${styles.typeChipPrep}`}>
              Exam prep
            </span>
          )}
          {first.consultationType === "thesis" && (
            <span className={`${styles.typeChip} ${styles.typeChipThesis}`}>
              Thesis
            </span>
          )}
        </h3>
        {first.subject && (
          <p className={styles.proSubject}>Subject: {first.subject}</p>
        )}

        {bookedStudents.length > 0 && (
          <ul className={styles.proStudents}>
            {bookedStudents.map((c) => {
              const studentLabel =
                c.studentName ||
                (c.studentId
                  ? `Student #${c.studentId.slice(0, 6)}`
                  : "Student");
              const personalTopic =
                c.topic && c.topic !== first.topic ? c.topic : null;
              return (
                <li key={c.consultationId} className={styles.proStudent}>
                  <span className={styles.proStudentDot} aria-hidden />
                  <span className={styles.proStudentName}>{studentLabel}</span>
                  {personalTopic && (
                    <span className={styles.proStudentTopic}>
                      — {personalTopic}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {first.note && first.note.trim() !== (first.topic || "").trim() && (
          <p className={styles.proNote}>“{first.note}”</p>
        )}

        <div className={styles.proMetaLine}>
          {cap !== undefined && (
            <span className={styles.proCount}>
              <strong>{cur}</strong>
              <span className={styles.proCountSep}>/</span>
              <span className={styles.proCountMax}>{cap}</span>
              <span className={styles.proCountUnit}>
                {cap === 1 ? "seat" : "seats"}
              </span>
            </span>
          )}
        </div>

        {isManage && cap !== undefined && isEditing && (
          <div className={styles.proEdit}>
            <span className={styles.proEditLabel}>
              New max — currently {cap}
            </span>
            <input
              ref={manage.editInputRef}
              type="number"
              min={cap + 1}
              value={manage.editValue}
              onChange={(e) => manage.setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editValid)
                  manage.saveCapacity(slotSK, first.professorId, cap);
                if (e.key === "Escape") manage.closeEdit();
              }}
              className={`${styles.proEditInput} ${
                !editValid && manage.editValue !== ""
                  ? styles.proEditInputError
                  : ""
              }`}
              disabled={manage.editSaving}
              aria-label="New maximum participants"
            />
            <button
              type="button"
              onClick={() => manage.saveCapacity(slotSK, first.professorId, cap)}
              disabled={!editValid || manage.editSaving}
              className={styles.proEditSave}
            >
              {manage.editSaving ? "…" : "Save"}
            </button>
            <button
              type="button"
              onClick={manage.closeEdit}
              disabled={manage.editSaving}
              className={styles.proEditDismiss}
              aria-label="Discard"
            >
              <CrossIcon />
            </button>
          </div>
        )}

        {isManage && isWritingNote && anyBooked && (
          <div className={styles.proCancelNote}>
            <label
              className={styles.proCancelNoteLabel}
              htmlFor={`note-${slotSK}`}
            >
              Note to{" "}
              {bookedStudents.length === 1
                ? bookedStudents[0].studentName || "the student"
                : `${bookedStudents.length} students`}
            </label>
            <textarea
              id={`note-${slotSK}`}
              ref={manage.noteInputRef}
              className={styles.proCancelNoteInput}
              value={manage.noteValue}
              onChange={(e) => manage.setNoteValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") manage.closeNote();
              }}
              placeholder="Optional — e.g. I'm out sick today, let's reschedule for next Tuesday."
              maxLength={240}
              rows={2}
              disabled={manage.noteSending}
            />
            <div className={styles.proCancelNoteRow}>
              <span className={styles.proCancelNoteHint}>
                Sent as a notification.{" "}
                <span className={styles.proCancelNoteCount}>
                  {manage.noteValue.length}/240
                </span>
              </span>
              <div className={styles.proCancelNoteActions}>
                <button
                  type="button"
                  onClick={manage.closeNote}
                  disabled={manage.noteSending}
                  className={styles.proCancelNoteBack}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => manage.sendCancelWithNote(bookedIds)}
                  disabled={manage.noteSending}
                  className={styles.proCancelNoteSend}
                >
                  {manage.noteSending ? "Cancelling…" : "Cancel session"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {isManage && (
        <div className={styles.proActions}>
          {cap !== undefined && !isEditing && (
            <button
              type="button"
              onClick={() => manage.openEdit(slotSK, cap)}
              className={styles.proIconBtn}
              aria-label="Increase slot capacity"
              title="Increase capacity"
            >
              <PlusIcon />
            </button>
          )}
          {anyBooked && !isWritingNote && (
            <button
              type="button"
              onClick={() => manage.openNote(slotSK)}
              className={`${styles.proIconBtn} ${styles.proIconBtnDanger}`}
              aria-label="Cancel session with a note"
              title="Cancel session"
            >
              <CrossIcon />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function CancelledRowTombstone({ group, first, duration }) {
  const cancelledRows = group.filter((c) => c.status === "cancelled");
  const profCancelled = cancelledRows.some(
    (c) => c.cancelledBy === "professor"
  );
  const studentNames = cancelledRows
    .filter((c) => c.cancelledBy !== "professor")
    .map(
      (c) =>
        c.studentName ||
        (c.studentId ? `Student #${c.studentId.slice(0, 6)}` : "Student")
    );
  const attribution = profCancelled
    ? "Cancelled by you"
    : studentNames.length === 0
      ? "Cancelled"
      : studentNames.length === 1
        ? `Cancelled by ${studentNames[0]}`
        : `Cancelled — ${studentNames.length} students dropped`;

  // Pick the most-recent reason from this slot's cancelled rows so the
  // professor sees what the student wrote without expanding anything.
  // Sort defensively by cancelledAt ISO string (lexicographically valid).
  const reasonCarrier = [...cancelledRows]
    .filter((c) => (c.cancellationReason || "").trim())
    .sort((a, b) =>
      (b.cancelledAt || "").localeCompare(a.cancelledAt || "")
    )[0];
  const reasonText = reasonCarrier?.cancellationReason || "";
  const reasonAuthor =
    reasonCarrier?.cancelledBy === "professor"
      ? "You"
      : reasonCarrier?.studentName ||
        (reasonCarrier?.studentId
          ? `Student #${reasonCarrier.studentId.slice(0, 6)}`
          : "Student");

  return (
    <li className={`${styles.proRow} ${styles.proRowCancelled}`}>
      <div className={styles.proTime}>
        <span className={styles.proTimeStart}>{first.time || "—"}</span>
        <span className={styles.proTimeDur}>{duration}m</span>
      </div>
      <div className={styles.proBody}>
        <h3 className={styles.proTopic}>{first.topic || "Office hours"}</h3>
        <p className={styles.proCancelledAttribution}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1 1l8 8M9 1L1 9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          {attribution}
        </p>
        {reasonText && (
          <p className={styles.proCancelledReason}>
            <span className={styles.proCancelledReasonLabel}>
              {reasonAuthor} wrote:
            </span>{" "}
            “{reasonText}”
          </p>
        )}
      </div>
      <div className={styles.proActions} aria-hidden />
    </li>
  );
}

function CrossIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.5 1.5l9 9M10.5 1.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 2v8M2 6h8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
