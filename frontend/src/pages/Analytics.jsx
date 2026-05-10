import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import InsightBanner from "../components/analytics/InsightBanner.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import {
  getAdminAnalytics,
  getProfessorAnalytics,
} from "../api.js";
import { dayNumber, monthShort } from "../utils/format.js";
import StatCard from "../components/analytics/StatCard.jsx";
import ChartCard from "../components/analytics/ChartCard.jsx";
import FilterBar from "../components/analytics/FilterBar.jsx";
import EmptyState from "../components/analytics/EmptyState.jsx";
import LoadingState from "../components/analytics/LoadingState.jsx";
import filterStyles from "../components/analytics/analytics.module.css";
import PageHeader from "../components/PageHeader.jsx";
import styles from "./Analytics.module.css";

// Palette tokens lifted into JS so Recharts (which needs literal hex
// strings, not CSS variables) renders in the same colours as the rest of
// the app. Mirror /src/index.css.
const PALETTE = {
  ink: "#1a1f2e",
  ink2: "#4a5160",
  ink3: "#8b8f9c",
  line: "#e6dfcf",
  paper: "#ffffff",
  paperWarm: "#fbf6ec",
  accent: "#b85c38",
  accentDeep: "#8a3f24",
  accentSoft: "#f4dccd",
  sage: "#4a7c59",
  sageSoft: "#dde7df",
  danger: "#b91c1c",
};

// Categorical palette used wherever we render multiple series (consultation
// types, top topics, group/individual). Picked from the existing tokens so
// no new colours are introduced.
const SERIES = [
  PALETTE.ink,
  PALETTE.accent,
  PALETTE.sage,
  PALETTE.accentDeep,
  PALETTE.ink2,
  PALETTE.danger,
  PALETTE.ink3,
  PALETTE.accentSoft,
];

const DEFAULT_FILTERS = {
  range: "30d",
  type: "all",
  group: "all",
  professorId: null,
};

// Custom tooltip with the same card aesthetic as the rest of the dashboard.
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className={filterStyles.chartTooltip}>
      <p className={filterStyles.chartTooltipLabel}>{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className={filterStyles.chartTooltipValue}>
          {entry.name ? `${entry.name}: ` : ""}
          {entry.value}
        </p>
      ))}
    </div>
  );
}

function formatShortDate(iso) {
  const d = dayNumber(iso);
  const m = monthShort(iso);
  if (d === "—" || !m) return iso;
  return `${d} ${m}`;
}

