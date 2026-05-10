import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

// Lets any page imperatively pop the floating student chatbot open and,
// optionally, queue an initial message that the widget should auto-send the
// moment it mounts / opens. The widget owns its own conversation state; the
// context only carries the "please open" intent so we don't entangle any of
// the page-level components with the chat transport.
//
// Pages call `openWidget(message?)` and the widget reacts by:
//   1. flipping its panel open,
//   2. consuming the pending message exactly once (id-bumped on every call,
//      so back-to-back Reserve clicks each fire fresh sends),
//   3. sending it through the same /chat pipeline as a regular keystroke.
//
// The context also exposes a tiny `bookingTick` counter the chat widget
// bumps every time the assistant ran a tool that mutates schedule data
// (book_slot / join_group_session / cancel_consultation). Pages that
// render schedule-derived state — Faculty directory slot lists,
// My Reservations, Home upcoming — subscribe to it and refetch when it
// changes. This keeps the rest of the UI in sync with bookings the
// student just made through the chatbot, without polling.
const ChatWidgetContext = createContext(null);

const MUTATING_TOOL_NAMES = new Set([
  "book_slot",
  "join_group_session",
  "cancel_consultation",
  "join_waitlist",
  "leave_waitlist",
  "propose_thesis",
]);

export function ChatWidgetProvider({ children }) {
  const [request, setRequest] = useState({ id: 0, message: "" });
  const requestIdRef = useRef(0);
  // Monotonic counter — incremented every time the chatbot runs a
  // schedule-mutating tool. Subscribed pages depend on this in a
  // useEffect to trigger a refetch.
  const [bookingTick, setBookingTick] = useState(0);

  const openWidget = useCallback((message = "") => {
    requestIdRef.current += 1;
    setRequest({ id: requestIdRef.current, message: message || "" });
  }, []);

  // Called by the chat surfaces (StudentChatWidget, /chat page) every
  // time the backend reports a tool call. We filter to the mutating
  // tools here so callers don't have to repeat the list.
  const reportToolsUsed = useCallback((tools) => {
    if (!Array.isArray(tools) || tools.length === 0) return;
    const mutated = tools.some((name) => MUTATING_TOOL_NAMES.has(name));
    if (mutated) {
      setBookingTick((t) => t + 1);
    }
  }, []);

  const value = useMemo(
    () => ({ request, openWidget, bookingTick, reportToolsUsed }),
    [request, openWidget, bookingTick, reportToolsUsed]
  );

  return (
    <ChatWidgetContext.Provider value={value}>
      {children}
    </ChatWidgetContext.Provider>
  );
}

export function useChatWidget() {
  const ctx = useContext(ChatWidgetContext);
  // Pages outside the provider (e.g. login screens) should still be able to
  // call useChatWidget without crashing — return a noop so the call site
  // stays branch-free.
  if (!ctx) {
    return {
      request: { id: 0, message: "" },
      openWidget: () => {},
      bookingTick: 0,
      reportToolsUsed: () => {},
    };
  }
  return ctx;
}
