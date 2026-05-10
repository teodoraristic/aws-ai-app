import styles from "./analytics.module.css";

// Compact empty placeholder rendered inside a chart card when there are no
// rows for the current filter selection. The page-level empty state is a
// separate, larger card on the Analytics page itself.
export default function EmptyState({ title = "No data yet", hint, fullPage = false }) {
  if (fullPage) {
    return (
      <section className={styles.pageEmpty}>
        <p className={styles.pageEmptyEyebrow}>Empty</p>
        <h2 className={styles.pageEmptyTitle}>{title}</h2>
        {hint && <p className={styles.pageEmptyHint}>{hint}</p>}
      </section>
    );
  }
  return (
    <div
      className={styles.emptyState}
      role="status"
      aria-live="polite"
    >
      <span className={styles.emptyStateIcon} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 11h8M5 8h4M4 5h6"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <p className={styles.emptyStateTitle}>{title}</p>
      {hint && <p className={styles.emptyStateHint}>{hint}</p>}
    </div>
  );
}
