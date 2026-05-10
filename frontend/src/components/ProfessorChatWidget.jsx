import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { getChatHistory, sendChatMessage } from "../api.js";
import { parseAssistantMessage } from "../utils/parseAssistant.js";
import styles from "./ProfessorChatWidget.module.css";

// Small floating widget pinned to the bottom-right of every professor page.
// Backed by the same /chat endpoint as the student page; the backend serves
// a professor-only system prompt and the get_my_consultations tool, so the
// widget can answer "what's on my plate tomorrow?" / "who's coming for SQL
// joins?" without exposing booking or cancellation flows.
//
// Session state is stored in localStorage under a widget-specific key so
// resuming after a refresh works the same way the student chat does.
const SESSION_KEY_PREFIX = "chat:profWidgetSessionId:";

const SUGGESTIONS = [
  "What do I have tomorrow?",
  "Who booked sessions this week?",
  "What topics are coming up?",
];

function newSessionId() {
  return crypto.randomUUID();
}

function readStoredSessionId(userId) {
  if (!userId || typeof window === "undefined") return null;
  return window.localStorage.getItem(`${SESSION_KEY_PREFIX}${userId}`) || null;
}

function writeStoredSessionId(userId, sessionId) {
  if (!userId || typeof window === "undefined") return;
  if (sessionId) {
    window.localStorage.setItem(`${SESSION_KEY_PREFIX}${userId}`, sessionId);
  } else {
    window.localStorage.removeItem(`${SESSION_KEY_PREFIX}${userId}`);
  }
}

export default function ProfessorChatWidget() {
  const { idToken, user } = useAuth();
  const userId = user?.userId;

  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState(() => readStoredSessionId(userId) || newSessionId());
  const sessionPersistedRef = useRef(Boolean(readStoredSessionId(userId)));

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [hydrating, setHydrating] = useState(false);

  const endRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, open]);

  // Hydrate from server only the first time we open the panel for a
  // resumed session — avoids burning a roundtrip if the professor never
  // opens the widget on this page load.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (hydratedRef.current) return;
    if (!idToken || !userId) return;
    if (!sessionPersistedRef.current) {
      hydratedRef.current = true;
      return;
    }
    let alive = true;
    setHydrating(true);
    (async () => {
      try {
        const data = await getChatHistory(idToken, sessionId);
        if (!alive) return;
        const list = Array.isArray(data?.messages) ? data.messages : [];
        if (list.length === 0) {
          writeStoredSessionId(userId, null);
          sessionPersistedRef.current = false;
          setMessages([]);
        } else {
          setMessages(list.map((m) => ({ role: m.role, content: m.content || "" })));
        }
      } catch {
        if (alive) setMessages([]);
      } finally {
        if (alive) {
          setHydrating(false);
          hydratedRef.current = true;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, idToken, userId, sessionId]);

  function autosize(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  async function send(textOverride) {
    const text = (textOverride ?? input).trim();
    if (!text || sending) return;
    setError("");
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);
    if (!sessionPersistedRef.current) {
      writeStoredSessionId(userId, sessionId);
      sessionPersistedRef.current = true;
    }
    try {
      const data = await sendChatMessage(idToken, sessionId, text);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "" },
      ]);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  function startNewChat() {
    if (sending) return;
    writeStoredSessionId(userId, null);
    sessionPersistedRef.current = false;
    hydratedRef.current = true;
    setMessages([]);
    setError("");
    setInput("");
    setSessionId(newSessionId());
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!userId) return null;

  return (
    <div className={styles.wrap}>
      {open && (
        <div
          className={styles.panel}
          role="dialog"
          aria-label="Schedule assistant"
        >
          <header className={styles.head}>
            <div>
              <p className={styles.eyebrow}>Schedule</p>
              <h2 className={styles.title}>Assistant</h2>
            </div>
            <div className={styles.headActions}>
              {messages.length > 0 && (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={startNewChat}
                  disabled={sending}
                  title="Start a new conversation"
                >
                  New chat
                </button>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                title="Close"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path
                    d="M3 3l8 8M11 3l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </header>

          <div className={styles.body}>
            {messages.length === 0 && !hydrating && !sending && (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>Ask about your schedule.</p>
                <p className={styles.emptyHint}>
                  This assistant can summarise upcoming reservations and help
                  you find who is coming, when, and what for.
                </p>
                <ul className={styles.suggestions}>
                  {SUGGESTIONS.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        className={styles.suggestion}
                        onClick={() => send(s)}
                      >
                        <span className={styles.suggestionMark} aria-hidden>
                          →
                        </span>
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hydrating && messages.length === 0 && (
              <article className={styles.msgAssistant}>
                <header className={styles.msgRole}>Assistant</header>
                <div className={styles.typing} aria-label="Loading previous messages">
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            )}

            {messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <article key={i} className={styles.msgUser}>
                    <header className={styles.msgRole}>You</header>
                    <div className={styles.msgBody}>{m.content}</div>
                  </article>
                );
              }
              const parsed = parseAssistantMessage(m.content);
              return (
                <article key={i} className={styles.msgAssistant}>
                  <header className={styles.msgRole}>Assistant</header>
                  {parsed.body && (
                    <div className={styles.msgBody}>{parsed.body}</div>
                  )}
                </article>
              );
            })}

            {sending && (
              <article className={styles.msgAssistant}>
                <header className={styles.msgRole}>Assistant</header>
                <div className={styles.typing} aria-label="Assistant is typing">
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            )}

            {error && <div className={styles.error}>{error}</div>}

            <div ref={endRef} />
          </div>

          <form
            className={styles.composer}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autosize(e.target);
              }}
              onKeyDown={onKeyDown}
              placeholder="Ask about your schedule…"
              rows={1}
              className={styles.input}
            />
            <button
              type="submit"
              className={styles.send}
              disabled={sending || !input.trim()}
            >
              {sending ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className={`${styles.fab} ${open ? styles.fabActive : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close schedule assistant" : "Open schedule assistant"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 5h14v10H8l-3 3V5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        <span className={styles.fabLabel}>Ask</span>
      </button>
    </div>
  );
}
