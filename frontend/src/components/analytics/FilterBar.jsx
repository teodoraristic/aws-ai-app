import styles from "./analytics.module.css";

const RANGE_OPTIONS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const GROUP_OPTIONS = [
  { value: "all", label: "All" },
  { value: "individual", label: "1-on-1" },
  { value: "group", label: "Group" },
];

// Map the raw enum keys the backend now returns ("general", "exam_prep",
// "thesis") to display labels in the dropdown. Falls back to the raw key
// for any value the frontend doesn't know about, so a future "graded_work"
// added server-side would still render (just not prettily).
const TYPE_LABELS = {
  general: "General",
  exam_prep: "Exam prep",
  thesis: "Thesis",
};

function Segment({ options, value, onChange, ariaLabel }) {
  return (
    <div className={styles.segment} role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={`${styles.segmentBtn} ${
              active ? styles.segmentBtnActive : ""
            }`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function FilterBar({
  filters,
  onChange,
  onReset,
  availableTypes = [],
  professors = [],
  showProfessor = false,
  disabled = false,
}) {
  const update = (patch) => onChange({ ...filters, ...patch });

  return (
    <div
      className={styles.filterBar}
      aria-label="Analytics filters"
      role="group"
      aria-disabled={disabled || undefined}
    >
      <div className={styles.filterGroup}>
        <span className={styles.filterLabel}>Date range</span>
        <Segment
          ariaLabel="Date range"
          options={RANGE_OPTIONS}
          value={filters.range}
          onChange={(value) => update({ range: value })}
        />
      </div>

      <div className={styles.filterGroup}>
        <span className={styles.filterLabel}>Format</span>
        <Segment
          ariaLabel="Group or individual sessions"
          options={GROUP_OPTIONS}
          value={filters.group}
          onChange={(value) => update({ group: value })}
        />
      </div>

      <div className={styles.filterGroup}>
        <span className={styles.filterLabel}>Consultation type</span>
        <select
          className={styles.filterSelect}
          value={filters.type}
          onChange={(e) => update({ type: e.target.value })}
          disabled={disabled}
        >
          <option value="all">All types</option>
          {availableTypes.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t] || t}
            </option>
          ))}
        </select>
      </div>

      {showProfessor && (
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Professor</span>
          <select
            className={styles.filterSelect}
            value={filters.professorId || ""}
            onChange={(e) =>
              update({ professorId: e.target.value || null })
            }
            disabled={disabled}
          >
            <option value="">All professors</option>
            {professors.map((p) => (
              <option key={p.professorId} value={p.professorId}>
                {p.name}
                {p.department ? ` · ${p.department}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        className={styles.filterReset}
        onClick={onReset}
        disabled={disabled}
      >
        Reset
      </button>
    </div>
  );
}
