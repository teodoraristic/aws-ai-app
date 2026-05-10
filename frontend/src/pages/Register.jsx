import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { signUp } from "aws-amplify/auth";
import { useAuth } from "../context/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import form from "../components/AuthForm.module.css";
import { friendlySignUpError } from "../utils/authErrors.js";

const ROLES = [
  { id: "student", label: "Student", hint: "Book consultations" },
  { id: "professor", label: "Professor", hint: "Hold office hours" },
];

const PASSWORD_HINT =
  "At least 8 characters, with one lowercase letter and one number.";

export default function Register() {
  const navigate = useNavigate();
  const { idToken, loading } = useAuth();
  const [role, setRole] = useState("student");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!loading && idToken) {
    return <Navigate to="/home" replace />;
  }

  function validate() {
    const trimmed = name.trim();
    if (!trimmed) return "Please enter your full name.";
    if (!/.+@.+\..+/.test(email)) return "Please enter a valid email address.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (!/[a-z]/.test(password)) return "Password needs at least one lowercase letter.";
    if (!/\d/.test(password)) return "Password needs at least one number.";
    return "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    setSubmitting(true);

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    try {
      const result = await signUp({
        username: cleanEmail,
        password,
        options: {
          userAttributes: {
            email: cleanEmail,
            "custom:role": role,
            "custom:displayName": cleanName,
          },
          autoSignIn: true,
        },
      });

      if (result.nextStep?.signUpStep === "CONFIRM_SIGN_UP") {
        navigate("/confirm", {
          state: { email: cleanEmail, role },
          replace: true,
        });
      } else if (result.nextStep?.signUpStep === "DONE") {
        navigate("/home", { replace: true });
      } else {
        navigate("/confirm", {
          state: { email: cleanEmail, role },
          replace: true,
        });
      }
    } catch (err) {
      console.error("signUp failed", err);
      setError(friendlySignUpError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Create account"
      title="Join the platform"
      subtitle="Pick your role, set up your account, and start booking consultations in minutes."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in →</Link>
        </>
      }
    >
      <form className={form.body} onSubmit={onSubmit} noValidate>
        <fieldset className={form.roleGroup}>
          <legend className={form.label}>I am a</legend>
          <div className={form.roleOptions} role="radiogroup">
            {ROLES.map((r) => {
              const active = role === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setRole(r.id)}
                  className={`${form.roleOption} ${
                    active ? form.roleOptionActive : ""
                  }`}
                >
                  <span className={form.roleDot} aria-hidden />
                  <span className={form.roleLabel}>{r.label}</span>
                  <span className={form.roleHint}>{r.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className={form.field}>
          <label className={form.label} htmlFor="reg-name">
            Full name
          </label>
          <input
            id="reg-name"
            className={form.input}
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
          />
        </div>

        <div className={form.field}>
          <label className={form.label} htmlFor="reg-email">
            Email
          </label>
          <input
            id="reg-email"
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
          <label className={form.label} htmlFor="reg-password">
            Password
          </label>
          <input
            id="reg-password"
            className={form.input}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <span className={form.hint}>{PASSWORD_HINT}</span>
        </div>

        {error && <div className={form.error}>{error}</div>}

        <button
          type="submit"
          className={form.submit}
          disabled={submitting}
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
