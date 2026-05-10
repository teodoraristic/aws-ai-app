import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import { getChatHistory, sendChatMessage } from "../api.js";
import { parseAssistantMessage } from "../utils/parseAssistant.js";
import styles from "./StudentChatWidget.module.css";

// Floating bottom-right Academic Assistant for students. Mirrors the
// student `/chat` page (full booking + cancellation flows, picks, session
// resume) inside a compact panel so the chatbot is the primary entry point
// from anywhere in the app — Home, Faculty directory, My Reservations…
//
// Important: this widget shares its localStorage session key with the
// full Chat page (`chat:sessionId:`) on purpose. A student can start a
// conversation in the widget, click "Open full view", and the same thread
// resumes there — and vice versa.
//
// External pages can pop the widget open and pre-send a message via
// `useChatWidget().openWidget(text)`. The Faculty directory uses this for
// the manual Reserve button: instead of a modal, clicking Reserve opens
// the assistant with "I'd like to book Prof X on …", and the assistant
// then asks for the topic and follows the normal booking flow.
const SESSION_KEY_PREFIX = "chat:sessionId:";

const SUGGESTIONS = [
  "Find a session this Friday afternoon.",
  "Book a slot to discuss my thesis.",
  "Show me my upcoming reservations.",
  "Cancel my Wednesday 12:00 session.",
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

export default function StudentChatWidget() {
  const { idToken, user } = useAuth();
  const userId = user?.userId;
  const navigate = useNavigate();
  const { request, reportToolsUsed } = useChatWidget();

  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState(
    () => readStoredSessionId(userId) || newSessionId()
  );
  const sessionPersistedRef = useRef(Boolean(readStoredSessionId(userId)));

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [hydrating, setHydrating] = useState(false);

  // Tracks whether the panel has ever been opened in this mount. We only
  // hydrate from server on the first open of a resumed session — saves a
  // roundtrip for students who never click the FAB on a given page load.
  const hydratedRef = useRef(false);
  // Tracks the last consumed openWidget request so a single Reserve click
  // doesn't re-fire its message every time this component re-renders.
  const consumedRequestIdRef = useRef(0);
  // Snapshot of the latest sent message text so we can render an unread
  // ping on the FAB after the assistant replies while the panel is closed.
  const [hasUnseen, setHasUnseen] = useState(false);

  const endRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, open]);

  // Hydrate from server only on first open if we resumed a stored session.
  // Important: when the open was triggered by an external openWidget()
  // call carrying a pre-filled message (e.g. a Reserve click), the
  // auto-send below races with this fetch. We use functional setMessages
  // so a late hydration response can NEVER overwrite a thread the user
  // has already started filling in this session.
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
          // Server has nothing (TTL expired or row missing) — drop the
          // pointer and start clean next time, but only if the local
          // thread is also empty. If the user has already started
          // typing/sending we leave their messages alone.
          writeStoredSessionId(userId, null);
          sessionPersistedRef.current = false;
          setMessages((prev) => (prev.length === 0 ? [] : prev));
        } else {
          setMessages((prev) =>
            prev.length === 0
              ? list.map((m) => ({ role: m.role, content: m.content || "" }))
              : prev
          );
        }
      } catch {
        if (alive) setMessages((prev) => prev);
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
      // If the assistant ran a schedule-mutating tool this turn, ping
      // the rest of the app so slot lists / reservations refetch.
      reportToolsUsed(data.toolsUsed);
      // If the panel is closed when the assistant replies (rare — usually
      // the user is watching), surface a soft unread ping on the FAB.
      setHasUnseen((prev) => (open ? prev : true));
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  // External "open with a pre-message" requests: the Faculty directory's
  // Reserve button calls useChatWidget().openWidget("I'd like to book…").
  // We watch the request id (not the text, which can repeat) and consume
  // each new id exactly once.
  useEffect(() => {
    if (!request || !request.id) return;
    if (request.id === consumedRequestIdRef.current) return;
    consumedRequestIdRef.current = request.id;
    setOpen(true);
    setHasUnseen(false);
    if (request.message) {
      // Defer one tick so the panel mount + hydrate effect runs first; the
      // message lands cleanly at the bottom of the thread either way.
      Promise.resolve().then(() => send(request.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Once the panel is open, any unread badge is moot.
  useEffect(() => {
    if (open) setHasUnseen(false);
  }, [open]);

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

  function openFullView() {
    setOpen(false);
    navigate("/chat");
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
          aria-label="Academic Assistant"
        >
          <header className={styles.head}>
            <div className={styles.headLeft}>
              <span className={styles.crest} aria-hidden>
                A
              </span>
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
                  New
                </button>
              )}
              <button
                type="button"
                className={styles.linkBtn}
                onClick={openFullView}
                title="Open the full Academic Assistant page"
              >
                Full view
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className={styles.linkBtnIcon}
                >
                  <path
                    d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                title="Close"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
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
                <p className={styles.emptyTitle}>
                  Tell me what you need.
                </p>
                <p className={styles.emptyHint}>
                  I can find professors, book consultations, and look up your
                  schedule — just describe it in plain words.
                </p>
                <ul className={styles.suggestions}>
                  {SUGGESTIONS.map((s, i) => (
                    <li
                      key={s}
                      style={{ animationDelay: `${80 + i * 60}ms` }}
                    >
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
                <div
                  className={styles.typing}
                  aria-label="Loading previous messages"
                >
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
              const isLastAssistant =
                i === messages.length - 1 && m.role === "assistant";
              return (
                <article key={i} className={styles.msgAssistant}>
                  <header className={styles.msgRole}>Assistant</header>
                  {parsed.body && (
                    <div className={styles.msgBody}>{parsed.body}</div>
                  )}
                  {isLastAssistant &&
                    parsed.picks &&
                    parsed.picks.length > 0 && (
                      <ul
                        className={styles.picks}
                        aria-label="Quick replies"
                      >
                        {parsed.picks.map((pick, pi) => (
                          <li key={`${pi}-${pick.value}`}>
                            <button
                              type="button"
                              className={styles.pick}
                              disabled={sending}
                              onClick={() => send(pick.value)}
                            >
                              {pick.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                </article>
              );
            })}

            {sending && (
              <article className={styles.msgAssistant}>
                <header className={styles.msgRole}>Assistant</header>
                <div
                  className={styles.typing}
                  aria-label="Assistant is typing"
                >
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
              placeholder="Ask the assistant…"
              rows={1}
              className={styles.input}
            />
            <button
              type="submit"
              className={styles.send}
              disabled={sending || !input.trim()}
              aria-label="Send"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path
                  d="M2 7l10-5-3.2 10.5L7 9 2 7z"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="0.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        className={`${styles.fab} ${open ? styles.fabActive : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={
          open ? "Close Academic Assistant" : "Open Academic Assistant"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className={styles.fabIconWrap}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2V5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <circle cx="9" cy="9.5" r="1" fill="currentColor" />
            <circle cx="12" cy="9.5" r="1" fill="currentColor" />
            <circle cx="15" cy="9.5" r="1" fill="currentColor" />
          </svg>
          {hasUnseen && !open && (
            <span className={styles.fabPing} aria-hidden />
          )}
        </span>
        <span className={styles.fabLabel}>
          {open ? "Close" : "Ask"}
        </span>
      </button>
    </div>
  );
}
