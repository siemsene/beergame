import React, { useState } from "react";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "../firebase";
import { submitInstructorApplication } from "../api";
import { describeFirebaseError } from "../utils/firebaseErrors";
import type { ApplicationDraft } from "./CompleteApplication";

type AuthMode = "login" | "register" | "reset";

interface AuthPortalProps {
  initialMode?: AuthMode;
  /** Called before the account is created; the portal unmounts once Auth signs the user in. */
  onRegistrationStart?: (draft: ApplicationDraft) => void;
  /** Called when registration ends. `error` is set only if the account exists but the application failed. */
  onRegistrationFinished?: (error: string | null) => void;
}

const AuthPortal: React.FC<AuthPortalProps> = ({
  initialMode = "login",
  onRegistrationStart,
  onRegistrationFinished,
}) => {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState("");
  const [country, setCountry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const resetFeedback = () => {
    setError(null);
    setMessage(null);
  };

  React.useEffect(() => {
    setMode(initialMode);
    resetFeedback();
  }, [initialMode]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    resetFeedback();
  };

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setMessage("Signed in.");
    } catch (err) {
      console.error("signIn failed", err);
      setError(describeFirebaseError(err, "Unable to sign in. Check your email and password."));
    } finally {
      setLoading(false);
    }
  };

  const onRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    setLoading(true);
    const draft: ApplicationDraft = {
      name: name.trim(),
      institution: institution.trim(),
      country: country.trim(),
    };
    let accountCreated = false;
    onRegistrationStart?.(draft);
    try {
      const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      accountCreated = true;
      await submitInstructorApplication(draft);
      try {
        await sendEmailVerification(credential.user);
      } catch (verifyErr) {
        console.error("sendEmailVerification failed", verifyErr);
      }
      onRegistrationFinished?.(null);
      setMessage(
        "Application submitted. We've sent a verification link to your email — please verify it before your application can be reviewed."
      );
    } catch (err) {
      console.error("registration failed", err);
      const msg = describeFirebaseError(
        err,
        accountCreated
          ? "Your account was created, but submitting the application failed. Please try submitting it again."
          : "Unable to complete registration."
      );
      onRegistrationFinished?.(accountCreated ? msg : null);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const onReset = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setMessage("Password reset email sent.");
    } catch (err) {
      console.error("password reset failed", err);
      setError(describeFirebaseError(err, "Unable to send reset email."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel auth-portal">
      <div className="auth-layout">
        <aside className="auth-intro">
          <h2>Instructor / Admin Access</h2>
          <p>
            Use this portal to sign in, submit a new instructor application, or recover access.
          </p>
          <ul className="auth-list">
            <li>Admin accounts are granted through approved instructor profiles.</li>
            <li>New instructors can register and immediately submit an application.</li>
            <li>Password reset sends a recovery email to your registered address.</li>
          </ul>
        </aside>

        <div className="auth-form-panel">
          <div className="tab-row" role="tablist" aria-label="Access modes">
            {mode === "login" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => switchMode("login")}
              >
                Sign in
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => switchMode("login")}
              >
                Sign in
              </button>
            )}
            {mode === "register" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => switchMode("register")}
              >
                Register
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => switchMode("register")}
              >
                Register
              </button>
            )}
            {mode === "reset" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => switchMode("reset")}
              >
                Reset password
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => switchMode("reset")}
              >
                Reset password
              </button>
            )}
          </div>

          {mode === "login" && (
            <form onSubmit={onLogin} className="auth-form">
              <div className="field">
                <label htmlFor="auth-login-email">Email</label>
                <input
                  id="auth-login-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="auth-login-password">Password</label>
                <input
                  id="auth-login-password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <p className="field-help">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => switchMode("reset")}
                  >
                    Forgot password?
                  </button>
                </p>
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}

          {mode === "register" && (
            <form onSubmit={onRegister} className="auth-form">
              <div className="form-grid auth-form-grid">
                <div className="field">
                  <label htmlFor="auth-register-name">Full name</label>
                  <input
                    id="auth-register-name"
                    className="input"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="auth-register-institution">Institution</label>
                  <input
                    id="auth-register-institution"
                    className="input"
                    type="text"
                    value={institution}
                    onChange={(e) => setInstitution(e.target.value)}
                    autoComplete="organization"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="auth-register-country">Country</label>
                  <input
                    id="auth-register-country"
                    className="input"
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    autoComplete="country-name"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="auth-register-email">Email</label>
                  <input
                    id="auth-register-email"
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="auth-register-password">Password</label>
                <input
                  id="auth-register-password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                <p className="field-help">Minimum 8 characters.</p>
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? "Submitting..." : "Register as instructor"}
              </button>
            </form>
          )}

          {mode === "reset" && (
            <form onSubmit={onReset} className="auth-form">
              <div className="field">
                <label htmlFor="auth-reset-email">Email</label>
                <input
                  id="auth-reset-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
                <p className="field-help">
                  We will send a password reset link to this address.
                </p>
              </div>
              <button className="btn-primary" type="submit" disabled={loading}>
                {loading ? "Sending..." : "Send reset email"}
              </button>
            </form>
          )}

          <div aria-live="polite">
            {error && <div className="alert alert-error">{error}</div>}
            {message && <div className="alert alert-success">{message}</div>}
          </div>
        </div>
      </div>
    </section>
  );
};

export default AuthPortal;
