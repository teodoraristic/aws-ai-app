// Tiny "shield + ribbon" mark used in the header brand and the chat
// widget FAB. Navy ground with a gold ornament keeps it on-brand with
// the rest of the editorial palette and reads as an institutional
// crest rather than a generic SaaS dot.
export default function BrandMark({ size = 32, className }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="brandGroundGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1B2A47" />
          <stop offset="100%" stopColor="#0E1A30" />
        </linearGradient>
        <linearGradient id="brandGoldGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#D7A23B" />
          <stop offset="100%" stopColor="#7A5318" />
        </linearGradient>
      </defs>

      {/* Navy shield ground with a soft inset highlight at the top so
          the mark catches a tiny bit of light, like an enamel pin. */}
      <rect
        x="0"
        y="0"
        width="32"
        height="32"
        rx="8"
        fill="url(#brandGroundGradient)"
      />
      <rect
        x="0.6"
        y="0.6"
        width="30.8"
        height="30.8"
        rx="7.4"
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="1.2"
      />

      {/* Serif "C" carved out of the gold disc — a typographic
          monogram for "Consultations" without spelling it out. */}
      <circle cx="16" cy="16" r="9" fill="url(#brandGoldGradient)" />
      <path
        d="M19.6 12.4a4.6 4.6 0 0 0-3.2-1.4 5.2 5.2 0 1 0 0 10.4 4.6 4.6 0 0 0 3.2-1.4"
        stroke="#0E1A30"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />

      {/* Tiny gold pin at the bottom-right — a quiet "active /
          working" marker reminiscent of an academic seal stamp. */}
      <circle cx="25" cy="25" r="2.2" fill="#D7A23B" />
      <circle cx="25" cy="25" r="0.8" fill="#FBF8F2" />
    </svg>
  );
}
