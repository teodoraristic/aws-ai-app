import styles from "./PageHeader.module.css";

// Shared editorial page header. One typographic ladder, one place to
// tweak. Every authenticated page renders its intro through this so
// the site reads as ONE journal across routes instead of N pages with
// N different title sizes.
//
// Slots:
//   eyebrow  — required, monospace, all-caps category line.
//   title    — required, serif display headline.
//   lead     — optional, supporting paragraph beneath the title.
//   meta     — optional, anything pinned to the right of the title row
//              (used by pages that want a Calendar CTA, a "View all"
//              link, or a small badge).
//   children — optional, anything rendered AFTER the lead, inside the
//              same animated header block (e.g. stat ribbons, toolbars).
//
// Variants:
//   size = "default" | "hero" — hero adds a touch more weight + lead
//                               width for the home page only.
export default function PageHeader({
  eyebrow,
  title,
  lead,
  meta,
  children,
  size = "default",
}) {
  return (
    <header
      className={`${styles.intro} ${size === "hero" ? styles.introHero : ""}`}
    >
      <div className={styles.titleRow}>
        <div className={styles.titleCol}>
          {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
          {title && (
            <h1 className={styles.title}>
              {title}
              <span className={styles.titleDot} aria-hidden>
                .
              </span>
            </h1>
          )}
        </div>
        {meta && <div className={styles.meta}>{meta}</div>}
      </div>

      {lead && <p className={styles.lead}>{lead}</p>}
      {children}
    </header>
  );
}
