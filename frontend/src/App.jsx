import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext.jsx";
import Layout from "./components/Layout.jsx";
import LoadingScreen from "./components/LoadingScreen.jsx";
import RoleRoute from "./components/RoleRoute.jsx";
import Home from "./pages/Home.jsx";
import Professors from "./pages/Professors.jsx";
import MyConsultations from "./pages/MyConsultations.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import ConfirmEmail from "./pages/ConfirmEmail.jsx";
import Callback from "./pages/Callback.jsx";

// Code-split the heavier role-gated pages. Calendar (date math + grid
// renderer + creation dialog), Analytics (chart-heavy) and Chat (large
// markdown renderer) are not on the critical login path, so we let
// Vite emit them as separate chunks and pull them in only when the
// user navigates there.
const Chat = lazy(() => import("./pages/Chat.jsx"));
const Calendar = lazy(() => import("./pages/Calendar.jsx"));
const Analytics = lazy(() => import("./pages/Analytics.jsx"));
const Thesis = lazy(() => import("./pages/Thesis.jsx"));

function ProtectedRoute() {
  const { idToken, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen label="Verifying session" />;
  }
  if (!idToken) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <Outlet />;
}

// Wraps a lazy route element so its initial chunk fetch shows the same
// LoadingScreen used for auth — avoids a flash of empty layout while the
// page bundle streams in.
function LazyPage({ element, label }) {
  return (
    <Suspense fallback={<LoadingScreen label={label} />}>{element}</Suspense>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/home" replace />} />

      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/confirm" element={<ConfirmEmail />} />
      <Route path="/callback" element={<Callback />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          {/* Both roles */}
          <Route path="/home" element={<Home />} />
          <Route path="/my-consultations" element={<MyConsultations />} />
          <Route element={<RoleRoute allow={["student", "professor"]} />}>
            <Route
              path="/thesis"
              element={<LazyPage element={<Thesis />} label="Loading thesis" />}
            />
          </Route>

          {/* Students only */}
          <Route element={<RoleRoute allow="student" />}>
            <Route
              path="/chat"
              element={<LazyPage element={<Chat />} label="Loading chat" />}
            />
            <Route path="/professors" element={<Professors />} />
          </Route>

          {/* Professors only — the Calendar page is now the single
              schedule surface (visualisation + create / delete). The
              old `/availability` URL stays as a redirect so any
              bookmarks or stale notification links land on the new
              page instead of 404'ing. */}
          <Route element={<RoleRoute allow="professor" />}>
            <Route
              path="/availability"
              element={<Navigate to="/calendar" replace />}
            />
            <Route
              path="/calendar"
              element={
                <LazyPage element={<Calendar />} label="Loading calendar" />
              }
            />
          </Route>

          {/* Analytics — open to professors and admins. The page itself
              switches its data source based on the role. */}
          <Route element={<RoleRoute allow={["professor", "admin"]} />}>
            <Route
              path="/analytics"
              element={
                <LazyPage element={<Analytics />} label="Loading analytics" />
              }
            />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
