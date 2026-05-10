import styles from "./analytics.module.css";

// Shimmer placeholder for the whole dashboard while the analytics call is
// in flight. Matches the shimmer used on Home / MyConsultations so the
// loading visuals stay consistent.
export default function LoadingState() {
  return (
    <div aria-label="Loading analytics" aria-busy="true">
      <div className={styles.skeletonGrid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={styles.skeletonStat} />
        ))}
      </div>
      <div className={styles.skeletonChartGrid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={styles.skeletonChart} />
        ))}
      </div>
    </div>
  );
}
