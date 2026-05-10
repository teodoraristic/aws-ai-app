import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import {
  cancelConsultation,
  decideMentee,
  getMyMentees,
  getMyThesis,
  getProfessorSlots,
  getThesisSettings,
  proposeThesis,
  updateThesisSettings,
} from "../api.js";
import PageHeader from "../components/PageHeader.jsx";
import styles from "./Thesis.module.css";

const SLOT_LOOKAHEAD_DAYS = 28;
const SLOTS_PER_PAGE = 4;

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function formatDate(date, time) {
  if (!date) return "";
  try {
    const dt = new Date(`${date}T${time || "00:00"}`);
    if (Number.isNaN(dt.getTime())) return time ? `${date} · ${time}` : date;
    const opts = {
      weekday: "short",
      month: "short",
      day: "numeric",
    };
    if (time) {
      return `${dt.toLocaleDateString("en-US", opts)} · ${time}`;
    }
    return dt.toLocaleDateString("en-US", opts);
  } catch {
    return time ? `${date} · ${time}` : date;
  }
}

// True iff the slot's start instant has already passed. Used to gate the
// professor's accept/decline buttons on the kickoff meeting actually
// happening.
function hasInstantPassed(date, time) {
  if (!date) return false;
  try {
    const inst = new Date(`${date}T${time || "00:00"}:00`);
    if (Number.isNaN(inst.getTime())) return false;
    return inst.getTime() <= Date.now();
  } catch {
    return false;
  }
}

