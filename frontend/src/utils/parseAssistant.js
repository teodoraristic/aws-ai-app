const RE_THINKING = /<thinking>([\s\S]*?)<\/thinking>/gi;
const RE_OPEN_THINKING = /<thinking>/i;
const RE_RESPONSE_TAGS = /<\/?response\s*>/gi;
const RE_PICKS = /<picks>([\s\S]*?)<\/picks>/gi;

// Parses an assistant message into:
//   - body:   the prose to render (with <thinking>, <response>, <picks> stripped)
//   - thinking: legacy chain-of-thought (UI no longer renders this, but the
//               cleanup remains so a misbehaving model never leaks <thinking>
//               markup into the chat bubble)
//   - picks:  optional array of { label, value } the UI renders as clickable
//             buttons under the message. Click → sends `value` as the next
//             user message. Empty / malformed blocks resolve to null.
export function parseAssistantMessage(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return { thinking: null, body: "", picks: null };

  const thoughts = [];
  let body = text.replace(RE_THINKING, (_match, inner) => {
    const trimmed = (inner || "").trim();
    if (trimmed) thoughts.push(trimmed);
    return "";
  });

  // Defensive: an unclosed <thinking> tag means streaming was cut off or the
  // model misbehaved. Treat everything after the open tag as thinking so the
  // user never sees raw markup.
  const openMatch = body.match(RE_OPEN_THINKING);
  if (openMatch) {
    const idx = openMatch.index ?? 0;
    const tail = body.slice(idx + openMatch[0].length).trim();
    if (tail) thoughts.push(tail);
    body = body.slice(0, idx);
  }

  // Some prompts make the model wrap its reply in <response>...</response>.
  // Keep the inner content but drop the literal tags so the user never sees
  // them. Stripping both forms also handles unmatched / stray tags safely.
  body = body.replace(RE_RESPONSE_TAGS, "");

  // Extract the LAST <picks>...</picks> block (model is instructed to emit
  // exactly one at the end of the message; if it slips and sends multiple,
  // the last one represents its final intent). Always strip every picks
  // tag from the body either way.
  let picks = null;
  let lastMatch = null;
  for (const match of body.matchAll(RE_PICKS)) {
    lastMatch = match;
  }
  body = body.replace(RE_PICKS, "");
  if (lastMatch) {
    const inner = (lastMatch[1] || "").trim();
    if (inner) {
      try {
        const parsed = JSON.parse(inner);
        if (Array.isArray(parsed)) {
          const cleaned = parsed
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const label = typeof item.label === "string" ? item.label.trim() : "";
              const value = typeof item.value === "string" ? item.value.trim() : "";
              if (!label || !value) return null;
              return { label, value };
            })
            .filter(Boolean);
          if (cleaned.length > 0) picks = cleaned;
        }
      } catch {
        // Malformed JSON — silently drop the picks block. The prose is still
        // rendered so the user can read the numbered list and reply by
        // typing.
      }
    }
  }

  body = body.replace(/\n{3,}/g, "\n\n").trim();
  const thinking = thoughts.length ? thoughts.join("\n\n") : null;
  return { thinking, body, picks };
}