export default function Analytics() {
  const { idToken, user } = useAuth();
  const role = user?.role || "student";
  const isAdmin = role === "admin";

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(
    async ({ nocache = false } = {}) => {
      setLoading(true);
      setErrorMsg("");
      try {
        const fn = isAdmin ? getAdminAnalytics : getProfessorAnalytics;
        const fetched = await fn(idToken, { ...filters, nocache });
        setData(fetched);
      } catch (err) {
        setErrorMsg(err.message || "Could not load analytics.");
      } finally {
        setLoading(false);
      }
    },
    [idToken, isAdmin, filters]
  );

  useEffect(() => {
    load();
  }, [load]);

  const onFiltersChange = (next) => setFilters(next);
  const onReset = () => setFilters(DEFAULT_FILTERS);
  const onRegenerateInsight = () => load({ nocache: true });

  // Pre-format chart-friendly versions of the API payload. Done at render
  // time on a small, cheap dataset; useMemo keeps repeated re-renders cheap
  // when the user toggles filters back and forth.
  const charts = useMemo(() => {
    if (!data) return null;
    const cancellations = data.cancellations || {};
    return {
      bookingsByType: (data.bookingsByType || []).map((d) => ({
        // bookingsByType now uses a stable enum key (`type`) plus a
        // human-readable `label`. Show the label on the axis so the
        // chart still reads naturally.
        name: d.label || d.type,
        bookings: d.count,
      })),
      bookingsBySubject: (data.bookingsBySubject || []).map((d) => ({
        name: d.subject,
        bookings: d.count,
      })),
      topTopics: (data.topTopics || []).map((d) => ({
        name: d.topic,
        bookings: d.count,
      })),
      bookingsOverTime: (data.bookingsOverTime || []).map((d) => ({
        name: formatShortDate(d.date),
        rawDate: d.date,
        bookings: d.count,
      })),
      groupVsIndividual: (data.groupVsIndividual || []).map((d) => ({
        name: d.type,
        value: d.count,
      })),
      slotOccupancy: (data.slotOccupancy || []).map((d) => ({
        name: d.type,
        value: d.count,
      })),
      cancellationLeadTime: (cancellations.byLeadTime || []).map((d) => ({
        name: d.bucket,
        Student: d.student || 0,
        Professor: d.professor || 0,
        Unknown: d.unknown || 0,
      })),
    };
  }, [data]);

  const totals = data?.totals || {};
  const rangeLabel = filters.range === "all" ? "All time" : filters.range;

  // Eyebrow / title / lead change with role so the same layout works for
  // both audiences without a second page.
  const intro = isAdmin
    ? {
        eyebrow: "Dashboard · Admin",
        title: "Consultation analytics",
        lead:
          "Cross-department view of slot supply, booking demand, and which professors are getting the most traffic. Filters apply to every chart on the page.",
      }
    : {
        eyebrow: "Dashboard · Professor",
        title: "Your consultation analytics",
        lead:
          "Insights into your published slots, booked consultations, and the topics students keep showing up to discuss.",
      };

  // Page-level "no data at all" state. We render this when the API returns
  // zero slots AND zero bookings for the entire range. Individual chart
  // empty states still apply per chart for less aggressive emptiness.
  const isFullyEmpty =
    !loading &&
    !errorMsg &&
    data &&
    (totals.totalSlots || 0) === 0 &&
    (totals.totalBookings || 0) === 0 &&
    (totals.cancelledBookings || 0) === 0;

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={intro.eyebrow}
        title={intro.title}
        lead={intro.lead}
      />

      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        onReset={onReset}
        availableTypes={data?.availableTypes || []}
        professors={data?.professors || []}
        showProfessor={isAdmin}
        disabled={loading}
      />

      {!loading && !errorMsg && data?.insight && (
        <InsightBanner
          insight={data.insight}
          onRegenerate={onRegenerateInsight}
          disabled={loading}
        />
      )}

      {errorMsg && (
        <div className={styles.errorBanner} role="alert">
          <span>{errorMsg}</span>
          <button
            type="button"
            className={styles.errorRetry}
            onClick={() => load()}
          >
            Retry
          </button>
        </div>
      )}

      {loading && <LoadingState />}

      {!loading && !errorMsg && isFullyEmpty && (
        <EmptyState
          fullPage
          title={
            isAdmin
              ? "No consultations recorded yet."
              : "You haven't published any slots yet."
          }
          hint={
            isAdmin
              ? "Once professors publish slots and students start booking, the charts will populate."
              : "Set your availability and as students book, this dashboard will fill in automatically."
          }
        />
      )}

      {!loading && !errorMsg && data && !isFullyEmpty && (
        <>
          {/* ───── Headline KPIs ───── */}
          <div
            className={styles.sectionHead}
            aria-label="Key metrics section header"
          >
            <h2 className={styles.sectionTitle}>Overview</h2>
            <span className={styles.sectionMeta}>{rangeLabel}</span>
          </div>

          <div className={styles.statGrid}>
            <StatCard
              label="Total slots"
              value={totals.totalSlots ?? 0}
              hint="published in the selected window"
            />
            <StatCard
              label="Bookings"
              value={totals.totalBookings ?? 0}
              hint={`${totals.studentsServed ?? 0} unique students`}
              tone="sage"
            />
            <StatCard
              label="Cancelled"
              value={totals.cancelledBookings ?? 0}
              hint="bookings later cancelled"
              tone={totals.cancelledBookings > 0 ? "danger" : undefined}
            />
            <StatCard
              label="Upcoming · 7d"
              value={totals.upcomingNext7Days ?? 0}
              hint="bookings in the next week"
              tone="accent"
            />
          </div>

          {/* ───── Capacity / mix KPIs ───── */}
          <div
            className={styles.sectionHead}
            aria-label="Capacity metrics section header"
          >
            <h2 className={styles.sectionTitle}>Capacity & format</h2>
          </div>

          <div className={styles.statGrid}>
            <StatCard
              label="Free slots"
              value={totals.freeSlots ?? 0}
              hint={`vs ${totals.bookedSlots ?? 0} booked`}
            />
            <StatCard
              label="Occupancy"
              value={`${totals.occupancyPercent ?? 0}%`}
              progress={totals.occupancyPercent ?? 0}
              progressTone={
                (totals.occupancyPercent ?? 0) >= 70
                  ? "accent"
                  : "sage"
              }
              hint="seats taken vs published"
              tone="accent"
            />
            <StatCard
              label="Group sessions"
              value={totals.groupSessions ?? 0}
              hint={`${totals.individualSessions ?? 0} 1-on-1`}
            />
            <StatCard
              label="Booked slots"
              value={totals.bookedSlots ?? 0}
              hint="slots with at least one student"
              tone="sage"
            />
          </div>

          {/* ───── Charts ───── */}
          <div
            className={styles.sectionHead}
            aria-label="Charts section header"
          >
            <h2 className={styles.sectionTitle}>Trends</h2>
            <span className={styles.sectionMeta}>
              {charts.bookingsOverTime.length} day(s) with bookings
            </span>
          </div>

          <div className={styles.chartGrid}>
            <div
              className={styles.chartGridFull}
              style={{ "--idx": 0 }}
            >
              <ChartCard
                eyebrow="Trend"
                title="Bookings over time"
                hint="grouped by date"
                isEmpty={charts.bookingsOverTime.length === 0}
                emptyTitle="No bookings yet in this range"
                emptyHint="Try expanding the date range or removing the type filter."
                bodyMinHeight={260}
              >
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart
                    data={charts.bookingsOverTime}
                    margin={{ top: 12, right: 16, bottom: 8, left: -10 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11, fontFamily: "Geist Mono, monospace" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11, fontFamily: "Geist Mono, monospace" }}
                      tickLine={false}
                      axisLine={false}
                      width={28}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="bookings"
                      stroke={PALETTE.accent}
                      strokeWidth={2.2}
                      dot={{
                        r: 3,
                        stroke: PALETTE.accent,
                        fill: PALETTE.paper,
                        strokeWidth: 1.6,
                      }}
                      activeDot={{
                        r: 5,
                        stroke: PALETTE.accentDeep,
                        fill: PALETTE.accent,
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div style={{ "--idx": 1 }}>
              <ChartCard
                eyebrow="Demand"
                title="Bookings by consultation type"
                hint="general · exam prep · thesis"
                isEmpty={charts.bookingsByType.length === 0}
                emptyTitle="No typed bookings yet"
                emptyHint="Once students book general / exam-prep / thesis slots, the breakdown appears here."
              >
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    data={charts.bookingsByType}
                    margin={{ top: 8, right: 16, bottom: 8, left: -10 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                    />
                    <YAxis
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={28}
                    />
                    <Tooltip
                      cursor={{ fill: PALETTE.paperWarm }}
                      content={<ChartTooltip />}
                    />
                    <Bar
                      dataKey="bookings"
                      radius={[6, 6, 0, 0]}
                    >
                      {charts.bookingsByType.map((_, i) => (
                        <Cell
                          key={i}
                          fill={SERIES[i % SERIES.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div style={{ "--idx": 2 }}>
              <ChartCard
                eyebrow="Format mix"
                title="Group vs individual"
                hint="of confirmed bookings"
                isEmpty={
                  charts.groupVsIndividual.every((d) => d.value === 0)
                }
                emptyTitle="No bookings to compare"
              >
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Tooltip content={<ChartTooltip />} />
                    <Legend
                      verticalAlign="bottom"
                      height={28}
                      iconType="circle"
                      formatter={(value) => (
                        <span
                          style={{
                            color: PALETTE.ink2,
                            fontFamily: "Geist Mono, monospace",
                            fontSize: 11,
                            letterSpacing: "0.12em",
                          }}
                        >
                          {String(value).toUpperCase()}
                        </span>
                      )}
                    />
                    <Pie
                      data={charts.groupVsIndividual}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      stroke={PALETTE.paper}
                      strokeWidth={2}
                    >
                      <Cell fill={PALETTE.ink} />
                      <Cell fill={PALETTE.accent} />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div style={{ "--idx": 3 }}>
              <ChartCard
                eyebrow="Topics"
                title="Most popular topics"
                hint="from booking notes"
                isEmpty={charts.topTopics.length === 0}
                emptyTitle="No topics tagged yet"
                emptyHint="Topics come from what students mention in chat when they book."
              >
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    layout="vertical"
                    data={charts.topTopics}
                    margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11 }}
                      width={120}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: PALETTE.paperWarm }}
                      content={<ChartTooltip />}
                    />
                    <Bar
                      dataKey="bookings"
                      fill={PALETTE.sage}
                      radius={[0, 6, 6, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div
              className={styles.chartGridFull}
              style={{ "--idx": 4 }}
            >
              <ChartCard
                eyebrow="Capacity"
                title="Free vs booked slots"
                hint="published slots in this window"
                isEmpty={
                  charts.slotOccupancy.every((d) => d.value === 0)
                }
                emptyTitle="No published slots in this window"
                bodyMinHeight={200}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    layout="vertical"
                    data={charts.slotOccupancy}
                    margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11 }}
                      width={70}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: PALETTE.paperWarm }}
                      content={<ChartTooltip />}
                    />
                    <Bar
                      dataKey="value"
                      radius={[0, 6, 6, 0]}
                    >
                      <Cell fill={PALETTE.sage} />
                      <Cell fill={PALETTE.accent} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </div>

          {/* ───── Quality KPIs (chunk 8) ───── */}
          <div
            className={styles.sectionHead}
            aria-label="Quality metrics section header"
          >
            <h2 className={styles.sectionTitle}>Quality & demand</h2>
          </div>

          <div className={styles.statGrid}>
            <StatCard
              label="Average rating"
              value={
                totals.averageRating != null
                  ? totals.averageRating.toFixed(2)
                  : "—"
              }
              hint={
                totals.ratingCount
                  ? `${totals.ratingCount} student response${
                      totals.ratingCount === 1 ? "" : "s"
                    }`
                  : "no responses yet"
              }
              tone={
                totals.averageRating != null && totals.averageRating >= 4
                  ? "sage"
                  : "accent"
              }
            />
            <StatCard
              label="No-show rate"
              value={
                totals.noShowRate != null ? `${totals.noShowRate}%` : "—"
              }
              hint={
                totals.attendanceTotal
                  ? `${totals.attendanceTotal} sessions marked`
                  : "professors haven't marked attendance yet"
              }
              tone={
                totals.noShowRate != null && totals.noShowRate > 15
                  ? "danger"
                  : undefined
              }
            />
            <StatCard
              label="Waitlist demand"
              value={totals.waitlistDemandTotal ?? 0}
              hint="students queued on full slots"
              tone={
                (totals.waitlistDemandTotal ?? 0) > 0 ? "accent" : undefined
              }
            />
          </div>

          {/* ───── Cancellations & subjects (chunk 8) ───── */}
          <div
            className={styles.sectionHead}
            aria-label="Cancellations section header"
          >
            <h2 className={styles.sectionTitle}>Cancellations & subjects</h2>
            <span className={styles.sectionMeta}>
              {totals.cancelledBookings ?? 0} cancellations in window
            </span>
          </div>

          <div className={styles.chartGrid}>
            <div style={{ "--idx": 5 }}>
              <ChartCard
                eyebrow="Cancellations"
                title="Lead time breakdown"
                hint="who cancelled, how close to start"
                isEmpty={
                  charts.cancellationLeadTime.every(
                    (d) => d.Student + d.Professor + d.Unknown === 0
                  )
                }
                emptyTitle="No cancellations in this window"
                emptyHint="When students or professors cancel, you'll see how far ahead they did so here."
              >
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    data={charts.cancellationLeadTime}
                    margin={{ top: 8, right: 16, bottom: 8, left: -10 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                    />
                    <YAxis
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      width={28}
                    />
                    <Tooltip
                      cursor={{ fill: PALETTE.paperWarm }}
                      content={<ChartTooltip />}
                    />
                    <Legend
                      verticalAlign="bottom"
                      height={28}
                      iconType="square"
                      formatter={(value) => (
                        <span
                          style={{
                            color: PALETTE.ink2,
                            fontFamily: "Geist Mono, monospace",
                            fontSize: 11,
                            letterSpacing: "0.12em",
                          }}
                        >
                          {String(value).toUpperCase()}
                        </span>
                      )}
                    />
                    <Bar dataKey="Student" stackId="a" fill={PALETTE.accent} />
                    <Bar
                      dataKey="Professor"
                      stackId="a"
                      fill={PALETTE.ink}
                    />
                    <Bar
                      dataKey="Unknown"
                      stackId="a"
                      fill={PALETTE.ink3}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <div style={{ "--idx": 6 }}>
              <ChartCard
                eyebrow="Subjects"
                title="Bookings by subject"
                hint="from slot subject taxonomy"
                isEmpty={charts.bookingsBySubject.length === 0}
                emptyTitle="No subject data yet"
                emptyHint="Subjects come from the slot taxonomy. Once typed slots get booked, they'll show up here."
              >
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart
                    layout="vertical"
                    data={charts.bookingsBySubject}
                    margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
                  >
                    <CartesianGrid
                      stroke={PALETTE.line}
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      stroke={PALETTE.ink3}
                      allowDecimals={false}
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke={PALETTE.ink3}
                      tick={{ fontSize: 11 }}
                      width={140}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: PALETTE.paperWarm }}
                      content={<ChartTooltip />}
                    />
                    <Bar
                      dataKey="bookings"
                      fill={PALETTE.accentDeep}
                      radius={[0, 6, 6, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </div>

          {/* ───── Admin-only: by department rollup ───── */}
          {isAdmin && data.byDepartment && data.byDepartment.length > 0 && (
            <>
              <div
                className={styles.sectionHead}
                aria-label="By department section header"
              >
                <h2 className={styles.sectionTitle}>By department</h2>
                <span className={styles.sectionMeta}>
                  cross-faculty rollup
                </span>
              </div>

              <ol className={styles.leaderboard}>
                {data.byDepartment.map((d, i) => (
                  <li key={d.department} className={styles.leaderRow}>
                    <span className={styles.leaderRank}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className={styles.leaderName}>
                      <span className={styles.leaderNameMain}>
                        {d.department || "—"}
                      </span>
                      <span className={styles.leaderNameSub}>
                        {d.studentsServed} unique students
                      </span>
                    </span>
                    <span className={styles.leaderMetric}>
                      <strong>{d.totalBookings}</strong>
                      bookings
                    </span>
                    <span className={styles.leaderMetric}>
                      <strong>{d.cancelledBookings}</strong>
                      cancellations
                    </span>
                    <span className={styles.leaderMetric}>
                      <strong>{d.occupancyPercent}%</strong>
                      occupancy
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {/* ───── Admin-only: top professors leaderboard ───── */}
          {isAdmin && data.topProfessors && data.topProfessors.length > 0 && (
            <>
              <div
                className={styles.sectionHead}
                aria-label="Top professors section header"
              >
                <h2 className={styles.sectionTitle}>Top professors</h2>
                <span className={styles.sectionMeta}>
                  individual leaderboard · secondary
                </span>
              </div>

              <ol className={styles.leaderboard}>
                {data.topProfessors.map((p, i) => (
                  <li
                    key={p.professorId}
                    className={styles.leaderRow}
                  >
                    <span className={styles.leaderRank}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className={styles.leaderName}>
                      <span className={styles.leaderNameMain}>
                        {p.name || "—"}
                      </span>
                      <span className={styles.leaderNameSub}>
                        {p.department || "—"}
                      </span>
                    </span>
                    <span className={styles.leaderMetric}>
                      <strong>{p.totalBookings}</strong>
                      bookings
                    </span>
                    <span className={styles.leaderMetric}>
                      <strong>{p.occupancyPercent}%</strong>
                      occupancy
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}
