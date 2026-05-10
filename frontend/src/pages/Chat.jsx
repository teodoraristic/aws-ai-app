import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { useChatWidget } from "../context/ChatWidgetContext.jsx";
import { getChatHistory, sendChatMessage } from "../api.js";
import { parseAssistantMessage } from "../utils/parseAssistant.js";
import styles from "./Chat.module.css";

const SESSION_KEY_PREFIX = "chat:sessionId:";

const SUGGESTIONS = [
  "Find an available session with a professor this Friday afternoon.",
  "Reserve a session about my thesis introduction.",
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

export default function Chat() {
  const { idToken, user } = useAuth();
  const { reportToolsUsed } = useChatWidget();
  const userId = user?.userId;

  // Session bootstrapping: on first mount for this user, prefer a stored
  // sessionId (Option A — resume the last in-progress conversation). If
  // there's nothing stored we mint a fresh UUID but DON'T persist it until
  // the user actually sends a message — keeps localStorage clean for
  // visitors who only peek at the assistant page.
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
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // Hydrate from the server when we resumed a stored session, so a refresh
  // brings the user back to where they left off. A fresh (unstored)
  // sessionId starts empty — no API roundtrip, no flash of "loading…".
  useEffect(() => {
    if (!idToken || !userId) return;
    if (!sessionPersistedRef.current) return;
    let alive = true;
    setHydrating(true);
    (async () => {
      try {
        const data = await getChatHistory(idToken, sessionId);
        if (!alive) return;
        const list = Array.isArray(data?.messages) ? data.messages : [];
        if (list.length === 0) {
          // Nothing came back (TTL expired, server purged, or the row never
          // existed). Drop the stale pointer so the welcome screen shows
          // and the user gets a clean session next time. Functional setter
          // so we never overwrite a thread the user has already started
          // typing/sending in this session.
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
        // Resume is best-effort. Keep the session pointer (so a transient
        // network failure doesn't reset the user) but show the welcome
        // screen until the user sends something.
        if (alive) setMessages((prev) => prev);
      } finally {
        if (alive) setHydrating(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [idToken, userId, sessionId]);

  function autosize(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  async function send(textOverride) {
    const text = (textOverride ?? input).trim();
    if (!text || sending) return;
    setError("");
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);
    // First send for a fresh session — pin the sessionId in localStorage so
    // the user can resume after a refresh / navigation away.
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
      // Notify any subscribed pages (Faculty directory, My Reservations,
      // Home) that the chatbot might have just changed a booking, so
      // they refetch their slot / consultation lists.
      reportToolsUsed(data.toolsUsed);
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

  const isEmpty = messages.length === 0 && !sending && !error && !hydrating;
  const firstName = user?.displayName?.split(" ")[0] || "";
  const showNewChat = messages.length > 0 || hydrating;

  return (
    <div className={styles.page}>
      <div className={styles.scroll}>
        <div className={styles.column}>
          {showNewChat && (
            <div className={styles.threadHead}>
              <button
                type="button"
                className={styles.newChat}
                onClick={startNewChat}
                disabled={sending}
                title="Start a new conversation"
              >
                <span className={styles.newChatIcon} aria-hidden>
                  +
                </span>
                New chat
              </button>
            </div>
          )}

          {isEmpty ? (
            <section className={styles.welcome}>
              <p className={styles.eyebrow}>Academic Assistant</p>
              <h1 className={styles.welcomeTitle}>
                {firstName
                  ? `Welcome back, ${firstName}`
                  : "What can I help with"}
                <span className={styles.titleDot} aria-hidden>
                  .
                </span>
              </h1>
              <p className={styles.welcomeLead}>
                Just tell me which professor, when, and what you&apos;d like
                to discuss — I&apos;ll handle the rest.
              </p>

              <ul className={styles.suggestions}>
                {SUGGESTIONS.map((s, i) => (
                  <li key={s} style={{ animationDelay: `${120 + i * 80}ms` }}>
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
            </section>
          ) : (
            <section className={styles.thread} aria-live="polite">
              {hydrating && messages.length === 0 && (
                <article className={styles.msgAssistant}>
                  <header className={styles.msgRole}>Academic Assistant</header>
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
                const isLastAssistant =
                  i === messages.length - 1 && m.role === "assistant";
                return (
                  <article key={i} className={styles.msgAssistant}>
                    <header className={styles.msgRole}>Academic Assistant</header>
                    {parsed.body && (
                      <div className={styles.msgBody}>{parsed.body}</div>
                    )}
                    {isLastAssistant && parsed.picks && parsed.picks.length > 0 && (
                      <ul className={styles.picks} aria-label="Quick replies">
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
                  <header className={styles.msgRole}>Academic Assistant</header>
                  <div className={styles.typing} aria-label="Academic Assistant is typing">
                    <span />
                    <span />
                    <span />
                  </div>
                </article>
              )}

              {error && <div className={styles.error}>{error}</div>}

              <div ref={endRef} />
            </section>
          )}
        </div>
      </div>

      <div className={styles.composerWrap}>
        <div className={styles.composerInner}>
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
              placeholder="Ask the Academic Assistant…"
              rows={1}
              className={styles.input}
            />
            <div className={styles.composerFoot}>
              <span className={styles.kbd}>
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd>{" "}
                for a new line
              </span>
              <button
                type="submit"
                className={styles.send}
                disabled={sending || !input.trim()}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
