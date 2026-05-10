import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { signIn } from "aws-amplify/auth";
import { useAuth } from "../context/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import form from "../components/AuthForm.module.css";
import { friendlySignInError } from "../utils/authErrors.js";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { idToken, refresh, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fromState = location.state?.from?.pathname;
  const successMessage = location.state?.notice || "";
  const redirectTo = fromState || "/home";

  if (!loading && idToken) {
    return <Navigate to={redirectTo} replace />;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const result = await signIn({
        username: email.trim().toLowerCase(),
        password,
      });

      if (result.nextStep?.signInStep === "CONFIRM_SIGN_UP") {
        navigate("/confirm", {
          state: { email: email.trim().toLowerCase() },
          replace: true,
        });
        return;
      }

      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      console.error("signIn failed", err);
      setError(friendlySignInError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Sign in"
      title="Welcome back"
      subtitle="Use your university email and password to access the assistant, your professors, and your scheduled consultations."
      footer={
        <>
          New to the platform?{" "}
          <Link to="/register">Create an account →</Link>
        </>
      }
    >
      {successMessage && <div className={form.notice}>{successMessage}</div>}

      <form className={form.body} onSubmit={onSubmit} noValidate>
        <div className={form.field}>
          <label className={form.label} htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            className={form.input}
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@university.edu"
          />
        </div>

        <div className={form.field}>
          <label className={form.label} htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            className={form.input}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>

        {error && <div className={form.error}>{error}</div>}

        <button
          type="submit"
          className={form.submit}
          disabled={submitting || !email || !password}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}
