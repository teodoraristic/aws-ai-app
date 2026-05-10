import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useNotifications } from "../context/NotificationContext.jsx";
import { ChatWidgetProvider } from "../context/ChatWidgetContext.jsx";
import { initials } from "../utils/format.js";
import BrandMark from "./BrandMark.jsx";
import ProfessorChatWidget from "./ProfessorChatWidget.jsx";
import StudentChatWidget from "./StudentChatWidget.jsx";
import styles from "./Layout.module.css";

// Navigation deliberately stays slim:
//   - Students no longer have a top-level "Academic Assistant" link —
//     the floating chatbot in the bottom-right corner is the primary
//     entry point now, and the dedicated /chat page is reachable from
//     the widget itself ("Open full chat").
//   - Professors have a single "Calendar" entry — the calendar IS the
//     schedule (visualisation + creation), having merged the previous
//     separate Office Hours page into it. One surface for one job.
//   - Professors no longer have a top-level "Analytics" link — it now
//     lives inside the profile dropdown next to Sign out (account-
//     scoped, lower-frequency action). Admins keep it in the navbar
//     since it's effectively their primary screen.
const NAV_BY_ROLE = {
  student: [
    { to: "/home", label: "Home" },
    { to: "/professors", label: "Faculty" },
    { to: "/my-consultations", label: "My Reservations" },
    { to: "/thesis", label: "Thesis" },
  ],
  professor: [
    { to: "/home", label: "Home" },
    { to: "/calendar", label: "Calendar" },
    { to: "/my-consultations", label: "Reservations" },
    { to: "/thesis", label: "Thesis" },
  ],
  admin: [
    { to: "/home", label: "Home" },
    { to: "/analytics", label: "Analytics" },
  ],
};