export default function Thesis() {
  const { idToken, user } = useAuth();
  const { bookingTick } = useChatWidget();
  const role = user?.role || "student";

  if (role === "student") {
    return <StudentThesisView idToken={idToken} bookingTick={bookingTick} />;
  }
  if (role === "professor") {
    return <ProfessorThesisView idToken={idToken} bookingTick={bookingTick} />;
  }
  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Thesis"
        title="Thesis mentorship"
        lead="The thesis workspace is available to students and professors only."
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Shared: paginated slot picker
// ────────────────────────────────────────────────────────────────

// Renders 4 slots at a time with prev/next arrows and a page indicator.
// `slots` is the already-filtered list of bookable slots; `renderSlot` is
// the per-row renderer chosen by the parent (so the propose flow and the
// accepted view can render different action buttons against the same
// pager). Mirrors the same pattern used on the Faculty page.
function SlotPager({ slots, renderSlot, emptyHint }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(slots.length / SLOTS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * SLOTS_PER_PAGE;
  const visible = slots.slice(start, start + SLOTS_PER_PAGE);

  // Reset to first page whenever the underlying list changes shape.
  useEffect(() => {
    setPage(0);
  }, [slots.length]);

  if (slots.length === 0) {
    return <p className={styles.sectionEmpty}>{emptyHint}</p>;
  }

  return (
    <div className={styles.pager}>
      <ul className={styles.slotList}>
        {visible.map((s) => renderSlot(s))}
      </ul>
      <nav className={styles.pagerNav} aria-label="Slot pagination">
        <button
          type="button"
          className={styles.pagerArrow}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={safePage === 0}
          aria-label="Previous slots"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M9 2 4 7l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className={styles.pagerStatus}>
          {Math.min(slots.length, start + 1)}–
          {Math.min(slots.length, start + visible.length)}{" "}
          <span className={styles.pagerStatusOf}>of</span>{" "}
          {slots.length}
        </span>
        <button
          type="button"
          className={styles.pagerArrow}
          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          disabled={safePage >= totalPages - 1}
          aria-label="More slots"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M5 2l5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </nav>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Student view
// ────────────────────────────────────────────────────────────────

function StudentThesisView({ idToken, bookingTick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setError("");
    try {
      const fresh = await getMyThesis(idToken);
      setData(fresh);
    } catch (err) {
      setError(err?.message || "Could not load thesis state.");
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (bookingTick === 0) return;
    load();
  }, [bookingTick, load]);

  const current = data?.current || null;
  const status = current ? current.status : "none";
  const showProposeFlow = !current || status === "declined";
  const consultations = data?.consultations || [];
  const initialBooking = current
    ? consultations.find(
        (c) =>
          c.status !== "cancelled" &&
          c.thesisStage === "initial" &&
          c.professorId === current.professorId
      )
    : null;
  const updateBookings = current
    ? consultations.filter(
        (c) =>
          c.status !== "cancelled" &&
          c.thesisStage === "update" &&
          c.professorId === current.professorId
      )
    : [];

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Thesis"
        title="Your thesis mentorship"
        lead="Pick a mentor, propose a theme, and book recurring updates once they accept. One active mentorship at a time."
      />

      {error && <div className={styles.error}>{error}</div>}
      {loading && (
        <div className={styles.skeleton}>Loading your thesis state…</div>
      )}

      {!loading && status === "pending" && current && (
        <PendingProposalCard
          mentorship={current}
          initialBooking={initialBooking}
          idToken={idToken}
          onAfterCancel={load}
        />
      )}

      {!loading && status === "accepted" && current && (
        <AcceptedMentorshipView
          mentorship={current}
          initialBooking={initialBooking}
          updateBookings={updateBookings}
          idToken={idToken}
          onAfterBook={load}
        />
      )}

      {!loading && showProposeFlow && (
        <ProposeFlow
          professors={data?.thesisProfessors || []}
          history={data?.history || []}
          idToken={idToken}
          onProposed={load}
        />
      )}
    </div>
  );
}

function PendingProposalCard({ mentorship, initialBooking, idToken, onAfterCancel }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");

  const onCancel = async () => {
    if (!initialBooking) return;
    setCancelling(true);
    setErr("");
    try {
      await cancelConsultation(
        idToken,
        initialBooking.consultationId,
        reason.trim()
      );
      await onAfterCancel();
    } catch (e) {
      setErr(e?.message || "Could not cancel the proposal.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className={styles.statusCard} data-status="pending">
      <p className={styles.statusEyebrow}>Proposal pending</p>
      <h2 className={styles.statusTitle}>
        Waiting on {mentorship.professorName || "your professor"}
      </h2>
      {mentorship.professorDepartment && (
        <p className={styles.statusDept}>{mentorship.professorDepartment}</p>
      )}

      <div className={styles.themeBox}>
        <p className={styles.themeLabel}>Theme</p>
        <p className={styles.themeBody}>{mentorship.thesisTheme || "—"}</p>
      </div>

      {initialBooking && (
        <div className={styles.bookingPill}>
          <span className={styles.bookingWhen}>
            {formatDate(initialBooking.date, initialBooking.time)}
          </span>
          <span className={styles.bookingMeta}>Initial consultation</span>
        </div>
      )}

      <p className={styles.statusHint}>
        Your professor can only accept or decline once your initial
        consultation has actually taken place. Until then, the proposal
        sits with them. Cancelling the meeting withdraws the proposal so
        you can try a different professor.
      </p>

      {!open ? (
        <button
          type="button"
          className={styles.dangerOutline}
          onClick={() => setOpen(true)}
          disabled={!initialBooking}
        >
          Cancel proposal
        </button>
      ) : (
        <div className={styles.composer}>
          <label className={styles.composerLabel}>
            Optional reason for withdrawing
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={styles.composerTextarea}
            maxLength={240}
            rows={3}
            placeholder="A short note for the professor (optional)"
          />
          {err && <p className={styles.composerError}>{err}</p>}
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.composerCancel}
              onClick={() => {
                setOpen(false);
                setReason("");
                setErr("");
              }}
              disabled={cancelling}
            >
              Back
            </button>
            <button
              type="button"
              className={styles.dangerSolid}
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? "Withdrawing…" : "Withdraw proposal"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AcceptedMentorshipView({
  mentorship,
  initialBooking,
  updateBookings,
  idToken,
  onAfterBook,
}) {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [bookingSlotSK, setBookingSlotSK] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [bookErr, setBookErr] = useState("");

  useEffect(() => {
    if (!mentorship?.professorId || !idToken) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const data = await getProfessorSlots(
          idToken,
          mentorship.professorId,
          isoDate(0),
          isoDate(SLOT_LOOKAHEAD_DAYS)
        );
        if (alive) setSlots(data.slots || []);
      } catch (e) {
        if (alive) setErr(e?.message || "Could not load thesis slots.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mentorship?.professorId, idToken]);

  const thesisSlots = useMemo(
    () =>
      (slots || []).filter(
        (s) =>
          s.consultationType === "thesis" &&
          (s.currentParticipants || 0) < (s.maxParticipants || 1) &&
          s.status !== "deleted"
      ),
    [slots]
  );

  const onBook = async (s) => {
    setSubmitting(true);
    setBookErr("");
    try {
      await proposeThesis(idToken, {
        professorId: mentorship.professorId,
        slotSK: s.slotId,
        theme: mentorship.thesisTheme || "Thesis update",
      });
      setBookingSlotSK(null);
      await onAfterBook();
    } catch (e) {
      setBookErr(e?.message || "Could not book this slot.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderSlot = (s) => {
    const isThis = bookingSlotSK === s.slotId;
    return (
      <li key={s.slotId} className={styles.slotRow}>
        <span className={styles.slotWhen}>
          {formatDate(s.date, s.time)}
        </span>
        <span className={styles.slotMeta}>Thesis update</span>
        {!isThis ? (
          <button
            type="button"
            className={styles.bookBtn}
            onClick={() => {
              setBookingSlotSK(s.slotId);
              setBookErr("");
            }}
          >
            Book
          </button>
        ) : (
          <span className={styles.confirmInline}>
            <button
              type="button"
              className={styles.bookBtnPrimary}
              onClick={() => onBook(s)}
              disabled={submitting}
            >
              {submitting ? "Booking…" : "Confirm"}
            </button>
            <button
              type="button"
              className={styles.bookBtnGhost}
              onClick={() => setBookingSlotSK(null)}
              disabled={submitting}
            >
              Cancel
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <>
      <section className={styles.statusCard} data-status="accepted">
        <p className={styles.statusEyebrow}>Mentor accepted</p>
        <h2 className={styles.statusTitle}>
          {mentorship.professorName || "Your professor"} is your thesis mentor
        </h2>
        {mentorship.professorDepartment && (
          <p className={styles.statusDept}>{mentorship.professorDepartment}</p>
        )}
        <div className={styles.themeBox}>
          <p className={styles.themeLabel}>Approved theme</p>
          <p className={styles.themeBody}>{mentorship.thesisTheme || "—"}</p>
        </div>
        {mentorship.decidedAt && (
          <p className={styles.statusHint}>
            Accepted {new Date(mentorship.decidedAt).toLocaleDateString()}
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Book a thesis update</h3>
        {err && <p className={styles.sectionError}>{err}</p>}
        {loading && <p className={styles.sectionEmpty}>Loading slots…</p>}
        {!loading && (
          <SlotPager
            slots={thesisSlots}
            renderSlot={renderSlot}
            emptyHint={`No thesis slots are open right now.${
              mentorship.professorName
                ? ` Check back later — ${mentorship.professorName} hasn't published any.`
                : ""
            }`}
          />
        )}
        {bookErr && <p className={styles.sectionError}>{bookErr}</p>}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Thesis history</h3>
        <ul className={styles.historyList}>
          {initialBooking && (
            <li className={styles.historyRow}>
              <span className={styles.historyWhen}>
                {formatDate(initialBooking.date, initialBooking.time)}
              </span>
              <span className={styles.historyKind}>Initial consultation</span>
            </li>
          )}
          {updateBookings.map((c) => (
            <li key={c.consultationId} className={styles.historyRow}>
              <span className={styles.historyWhen}>
                {formatDate(c.date, c.time)}
              </span>
              <span className={styles.historyKind}>Thesis update</span>
            </li>
          ))}
          {!initialBooking && updateBookings.length === 0 && (
            <li className={styles.sectionEmpty}>No bookings yet.</li>
          )}
        </ul>
      </section>
    </>
  );
}

function ProposeFlow({ professors, history, idToken, onProposed }) {
  const [selectedProfId, setSelectedProfId] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotErr, setSlotErr] = useState("");
  const [selectedSlotSK, setSelectedSlotSK] = useState(null);
  const [theme, setTheme] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState("");

  const declined = (history || []).filter((m) => m.status === "declined");

  useEffect(() => {
    if (!selectedProfId || !idToken) {
      setSlots([]);
      return;
    }
    let alive = true;
    (async () => {
      setLoadingSlots(true);
      setSlotErr("");
      try {
        const data = await getProfessorSlots(
          idToken,
          selectedProfId,
          isoDate(0),
          isoDate(SLOT_LOOKAHEAD_DAYS)
        );
        if (alive) setSlots(data.slots || []);
      } catch (e) {
        if (alive) setSlotErr(e?.message || "Could not load slots.");
      } finally {
        if (alive) setLoadingSlots(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedProfId, idToken]);

  const thesisSlots = useMemo(
    () =>
      (slots || []).filter(
        (s) =>
          s.consultationType === "thesis" &&
          (s.currentParticipants || 0) < (s.maxParticipants || 1)
      ),
    [slots]
  );

  const onSubmit = async () => {
    if (!selectedProfId || !selectedSlotSK || !theme.trim()) return;
    setSubmitting(true);
    setSubmitErr("");
    try {
      await proposeThesis(idToken, {
        professorId: selectedProfId,
        slotSK: selectedSlotSK,
        theme: theme.trim(),
      });
      await onProposed();
    } catch (e) {
      setSubmitErr(e?.message || "Could not submit proposal.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderSlot = (s) => (
    <li key={s.slotId} className={styles.slotRow}>
      <span className={styles.slotWhen}>{formatDate(s.date, s.time)}</span>
      <span className={styles.slotMeta}>Initial consultation</span>
      <button
        type="button"
        className={`${styles.bookBtn} ${
          selectedSlotSK === s.slotId ? styles.bookBtnPrimary : ""
        }`}
        onClick={() => setSelectedSlotSK(s.slotId)}
      >
        {selectedSlotSK === s.slotId ? "Selected" : "Pick"}
      </button>
    </li>
  );

  return (
    <>
      {declined.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Past attempts</h3>
          <ul className={styles.historyList}>
            {declined.map((m) => (
              <li
                key={`${m.professorId}-${m.attempt}`}
                className={styles.historyRow}
              >
                <span className={styles.historyWhen}>
                  {m.professorName || "Professor"}
                </span>
                <span className={styles.historyKind}>
                  Declined
                  {m.declineReason ? ` — ${m.declineReason}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Pick a mentor</h3>
        <p className={styles.sectionLead}>
          Only professors with open mentee slots are shown. The badge on
          each card is their remaining capacity for new mentees.
        </p>
        {professors.length === 0 ? (
          <p className={styles.sectionEmpty}>
            No professors are currently accepting new thesis mentees. Check
            back in a few days, or ask the Academic Assistant for help
            finding someone in your area.
          </p>
        ) : (
          <ul className={styles.professorGrid}>
            {professors.map((p) => {
              const active = p.professorId === selectedProfId;
              const remaining =
                typeof p.menteesRemaining === "number"
                  ? p.menteesRemaining
                  : null;
              return (
                <li key={p.professorId}>
                  <button
                    type="button"
                    className={`${styles.profCard} ${
                      active ? styles.profCardActive : ""
                    }`}
                    onClick={() => {
                      setSelectedProfId(p.professorId);
                      setSelectedSlotSK(null);
                      setSubmitErr("");
                    }}
                  >
                    <span className={styles.profCardHead}>
                      <span className={styles.profName}>{p.name}</span>
                      {remaining !== null && (
                        <span className={styles.capacityChip}>
                          {p.acceptedMentees}/{p.maxMentees}
                          <span className={styles.capacityChipLabel}>
                            mentees
                          </span>
                        </span>
                      )}
                    </span>
                    {p.department && (
                      <span className={styles.profDept}>{p.department}</span>
                    )}
                    {Array.isArray(p.subjects) && p.subjects.length > 0 && (
                      <span className={styles.profSubjects}>
                        {p.subjects.slice(0, 3).join(" · ")}
                        {p.subjects.length > 3 ? " …" : ""}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selectedProfId && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Pick an initial slot</h3>
          {loadingSlots && (
            <p className={styles.sectionEmpty}>Loading slots…</p>
          )}
          {slotErr && <p className={styles.sectionError}>{slotErr}</p>}
          {!loadingSlots && (
            <SlotPager
              slots={thesisSlots}
              renderSlot={renderSlot}
              emptyHint="This professor doesn't have any open thesis slots in the next few weeks."
            />
          )}
        </section>
      )}

      {selectedProfId && selectedSlotSK && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Describe your theme</h3>
          <textarea
            className={styles.themeInput}
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            rows={5}
            maxLength={1500}
            placeholder="One short paragraph: what you want to research, why, and any preferred approach."
          />
          {submitErr && <p className={styles.sectionError}>{submitErr}</p>}
          <button
            type="button"
            className={styles.submitBtn}
            onClick={onSubmit}
            disabled={!theme.trim() || submitting}
          >
            {submitting ? "Submitting…" : "Send thesis proposal"}
          </button>
        </section>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Professor view
// ────────────────────────────────────────────────────────────────

function ProfessorThesisView({ idToken, bookingTick }) {
  const [data, setData] = useState({ mentees: [], consultations: [], capacity: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("pending");

  const load = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setError("");
    try {
      const fresh = await getMyMentees(idToken);
      setData({
        mentees: fresh.mentees || [],
        consultations: fresh.consultations || [],
        capacity: fresh.capacity || null,
      });
    } catch (err) {
      setError(err?.message || "Could not load mentees.");
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (bookingTick === 0) return;
    load();
  }, [bookingTick, load]);

  const consultationsByPair = useMemo(() => {
    const m = new Map();
    for (const c of data.consultations || []) {
      const key = `${c.professorId}::${c.studentId}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    return m;
  }, [data.consultations]);

  const groups = useMemo(() => {
    const pending = [];
    const accepted = [];
    const past = [];
    for (const m of data.mentees || []) {
      if (m.status === "pending") pending.push(m);
      else if (m.status === "accepted") accepted.push(m);
      else if (m.status === "declined") past.push(m);
    }
    return { pending, accepted, past };
  }, [data.mentees]);

  const list = groups[tab] || [];
  const counts = {
    pending: groups.pending.length,
    accepted: groups.accepted.length,
    past: groups.past.length,
  };

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Thesis"
        title="My mentees"
        lead="Review thesis proposals and the students who are actively working with you."
      />

      {error && <div className={styles.error}>{error}</div>}

      <CapacityCard
        idToken={idToken}
        initial={data.capacity}
        onSaved={load}
      />

      <nav className={styles.tabs}>
        <TabBtn
          label={`Pending (${counts.pending})`}
          active={tab === "pending"}
          onClick={() => setTab("pending")}
        />
        <TabBtn
          label={`Accepted (${counts.accepted})`}
          active={tab === "accepted"}
          onClick={() => setTab("accepted")}
        />
        <TabBtn
          label={`Past (${counts.past})`}
          active={tab === "past"}
          onClick={() => setTab("past")}
        />
      </nav>

      {loading ? (
        <div className={styles.skeleton}>Loading…</div>
      ) : list.length === 0 ? (
        <p className={styles.sectionEmpty}>
          {tab === "pending"
            ? "No pending proposals right now."
            : tab === "accepted"
            ? "You haven't accepted any mentees yet."
            : "No declined proposals on record."}
        </p>
      ) : (
        <ul className={styles.menteeList}>
          {list.map((m) => (
            <MenteeCard
              key={`${m.studentId}-${m.attempt}`}
              mentee={m}
              consultations={
                consultationsByPair.get(`${m.professorId}::${m.studentId}`) ||
                []
              }
              capacity={data.capacity}
              idToken={idToken}
              onAfterDecide={load}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Capacity card (professor-only). Lets the professor read + edit how many
// mentees they're willing to accept. Backend rejects values lower than the
// current accepted count, so that error is surfaced inline.
function CapacityCard({ idToken, initial, onSaved }) {
  const [data, setData] = useState(initial || null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setData(initial || null);
  }, [initial]);

  // Pull settings on mount when the parent's mentees load didn't include
  // capacity yet (defensive — older deploys may not return it).
  useEffect(() => {
    if (data || !idToken) return;
    let alive = true;
    (async () => {
      try {
        const fresh = await getThesisSettings(idToken);
        if (alive) setData(fresh);
      } catch {
        /* leave card in skeleton state */
      }
    })();
    return () => {
      alive = false;
    };
  }, [data, idToken]);

  const startEdit = () => {
    setValue(String(data?.maxMentees ?? 0));
    setEditing(true);
    setErr("");
  };

  const save = async () => {
    const next = parseInt(value, 10);
    if (!Number.isInteger(next) || next < 0) {
      setErr("Enter a whole non-negative number.");
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const fresh = await updateThesisSettings(idToken, { maxMentees: next });
      setData(fresh);
      setEditing(false);
      if (onSaved) await onSaved();
    } catch (e) {
      setErr(e?.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <section className={styles.capacityCard}>
        <p className={styles.capacityEyebrow}>Mentee capacity</p>
        <p className={styles.sectionEmpty}>Loading capacity…</p>
      </section>
    );
  }

  const { maxMentees, acceptedMentees } = data;
  const remaining = Math.max(0, maxMentees - acceptedMentees);
  const ratio = maxMentees > 0 ? acceptedMentees / maxMentees : 0;
  const progressPct = Math.min(100, Math.round(ratio * 100));

  return (
    <section className={styles.capacityCard}>
      <div className={styles.capacityHead}>
        <p className={styles.capacityEyebrow}>Mentee capacity</p>
        {!editing && (
          <button
            type="button"
            className={styles.capacityEditBtn}
            onClick={startEdit}
          >
            Edit cap
          </button>
        )}
      </div>

      {!editing ? (
        <>
          <div className={styles.capacityHero}>
            <span className={styles.capacityNumber}>{acceptedMentees}</span>
            <span className={styles.capacitySlash}>/</span>
            <span className={styles.capacityMax}>{maxMentees}</span>
            <span className={styles.capacityUnit}>active mentees</span>
          </div>
          <div
            className={styles.capacityBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={maxMentees}
            aria-valuenow={acceptedMentees}
            aria-label="Mentee capacity"
          >
            <span
              className={styles.capacityFill}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className={styles.capacityHint}>
            {maxMentees === 0
              ? "Set a cap above zero so students can propose a thesis with you."
              : remaining === 0
              ? "You're at capacity. New proposals can land but you can't accept any until a thesis wraps up or you raise the cap."
              : `${remaining} more ${
                  remaining === 1 ? "seat is" : "seats are"
                } open for new mentees.`}
          </p>
        </>
      ) : (
        <div className={styles.capacityEditor}>
          <label
            className={styles.capacityLabel}
            htmlFor="capacity-input"
          >
            Maximum mentees
          </label>
          <input
            id="capacity-input"
            type="number"
            min={acceptedMentees}
            max={50}
            inputMode="numeric"
            className={styles.capacityInput}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            aria-describedby="capacity-helper"
          />
          <p id="capacity-helper" className={styles.capacityHelper}>
            Can't drop below your {acceptedMentees} currently accepted{" "}
            {acceptedMentees === 1 ? "mentee" : "mentees"}.
          </p>
          {err && <p className={styles.composerError}>{err}</p>}
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.composerCancel}
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.bookBtnPrimary}
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save cap"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function TabBtn({ label, active, onClick }) {
  return (
    <button
      type="button"
      className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function MenteeCard({ mentee, consultations, capacity, idToken, onAfterDecide }) {
  const [composer, setComposer] = useState(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const initialConsultation = consultations.find(
    (c) =>
      c.thesisStage === "initial" &&
      c.status !== "cancelled" &&
      c.studentId === mentee.studentId
  );

  const isPending = mentee.status === "pending";
  const initialPassed = initialConsultation
    ? hasInstantPassed(initialConsultation.date, initialConsultation.time)
    : false;

  const atCapacity =
    capacity &&
    typeof capacity.maxMentees === "number" &&
    capacity.acceptedMentees >= capacity.maxMentees;

  const submit = async (status) => {
    setSubmitting(true);
    setErr("");
    try {
      await decideMentee(idToken, mentee.studentId, {
        status,
        ...(status === "declined" && reason.trim()
          ? { declineReason: reason.trim() }
          : {}),
      });
      await onAfterDecide();
    } catch (e) {
      setErr(e?.message || "Could not save decision.");
    } finally {
      setSubmitting(false);
      setComposer(null);
    }
  };

  return (
    <li className={styles.menteeCard} data-status={mentee.status}>
      <header className={styles.menteeHead}>
        <span className={styles.menteeName}>
          {mentee.studentName || "Student"}
        </span>
        {mentee.studentEmail && (
          <span className={styles.menteeEmail}>{mentee.studentEmail}</span>
        )}
        <span
          className={`${styles.statusChip} ${styles[`statusChip_${mentee.status}`]}`}
        >
          {mentee.status}
        </span>
      </header>

      <div className={styles.themeBox}>
        <p className={styles.themeLabel}>Theme</p>
        <p className={styles.themeBody}>{mentee.thesisTheme || "—"}</p>
      </div>

      {initialConsultation && (
        <p className={styles.menteeMeta}>
          Initial consultation:{" "}
          <strong>
            {formatDate(initialConsultation.date, initialConsultation.time)}
          </strong>
          {isPending && (
            <span
              className={`${styles.gateChip} ${
                initialPassed ? styles.gateChipReady : styles.gateChipWait
              }`}
            >
              {initialPassed ? "Meeting complete" : "Awaiting meeting"}
            </span>
          )}
        </p>
      )}

      {mentee.status === "declined" && mentee.declineReason && (
        <p className={styles.menteeMeta}>
          Decline note: <em>{mentee.declineReason}</em>
        </p>
      )}

      {isPending && composer === null && (
        <>
          {!initialPassed && (
            <p className={styles.menteeGateHint}>
              You can accept or decline once the initial consultation has
              taken place.
            </p>
          )}
          {initialPassed && atCapacity && (
            <p className={styles.menteeGateHint} data-tone="warn">
              You're at capacity ({capacity.acceptedMentees}/
              {capacity.maxMentees}). Raise your cap above or decline this
              proposal.
            </p>
          )}
          <div className={styles.menteeActions}>
            <button
              type="button"
              className={styles.acceptBtn}
              onClick={() => submit("accepted")}
              disabled={submitting || !initialPassed || atCapacity}
              title={
                !initialPassed
                  ? "Available after the initial consultation"
                  : atCapacity
                  ? "At capacity — raise your cap first"
                  : "Accept this thesis proposal"
              }
            >
              Accept
            </button>
            <button
              type="button"
              className={styles.declineBtn}
              onClick={() => setComposer("decline")}
              disabled={submitting || !initialPassed}
              title={
                !initialPassed
                  ? "Available after the initial consultation"
                  : "Decline with an optional note"
              }
            >
              Decline…
            </button>
          </div>
        </>
      )}

      {composer === "decline" && (
        <div className={styles.composer}>
          <label className={styles.composerLabel}>
            Reason (optional, sent to the student)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={styles.composerTextarea}
            maxLength={240}
            rows={3}
            placeholder="Helpful context for the student"
          />
          {err && <p className={styles.composerError}>{err}</p>}
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.composerCancel}
              onClick={() => {
                setComposer(null);
                setReason("");
                setErr("");
              }}
              disabled={submitting}
            >
              Back
            </button>
            <button
              type="button"
              className={styles.dangerSolid}
              onClick={() => submit("declined")}
              disabled={submitting}
            >
              {submitting ? "Saving…" : "Decline proposal"}
            </button>
          </div>
        </div>
      )}

      {!isPending && err && <p className={styles.composerError}>{err}</p>}
    </li>
  );
}
