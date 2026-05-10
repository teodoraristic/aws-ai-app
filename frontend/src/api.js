// Normalize the configured API base so every call() builds a clean URL even
// when `.env` ends with a trailing slash (e.g. `…/prod/`). API Gateway is
// strict about path matching — `//me/daily-report` does NOT match the route
// `/me/daily-report` and silently 404s.
const base = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

const authHeaders = (token) => ({
  "Content-Type": "application/json",
  Authorization: token,
});

async function call(method, path, token, body) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${base}${normalizedPath}`, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // The backend returns `{ message: "..."}` for soft validation failures
    // (full session, duplicate booking, past slot, etc). We try to surface
    // that message as the error so the UI can render it inline; falling
    // back to the raw body for anything that isn't JSON.
    const text = await res.text().catch(() => "");
    let msg = "";
    if (text) {
      try {
        const parsed = JSON.parse(text);
        msg = parsed.message || text;
      } catch {
        msg = text;
      }
    }
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const sendChatMessage = (token, sessionId, message) =>
  call("POST", "/chat", token, { sessionId, message });

// Replay a stored chat session (Option A: resume the last in-progress
// conversation after a tab refresh / new login). Server filters rows to the
// caller's userId so a forged sessionId returns nothing useful.
export const getChatHistory = (token, sessionId) =>
  call("GET", `/chat/sessions/${encodeURIComponent(sessionId)}`, token);

export const getProfessors = (token) => call("GET", "/professors", token);

export const getProfessorSlots = (token, professorId, dateFrom, dateTo) =>
  call(
    "GET",
    `/professors/${professorId}/slots?from=${dateFrom}&to=${dateTo}`,
    token
  );

export const createSlots = (token, professorId, body) =>
  call("POST", `/professors/${professorId}/slots`, token, body);

export const updateSlotCapacity = (token, professorId, slotSK, maxParticipants) =>
  call(
    "PATCH",
    `/professors/${encodeURIComponent(professorId)}/slots/${encodeURIComponent(slotSK)}`,
    token,
    { maxParticipants }
  );

// Delete a single unbooked slot. The backend rejects when the slot already
// has bookings — for that case the professor should use cancelDay instead.
export const deleteSlot = (token, professorId, slotSK) =>
  call(
    "DELETE",
    `/professors/${encodeURIComponent(professorId)}/slots/${encodeURIComponent(slotSK)}`,
    token
  );

// Cancel everything on a single day: cancels all consultations for that
// date (notifying each booked student) and then deletes the freed slots.
export const cancelDay = (token, professorId, date) =>
  call(
    "POST",
    `/professors/${encodeURIComponent(professorId)}/slots/cancel-day`,
    token,
    { date }
  );

export const getMyConsultations = (token, range) => {
  const qs = range ? `?range=${encodeURIComponent(range)}` : "";
  return call("GET", `/me/consultations${qs}`, token);
};

export const cancelConsultation = (token, consultationId, reason = "") =>
  call("PATCH", `/consultations/${consultationId}`, token, {
    status: "cancelled",
    ...(reason ? { reason } : {}),
  });

// Submit role-scoped feedback for a past consultation. The server picks the
// slice (studentFeedback vs professorFeedback) based on the caller's
// identity on the row, so the same payload shape is rejected if the wrong
// role sends it.
//   - student payload: { rating: 1..5, comment? }
//   - professor payload: { attended: "yes"|"no"|"late", note? }
export const submitConsultationFeedback = (token, consultationId, payload) =>
  call(
    "POST",
    `/consultations/${encodeURIComponent(consultationId)}/feedback`,
    token,
    payload
  );

// Manual student-driven reservation. Same booking invariants as the chat
// assistant — both routes funnel through the shared bookSlotCore in the
// common Lambda layer.
export const createBooking = (token, body) =>
  call("POST", "/bookings", token, body);

// ----- Thesis (mentorship flow) -----
//
// Two role-scoped surfaces:
//   - Student: propose a thesis, inspect their current state.
//   - Professor: list pending / accepted / past mentees, decide.

export const proposeThesis = (token, body) =>
  call("POST", "/thesis/proposal", token, body);

export const getMyThesis = (token) => call("GET", "/thesis/me", token);

export const getMyMentees = (token) => call("GET", "/thesis/mentees", token);

export const decideMentee = (token, studentId, body) =>
  call(
    "PATCH",
    `/thesis/mentees/${encodeURIComponent(studentId)}`,
    token,
    body
  );

// Thesis capacity settings (professor-only).
//   GET  → { maxMentees, acceptedMentees, menteesRemaining }
//   PATCH { maxMentees }  → same shape on success.
// The backend rejects values that would put the professor under-capacity
// (i.e. fewer than they currently have accepted) so the UI surfaces the
// returned message verbatim on error.
export const getThesisSettings = (token) =>
  call("GET", "/thesis/settings", token);

export const updateThesisSettings = (token, body) =>
  call("PATCH", "/thesis/settings", token, body);

// ----- Waitlist (notify-only) -----
//
// Student joins the waitlist on a full slot; the seat_opened notification
// fires when a booked student cancels and frees a seat. The student then
// has to manually book the slot through the regular booking flow.

export const joinWaitlist = (token, professorId, slotSK, body) =>
  call(
    "POST",
    `/professors/${encodeURIComponent(professorId)}/slots/${encodeURIComponent(slotSK)}/waitlist`,
    token,
    body || {}
  );

export const leaveWaitlist = (token, professorId, slotSK) =>
  call(
    "DELETE",
    `/me/waitlist/${encodeURIComponent(slotSK)}?professorId=${encodeURIComponent(professorId)}`,
    token
  );

export const getMyWaitlist = (token) => call("GET", "/me/waitlist", token);

// ----- Daily report (professor-only) -----

// Fetches the latest persisted daily report for the calling professor. The
// daily-report cron Lambda writes one row per professor per target date
// every evening; this endpoint returns the most-recent (or a specific date
// when `date=YYYY-MM-DD` is passed).
export const getDailyReport = (token, date) => {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  return call("GET", `/me/daily-report${qs}`, token);
};

// ----- Notifications -----

export const getNotifications = (token, limit) => {
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : "";
  return call("GET", `/me/notifications${qs}`, token);
};

export const markNotificationRead = (token, notifId) =>
  call("PATCH", `/me/notifications/${encodeURIComponent(notifId)}`, token, {
    read: true,
  });

export const markAllNotificationsRead = (token) =>
  call("POST", "/me/notifications/mark-all-read", token, {});

export const deleteNotification = (token, notifId) =>
  call("DELETE", `/me/notifications/${encodeURIComponent(notifId)}`, token);

// ----- Professor schedule (unavailable days + private class schedule) -----

export const getUnavailable = (token, professorId) =>
  call("GET", `/professors/${professorId}/unavailable`, token);

export const addUnavailable = (token, professorId, body) =>
  call("POST", `/professors/${professorId}/unavailable`, token, body);

export const removeUnavailable = (token, professorId, date) =>
  call("DELETE", `/professors/${professorId}/unavailable/${date}`, token);

export const getClasses = (token, professorId) =>
  call("GET", `/professors/${professorId}/classes`, token);

export const addClass = (token, professorId, body) =>
  call("POST", `/professors/${professorId}/classes`, token, body);

export const removeClass = (token, professorId, classId) =>
  call("DELETE", `/professors/${professorId}/classes/${classId}`, token);

// ----- Analytics -----

// Translate the FilterBar's structured params into a flat query string the
// Lambda can read directly off event.queryStringParameters. Any "all" or
// empty values are dropped so the URL stays compact.
function analyticsQuery(params = {}) {
  const qs = new URLSearchParams();
  if (params.range && params.range !== "all") qs.set("range", params.range);
  if (params.type && params.type !== "all") qs.set("type", params.type);
  if (params.group && params.group !== "all") qs.set("group", params.group);
  if (params.professorId) qs.set("professorId", params.professorId);
  // nocache=1 forces the backend to bypass the AI-insight cache and
  // generate a fresh banner. Wired up to the "Regenerate" link on the
  // analytics page.
  if (params.nocache) qs.set("nocache", "1");
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const getProfessorAnalytics = (token, params) =>
  call("GET", `/analytics/professor${analyticsQuery(params)}`, token);

export const getAdminAnalytics = (token, params) =>
  call("GET", `/analytics/admin${analyticsQuery(params)}`, token);