function timeAgo(ts) {
  // Accept either an ISO string (server-side notifications) or a numeric
  // epochMs (legacy in-memory entries) so the bell stays robust during the
  // transition.
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function NotificationBell() {
  const { notifs, unreadCount, markRead, markAllRead, remove } =
    useNotifications();
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  // Close on outside click / escape
  useEffect(() => {
    if (!open) return;
    function handleMouse(e) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouse);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouse);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className={styles.bellWrap}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.bellBtn} ${unreadCount > 0 ? styles.bellBtnActive : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={
          unreadCount > 0
            ? `Notifications — ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg
          className={`${styles.bellIcon} ${unreadCount > 0 && !open ? styles.bellRing : ""}`}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className={styles.bellBadge} aria-hidden="true">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className={styles.notifPanel}
          role="dialog"
          aria-label="Notifications panel"
        >
          <div className={styles.notifPanelHead}>
            <span className={styles.notifPanelTitle}>Notifications</span>
            {notifs.length > 0 && unreadCount > 0 && (
              <button
                type="button"
                className={styles.notifMarkAllBtn}
                onClick={markAllRead}
              >
                Mark all as read
              </button>
            )}
          </div>

          {notifs.length === 0 ? (
            <div className={styles.notifEmpty}>
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <p>No notifications yet</p>
            </div>
          ) : (
            <ul className={styles.notifList} aria-label="Notification items">
              {notifs.map((n) => (
                <li
                  key={n.id}
                  className={`${styles.notifItem} ${n.read ? styles.notifItemRead : ""}`}
                >
                  <span
                    className={styles.notifUnreadDot}
                    aria-hidden="true"
                  />
                  <div className={styles.notifBody}>
                    <p className={styles.notifMsg}>{n.message}</p>
                    <time
                      className={styles.notifTime}
                      dateTime={new Date(n.createdAt).toISOString()}
                    >
                      {timeAgo(n.createdAt)}
                    </time>
                  </div>
                  <div className={styles.notifActions}>
                    {!n.read && (
                      <button
                        type="button"
                        className={styles.notifActionBtn}
                        onClick={() => markRead(n.id)}
                        aria-label="Mark as read"
                        title="Mark as read"
                      >
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 13 13"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M2 6.5l3.5 3.5 5.5-6"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.notifActionBtn} ${styles.notifDeleteBtn}`}
                      onClick={() => remove(n.id)}
                      aria-label="Delete notification"
                      title="Delete"
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 11 11"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M1 1l9 9M10 1L1 10"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Profile menu: clicking the avatar pill in the navbar opens an
// account-scoped dropdown. Houses the lower-frequency actions that
// shouldn't compete with day-to-day nav links — Analytics for
// professors, plus Sign out for everyone. Mirrors the NotificationBell
// interaction model: outside-click and Escape both close, focus
// returns to the trigger so keyboard users don't get stranded, and
// ARIA wires up `aria-haspopup="menu"` + `aria-expanded` + `role="menu"`.
function ProfileMenu({ user, role, display, onLogout }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleMouse(e) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function handleKey(e) {
      if (e.key === "Escape") {
        setOpen(false);
        // Return focus to the trigger so keyboard users keep their
        // place in the tab order instead of jumping to <body>.
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleMouse);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouse);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
  }

  const email = user?.email || "";
  // Per-role menu items, keyed for stable rendering. Sign out always
  // sits last and is rendered with the danger styling.
  const items = [];
  if (role === "professor") {
    items.push({
      key: "analytics",
      to: "/analytics",
      label: "Analytics",
      hint: "Insights across your sessions",
      icon: (
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 13.5h11M4.5 11V7.5M8 11V4.5M11.5 11V8.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    });
  }

  return (
    <div className={styles.profileWrap}>
      <button
        ref={btnRef}
        type="button"
        className={`${styles.profileBtn} ${open ? styles.profileBtnOpen : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={display ? `Account menu for ${display}` : "Account menu"}
        title={display}
      >
        <span className={styles.userAvatar} aria-hidden>
          {initials(display)}
        </span>
        <span className={styles.userName}>{display}</span>
        <svg
          className={`${styles.profileChevron} ${
            open ? styles.profileChevronOpen : ""
          }`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 3.5L5 6.5L8 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={panelRef}
          className={styles.profilePanel}
          role="menu"
          aria-label="Account menu"
        >
          <div className={styles.profilePanelHead}>
            <span className={styles.profileBigAvatar} aria-hidden>
              {initials(display)}
            </span>
            <div className={styles.profileNameStack}>
              <span className={styles.profileFullName}>
                {display || "Account"}
              </span>
              {email && (
                <span className={styles.profileEmail} title={email}>
                  {email}
                </span>
              )}
            </div>
          </div>

          {items.length > 0 && (
            <>
              <div className={styles.profileDivider} aria-hidden />
              <ul className={styles.profileMenuList}>
                {items.map((item) => (
                  <li key={item.key}>
                    <Link
                      to={item.to}
                      role="menuitem"
                      className={styles.profileMenuItem}
                      onClick={close}
                    >
                      <span
                        className={styles.profileMenuItemIcon}
                        aria-hidden
                      >
                        {item.icon}
                      </span>
                      <span className={styles.profileMenuItemText}>
                        <span className={styles.profileMenuItemLabel}>
                          {item.label}
                        </span>
                        {item.hint && (
                          <span className={styles.profileMenuItemHint}>
                            {item.hint}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className={styles.profileDivider} aria-hidden />
          <ul className={styles.profileMenuList}>
            <li>
              <button
                type="button"
                role="menuitem"
                className={`${styles.profileMenuItem} ${styles.profileMenuItemDanger}`}
                onClick={() => {
                  close();
                  onLogout();
                }}
              >
                <span className={styles.profileMenuItemIcon} aria-hidden>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M9.5 11.5l3-3.5-3-3.5M12.5 8H6M9 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H9"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className={styles.profileMenuItemText}>
                  <span className={styles.profileMenuItemLabel}>Sign out</span>
                </span>
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const display = user?.displayName || user?.email || "";
  const role = user?.role || "student";
  const nav = NAV_BY_ROLE[role] || NAV_BY_ROLE.student;

  // Suppress the floating student widget on the dedicated /chat page —
  // the full-page Academic Assistant lives there, and a second floating
  // panel on top of it would compete for the same conversation surface.
  const hideStudentWidget = location.pathname.startsWith("/chat");

  return (
    <ChatWidgetProvider>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Link to="/home" className={styles.brand} aria-label="Home">
              <BrandMark size={30} className={styles.brandMark} />
              <span className={styles.brandWord}>Consultations</span>
            </Link>

            <nav className={styles.nav} aria-label="Main navigation">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `${styles.navLink} ${isActive ? styles.navLinkActive : ""}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className={styles.user}>
              <NotificationBell />
              {display ? (
                <ProfileMenu
                  user={user}
                  role={role}
                  display={display}
                  onLogout={logout}
                />
              ) : (
                <button
                  type="button"
                  className={styles.logout}
                  onClick={logout}
                >
                  Sign out
                </button>
              )}
            </div>
          </div>
        </header>

        <main className={styles.main}>
          <Outlet />
        </main>

        {role === "professor" && <ProfessorChatWidget />}
        {role === "student" && !hideStudentWidget && <StudentChatWidget />}

        <footer className={styles.footer}>
          <span className={styles.footerBrand}>Consultations</span>
          <span className={styles.footerDot} aria-hidden>
            ·
          </span>
          <span>Student services scheduling system</span>
          <span className={styles.footerDot} aria-hidden>
            ·
          </span>
          <span className={styles.footerMuted}>
            {new Date().getFullYear()} — internal release
          </span>
        </footer>
      </div>
    </ChatWidgetProvider>
  );
}
