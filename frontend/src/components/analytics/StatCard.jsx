import styles from "./analytics.module.css";

// Headline number card. The `tone` prop tints the card to match a status
// (booked = sage, cancelled = danger, occupancy = accent).
//
// When `progress` (0-100) is provided we render a thin progress bar
// underneath the value — same visual language as MyConsultations' capacity
// widget so the analytics page doesn't feel foreign.
export default function StatCard({
  label,
  value,
  hint,
  tone,
  progress,
  progressTone = "ink",
}) {
  const toneClass =
    tone === "accent"
      ? styles.statCardAccent
      : tone === "sage"
      ? styles.statCardSage
      : tone === "danger"
      ? styles.statCardDanger
      : "";

  const fillClass =
    progressTone === "accent"
      ? styles.progressFillAccent
      : progressTone === "sage"
      ? styles.progressFillSage
      : "";

  const isProgress = typeof progress === "number";
  const safePct = Math.max(0, Math.min(100, isProgress ? progress : 0));

  return (
    <div
      className={`${styles.statCard} ${toneClass} ${
        isProgress ? styles.statCardProgress : ""
      }`}
    >
      <p className={styles.statCardLabel}>{label}</p>
      <p className={styles.statCardValue}>{value}</p>

      {isProgress && (
        <div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={safePct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className={`${styles.progressFill} ${fillClass}`}
              style={{ width: `${safePct}%` }}
            />
          </div>
          <div className={styles.progressMeta}>
            <span>{hint || "occupancy"}</span>
            <span>{safePct}%</span>
          </div>
        </div>
      )}

      {!isProgress && hint && <p className={styles.statCardHint}>{hint}</p>}
    </div>
  );
}
