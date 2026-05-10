import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function RoleRoute({ allow }) {
  const { user } = useAuth();
  const role = user?.role || "student";
  const allowed = Array.isArray(allow) ? allow : [allow];
  if (!allowed.includes(role)) {
    return <Navigate to="/home" replace />;
  }
  return <Outlet />;
}
