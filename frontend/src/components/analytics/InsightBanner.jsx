import styles from "./analytics.module.css";

/**
 * Renders the AI-generated narrative summary above the analytics grid.
 * The backend returns `null` when Bedrock isn't reachable or there isn't
 * enough data to summarise — we suppress the whole banner in that case
 * rather than showing a placeholder.
 *
 * The "Regenerate" link bypasses the 1-hour DDB cache server-side.
 */
export default function InsightBanner({ insight, onRegenerate, disabled }) {
  if (!insight || !insight.text) return null;
  return (
    <section className={styles.insightBanner} aria-label="AI insight">
      <div className={styles.insightInner}>
        <p className={styles.insightEyebrow}>
          Insight
          {insight.cached ? <span className={styles.insightCached}> · cached</span> : null}
        </p>
        <p className={styles.insightBody}>{insight.text}</p>
      </div>
      <button
        type="button"
        onClick={onRegenerate}
        className={styles.insightRegenerate}
        disabled={disabled}
        title="Bypasses the 1-hour cache and re-asks the model"
      >
        Regenerate
      </button>
    </section>
  );
}
