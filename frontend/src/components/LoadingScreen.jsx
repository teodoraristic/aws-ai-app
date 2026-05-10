import styles from "./LoadingScreen.module.css";

export default function LoadingScreen({
  label = "Loading",
  hint = "One moment — preparing your workspace.",
}) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <div className={styles.mark} aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className={styles.label}>{label}</div>
      <div className={styles.hint}>{hint}</div>
    </div>
  );
}
