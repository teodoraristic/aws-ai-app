const MONTHS_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const WEEKDAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function dayNumber(iso) {
  const d = parseDate(iso);
  return d ? String(d.getDate()).padStart(2, "0") : "—";
}

export function monthShort(iso) {
  const d = parseDate(iso);
  return d ? MONTHS_SHORT[d.getMonth()] : "";
}

export function weekdayShort(iso) {
  const d = parseDate(iso);
  return d ? WEEKDAYS_SHORT[d.getDay()] : "";
}

export function initials(name) {
  if (!name) return "·";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() || "")
    .join("");
}

// Status copy aligned with the academic terminology used across the portal.
// "booked" rows surface as "Reserved" so all booking surfaces (lists, cards,
// badges) speak the same language.
const STATUS_LABEL = {
  booked: "Reserved",
  pending: "Pending",
  cancelled: "Cancelled",
  completed: "Completed",
  available: "Available",
  full: "Full capacity",
};

export function statusLabel(status) {
  return STATUS_LABEL[status] || status || "—";
}
