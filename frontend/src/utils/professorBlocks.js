// ── Professor "block" grouping ─────────────────────────────────────
// Walk a sorted list of professor consultations and collapse them into
// office-hour blocks. A block is a contiguous run of bookable slots:
// adjacent in time (prev.endMin === next.startMin) and on the same
// date. Each block keeps its underlying per-slot groups so the inner
// list can still render a row per student/topic, with the block header
// showing the merged time range (e.g. "Tue 6 May · 10:00 – 11:30").
//
// Used by both /me/consultations (full management view) and / (Home
// dashboard preview) so the visual grouping stays identical.

function parseHHMMLocal(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Group consultations that share a slot first (one row per booked
// student becomes one slot-group), then walk those groups to build the
// merged blocks.
export function buildProfessorBlocks(sortedConsultations) {
  const slotGroups = groupBySlot(sortedConsultations);

  const enriched = slotGroups
    .map((group) => {
      const first = group[0];
      const startMin = parseHHMMLocal(first.time);
      if (startMin == null) return null;
      const dur = Number.isInteger(first.slotDurationMinutes)
        ? first.slotDurationMinutes
        : 30;
      return {
        group,
        first,
        date: first.date,
        startMin,
        endMin: startMin + dur,
        duration: dur,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.startMin - b.startMin;
    });

  const blocks = [];
  for (const row of enriched) {
    const last = blocks[blocks.length - 1];
    const canMerge =
      last && last.date === row.date && last.endMin === row.startMin;
    if (canMerge) {
      last.endMin = row.endMin;
      last.rows.push(row);
    } else {
      blocks.push({
        date: row.date,
        startMin: row.startMin,
        endMin: row.endMin,
        rows: [row],
      });
    }
  }
  return blocks;
}

function groupBySlot(consultations) {
  const map = new Map();
  for (const c of consultations) {
    const key = c.slotSK || `${c.date}T${c.time}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return [...map.values()];
}
