import { Link } from "react-router-dom";
import BrandMark from "./BrandMark.jsx";
import styles from "./AuthShell.module.css";

export default function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}) {
  return (
    <div className={styles.page}>
      <div className={styles.frame}>
        <Link to="/" className={styles.brand} aria-label="Home">
          <BrandMark size={32} />
          <span className={styles.brandWord}>Consultations</span>
        </Link>

        <div className={styles.card}>
          {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
          {title && (
            <h1 className={styles.title}>
              {title}
              <span className={styles.titleDot} aria-hidden>
                .
              </span>
            </h1>
          )}
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}

          <div className={styles.body}>{children}</div>

          {footer && <div className={styles.footer}>{footer}</div>}
        </div>

        <p className={styles.legal}>
          University booking platform · internal release
        </p>
      </div>
    </div>
  );
}
