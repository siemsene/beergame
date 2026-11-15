import React, { useState } from "react";
import { User, sendEmailVerification, signOut } from "firebase/auth";
import { auth } from "../firebase";
import { submitInstructorApplication } from "../api";
import { describeFirebaseError } from "../utils/firebaseErrors";

export interface ApplicationDraft {
  name: string;
  institution: string;
  country: string;
}

interface CompleteApplicationProps {
  user: User;
  draft: ApplicationDraft | null;
  initialError: string | null;
}

/**
 * Shown when a user is signed in but has no instructor profile — e.g. account
 * creation succeeded but submitting the application failed, or an admin
 * created the login manually. Lets them (re)submit without a new account.
 */
const CompleteApplication: React.FC<CompleteApplicationProps> = ({ user, draft, initialError }) => {
  const [name, setName] = useState(draft?.name ?? user.displayName ?? "");
  const [institution, setInstitution] = useState(draft?.institution ?? "");
  const [country, setCountry] = useState(draft?.country ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await submitInstructorApplication({
        name: name.trim(),
        institution: institution.trim(),
        country: country.trim(),
      });
      if (!user.emailVerified) {
        try {
          await sendEmailVerification(user);
        } catch (verifyErr) {
          console.error("sendEmailVerification failed", verifyErr);
        }
      }
      // The profile snapshot in App takes over from here.
    } catch (err) {
      console.error("submitInstructorApplication failed", err);
      setError(describeFirebaseError(err, "Unable to submit your application."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel dashboard-stack">
      <div className="section-header">
        <h2>Complete your instructor application</h2>
      </div>
      <p>
        You are signed in as <strong>{user.email}</strong>, but no instructor application has been
        submitted for this account yet. Fill in your details below to submit it.
      </p>
      <form onSubmit={onSubmit} className="auth-form">
        <div className="form-grid auth-form-grid">
          <div className="field">
            <label htmlFor="complete-app-name">Full name</label>
            <input
              id="complete-app-name"
              className="input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="complete-app-institution">Institution</label>
            <input
              id="complete-app-institution"
              className="input"
              type="text"
              value={institution}
              onChange={(e) => setInstitution(e.target.value)}
              autoComplete="organization"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="complete-app-country">Country</label>
            <input
              id="complete-app-country"
              className="input"
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              autoComplete="country-name"
              required
            />
          </div>
        </div>
        <div className="actions-row">
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? "Submitting..." : "Submit application"}
          </button>
          <button
            type="button"
            className="btn-subtle"
            disabled={loading}
            onClick={() => signOut(auth)}
          >
            Sign out
          </button>
        </div>
      </form>
      <div aria-live="polite">
        {error && <div className="alert alert-error">{error}</div>}
      </div>
    </section>
  );
};

export default CompleteApplication;
