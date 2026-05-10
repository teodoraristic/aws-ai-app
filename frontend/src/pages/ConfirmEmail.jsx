import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  autoSignIn,
  confirmSignUp,
  resendSignUpCode,
} from "aws-amplify/auth";
import { useAuth } from "../context/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import form from "../components/AuthForm.module.css";
import { friendlyConfirmError } from "../utils/authErrors.js";

const CODE_LENGTH = 6;

export default function ConfirmEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const { idToken, refresh, loading } = useAuth();
  const [digits, setDigits] = useState(() => Array(CODE_LENGTH).fill(""));
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inputsRef = useRef([]);

  const email = location.state?.email || "";

  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  if (!loading && idToken) {
    return <Navigate to="/home" replace />;
  }

  if (!email) {
    return <Navigate to="/register" replace />;
  }

  const code = digits.join("");
  const ready = code.length === CODE_LENGTH && /^\d+$/.test(code);

  function setDigit(idx, value) {
    const cleaned = value.replace(/\D/g, "").slice(0, 1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = cleaned;
      return next;
    });
    if (cleaned && idx < CODE_LENGTH - 1) {
      inputsRef.current[idx + 1]?.focus();
    }
  }

  function onKeyDown(idx, e) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowRight" && idx < CODE_LENGTH - 1) {
      inputsRef.current[idx + 1]?.focus();
    }
  }

  function onPaste(e) {
    const pasted = (e.clipboardData?.getData("text") || "")
      .replace(/\D/g, "")
      .slice(0, CODE_LENGTH);
    if (!pasted) return;
    e.preventDefault();
    const next = Array(CODE_LENGTH).fill("");
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setDigits(next);
    const target = Math.min(pasted.length, CODE_LENGTH - 1);
    inputsRef.current[target]?.focus();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || !ready) return;
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      await confirmSignUp({ username: email, confirmationCode: code });

      try {
        const auto = await autoSignIn();
        if (auto?.nextStep?.signInStep === "DONE") {
          await refresh();
          navigate("/home", { replace: true });
          return;
        }
      } catch (autoErr) {
        console.warn("autoSignIn failed", autoErr);
      }

      navigate("/login", {
        replace: true,
        state: {
          notice: "Email verified. Please sign in to continue.",
        },
      });
    } catch (err) {
      console.error("confirmSignUp failed", err);
      setError(friendlyConfirmError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend() {
    if (resending) return;
    setError("");
    setNotice("");
    setResending(true);
    try {
      await resendSignUpCode({ username: email });
      setNotice("A new verification code is on its way.");
    } catch (err) {
      console.error("resendSignUpCode failed", err);
      setError(friendlyConfirmError(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Verify email"
      title="Check your inbox"
      subtitle={
        <>
          We sent a 6-digit code to <strong>{email}</strong>. Enter it below to
          activate your account.
        </>
      }
      footer={
        <>
          Wrong address? <Link to="/register">Start over →</Link>
        </>
      }
    >
      <form className={form.body} onSubmit={onSubmit} noValidate>
        <div className={form.field}>
          <span className={form.label}>Verification code</span>
          <div className={form.codeRow} onPaste={onPaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => (inputsRef.current[i] = el)}
                className={`${form.input} ${form.codeBox}`}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={1}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                aria-label={`Digit ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {notice && <div className={form.notice}>{notice}</div>}
        {error && <div className={form.error}>{error}</div>}

        <button
          type="submit"
          className={form.submit}
          disabled={submitting || !ready}
        >
          {submitting ? "Verifying…" : "Verify and continue"}
        </button>

        <div className={form.linkRow}>
          <span>Didn&apos;t receive a code?</span>
          <button
            type="button"
            className={form.linkAction}
            onClick={onResend}
            disabled={resending}
          >
            {resending ? "Sending…" : "Resend code"}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
