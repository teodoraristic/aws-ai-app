import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "./AuthContext.jsx";
import {
  deleteNotification as deleteNotificationApi,
  getNotifications,
  markAllNotificationsRead as markAllNotificationsReadApi,
  markNotificationRead as markNotificationReadApi,
} from "../api.js";

// Notifications are now server-truth. The previous implementation hashed the
// message text into a synthetic id and stored read/unread state in
// localStorage; that was racy (the old GET /me/consultations endpoint cleared
// the server-side `read` flag the moment the row was fetched, so any network
// drop between server-clear and client-render lost the notification forever).
//
// This context now:
//   - polls GET /me/notifications every 60s for the latest list,
//   - keeps the list in memory only — browser switches reconcile from
//     the server on next login,
//   - calls dedicated PATCH / POST / DELETE endpoints when the user marks
//     items read or removes them.
const POLL_MS = 60_000;

const NotificationContext = createContext(null);

export function NotificationProvider({ children }) {
  const { idToken, user } = useAuth();
  const userId = user?.userId;

  const [notifs, setNotifs] = useState([]);

  // Mounted flag so async fetch callbacks don't write into state for a
  // user that's already logged out.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!idToken) return;
    try {
      const data = await getNotifications(idToken);
      if (!aliveRef.current) return;
      setNotifs(Array.isArray(data?.notifications) ? data.notifications : []);
    } catch {
      // Network or API hiccup — keep the previous in-memory list, never
      // surface this to the user. The next poll will retry.
    }
  }, [idToken]);

  // Reset state on logout so the next user doesn't briefly see the prior
  // user's notifications during the first render after sign-in.
  useEffect(() => {
    if (!userId) setNotifs([]);
  }, [userId]);

  // Initial fetch on login + polling. The poll pauses while the tab is
  // hidden so background tabs don't keep hitting the API every minute,
  // and a one-shot refresh fires the moment the tab becomes visible
  // again so the badge is correct as soon as the user looks at it.
  useEffect(() => {
    if (!idToken) return undefined;
    if (typeof document === "undefined") {
      // SSR / non-browser fallback — keep the simple interval.
      refresh();
      const id = setInterval(refresh, POLL_MS);
      return () => clearInterval(id);
    }

    let intervalId = null;
    function start() {
      if (intervalId !== null) return;
      intervalId = setInterval(refresh, POLL_MS);
    }
    function stop() {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    }
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // Catch up immediately on tab focus, then resume the cadence.
        refresh();
        start();
      }
    }

    refresh();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [idToken, refresh]);

  const unreadCount = notifs.filter((n) => !n.read).length;

  const markRead = useCallback(
    async (id) => {
      if (!idToken || !id) return;
      // Optimistic flip — the server is authoritative on the next poll.
      setNotifs((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
      try {
        await markNotificationReadApi(idToken, id);
      } catch {
        // Revert on failure so the bell badge stays accurate.
        refresh();
      }
    },
    [idToken, refresh]
  );

  const markAllRead = useCallback(async () => {
    if (!idToken) return;
    setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await markAllNotificationsReadApi(idToken);
    } catch {
      refresh();
    }
  }, [idToken, refresh]);

  const remove = useCallback(
    async (id) => {
      if (!idToken || !id) return;
      const snapshot = notifs;
      setNotifs((prev) => prev.filter((n) => n.id !== id));
      try {
        await deleteNotificationApi(idToken, id);
      } catch {
        // Restore on failure — better to show a stale row than silently
        // swallow user intent.
        setNotifs(snapshot);
      }
    },
    [idToken, notifs]
  );

  return (
    <NotificationContext.Provider
      value={{
        notifs,
        unreadCount,
        markRead,
        markAllRead,
        remove,
        refresh,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx)
    throw new Error("useNotifications must be used inside NotificationProvider");
  return ctx;
}
