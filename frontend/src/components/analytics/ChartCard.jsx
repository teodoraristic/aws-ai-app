import styles from "./analytics.module.css";
import EmptyState from "./EmptyState.jsx";

// Card wrapper for any chart. Handles the framing (eyebrow + title +
// optional hint), the responsive body slot, and the "no data" fallback so
// individual chart components stay focused on rendering bars/lines.
export default function ChartCard({
  eyebrow,
  title,
  hint,
  isEmpty,
  emptyTitle = "No data yet",
  emptyHint = "Once bookings are made, this chart will populate.",
  children,
  bodyMinHeight = 240,
}) {
  return (
    <section className={styles.chartCard}>
      <header className={styles.chartCardHead}>
        <div className={styles.chartCardLeft}>
          {eyebrow && <p className={styles.chartCardEyebrow}>{eyebrow}</p>}
          <h3 className={styles.chartCardTitle}>{title}</h3>
        </div>
        {hint && <span className={styles.chartCardHint}>{hint}</span>}
      </header>

      <div
        className={styles.chartBody}
        style={{ minHeight: bodyMinHeight }}
      >
        {isEmpty ? (
          <EmptyState title={emptyTitle} hint={emptyHint} />
        ) : (
          children
        )}
      </div>
    </section>
  );
}
