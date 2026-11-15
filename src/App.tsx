import React, { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged, sendEmailVerification, signOut } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import HostLobby from "./components/HostLobby";
import PlayerJoin from "./components/PlayerJoin";
import PlayerView from "./components/PlayerView";
import AuthPortal from "./components/AuthPortal";
import AdminDashboard from "./components/AdminDashboard";
import CompleteApplication, { ApplicationDraft } from "./components/CompleteApplication";
import titleBg from "./beergametitle.webp";
import { auth, db } from "./firebase";
import { ensureAdminProfile, syncEmailVerified } from "./api";
import { InstructorProfile } from "./types/auth";
import { describeFirebaseError } from "./utils/firebaseErrors";

if (typeof document !== "undefined") {
  document.documentElement.style.setProperty(
    "--landing-hero-image",
    `url(${titleBg})`
  );
}

type View = "home" | "instructor" | "join" | "player";
type DashboardTab = "instructor" | "admin";
type AuthLandingMode = "login" | "register" | "reset";

const App: React.FC = () => {
  const [view, setView] = useState<View>("home");
  const [authLandingMode, setAuthLandingMode] = useState<AuthLandingMode>("login");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("instructor");
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<InstructorProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Registration spans an Auth sign-in (which unmounts AuthPortal) and a
  // callable; App owns this state so the UI stays coherent across both steps.
  const [registrationPending, setRegistrationPending] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationDraft, setRegistrationDraft] = useState<ApplicationDraft | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      setProfileError(null);
      if (!nextUser || nextUser.isAnonymous) {
        setProfile(null);
        setProfileLoading(false);
        setRegistrationError(null);
      } else {
        setProfileLoading(true);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user || user.isAnonymous) {
      return;
    }

    let cancelled = false;

    // Only bootstraps the admin's own profile; failures must not block other users.
    ensureAdminProfile().catch((err) => {
      console.error("ensureAdminProfile failed", err);
    });

    const ref = doc(db, "instructors", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (cancelled) {
          return;
        }
        if (!snap.exists()) {
          setProfile(null);
          setProfileLoading(false);
          return;
        }
        setProfile(snap.data() as InstructorProfile);
        setProfileLoading(false);
      },
      (err) => {
        console.error("instructor profile snapshot failed", err);
        if (!cancelled) {
          setProfile(null);
          setProfileLoading(false);
          setProfileError(
            "Unable to load your instructor profile. Please reload the page or sign out and back in."
          );
        }
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [user]);

  const needsEmailVerification = profile?.emailVerified === false;

  useEffect(() => {
    if (!user || !needsEmailVerification || !user.emailVerified) {
      return;
    }
    // Force a token refresh so the server sees the up-to-date verification state.
    user
      .getIdToken(true)
      .then(() => syncEmailVerified())
      .catch((err) => {
        console.error("syncEmailVerified failed", err);
      });
  }, [user, needsEmailVerification]);

  const onCheckVerified = async () => {
    if (!auth.currentUser) {
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    setVerifyMessage(null);
    try {
      await auth.currentUser.reload();
      // reload() does not refresh the ID token; the server reads email_verified
      // from the Auth record, but refresh anyway so client claims match.
      await auth.currentUser.getIdToken(true);
      const result = await syncEmailVerified();
      if (result.emailVerified) {
        setVerifyMessage("Email verified. Your application is now visible to admins for review.");
      } else {
        setVerifyError("Email is not verified yet. Please click the link in the verification email.");
      }
    } catch (err) {
      console.error("verification check failed", err);
      setVerifyError(
        describeFirebaseError(err, "Unable to refresh verification status. Try again in a moment.")
      );
    } finally {
      setVerifyBusy(false);
    }
  };

  const onResendVerification = async () => {
    if (!auth.currentUser) {
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    setVerifyMessage(null);
    try {
      await sendEmailVerification(auth.currentUser);
      setVerifyMessage("Verification email resent. Check your inbox (and spam folder).");
    } catch (err) {
      console.error("resend verification failed", err);
      setVerifyError(
        describeFirebaseError(err, "Unable to resend verification email. Try again in a moment.")
      );
    } finally {
      setVerifyBusy(false);
    }
  };

  const isApproved = profile?.status === "approved";
  const isAdmin = isApproved && profile?.role === "admin";
  const activeDashboardTab: DashboardTab = isAdmin ? dashboardTab : "instructor";

  const authSection = useMemo(() => {
    if (authLoading || profileLoading) {
      return <div className="panel">Loading account...</div>;
    }

    if (profileError) {
      return (
        <div className="panel">
          <div className="alert alert-error">{profileError}</div>
        </div>
      );
    }

    if (!user || user.isAnonymous) {
      return (
        <AuthPortal
          initialMode={authLandingMode}
          onRegistrationStart={(draft) => {
            setRegistrationDraft(draft);
            setRegistrationError(null);
            setRegistrationPending(true);
          }}
          onRegistrationFinished={(error) => {
            setRegistrationPending(false);
            setRegistrationError(error);
          }}
        />
      );
    }

    if (!profile) {
      if (registrationPending) {
        return <div className="panel">Submitting your application...</div>;
      }
      return (
        <CompleteApplication
          key={user.uid}
          user={user}
          draft={registrationDraft}
          initialError={registrationError}
        />
      );
    }

    if (needsEmailVerification && !user.emailVerified) {
      return (
        <div className="panel dashboard-stack">
          <div className="section-header">
            <h2>Verify your email</h2>
            <span className="chip chip-pending">unverified</span>
          </div>
          <p>
            We sent a verification link to <strong>{profile.email}</strong>. Click that link to
            confirm your email address. Your application will not be reviewed until your email is
            verified.
          </p>
          <div className="actions-row">
            <button
              type="button"
              className="btn-primary"
              disabled={verifyBusy}
              onClick={onCheckVerified}
            >
              {verifyBusy ? "Checking..." : "I've verified my email"}
            </button>
            <button
              type="button"
              className="btn-subtle"
              disabled={verifyBusy}
              onClick={onResendVerification}
            >
              Resend verification email
            </button>
            <button
              type="button"
              className="btn-subtle"
              disabled={verifyBusy}
              onClick={() => signOut(auth)}
            >
              Sign out
            </button>
          </div>
          <div aria-live="polite">
            {verifyError && <div className="alert alert-error">{verifyError}</div>}
            {verifyMessage && <div className="alert alert-success">{verifyMessage}</div>}
          </div>
        </div>
      );
    }

    if (!isApproved) {
      return (
        <div className="panel dashboard-stack">
          <div className="section-header">
            <h2>Application status</h2>
            <span className={`chip chip-${profile.status}`}>{profile.status}</span>
          </div>
          {profile.status === "pending" && (
            <p>
              Your instructor request is pending admin review. You can stay signed in and refresh
              this page later.
            </p>
          )}
          {profile.status === "rejected" && (
            <p>Your instructor request was rejected. Contact the admin for details.</p>
          )}
          {profile.status === "revoked" && (
            <p>Your instructor access has been revoked by the admin.</p>
          )}
          <div>
            <button className="btn-subtle" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="dashboard-stack">
        <div className="panel identity-row">
          <div>
            Signed in as <strong>{profile.email}</strong>{" "}
            <span className="chip chip-neutral">{profile.role}</span>
          </div>
          <button className="btn-subtle" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>

        {isAdmin && (
          <div className="tab-row" role="tablist" aria-label="Dashboard sections">
            {activeDashboardTab === "instructor" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => setDashboardTab("instructor")}
              >
                Instructor Console
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => setDashboardTab("instructor")}
              >
                Instructor Console
              </button>
            )}
            {activeDashboardTab === "admin" ? (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="true"
                onClick={() => setDashboardTab("admin")}
              >
                Admin Review
              </button>
            ) : (
              <button
                type="button"
                className="tab-btn"
                role="tab"
                aria-selected="false"
                onClick={() => setDashboardTab("admin")}
              >
                Admin Review
              </button>
            )}
          </div>
        )}

        {activeDashboardTab === "instructor" && (
          <HostLobby
            userUid={user.uid}
            instructorEmail={profile.email}
            isAdmin={Boolean(isAdmin)}
          />
        )}

        {isAdmin && activeDashboardTab === "admin" && <AdminDashboard />}
      </div>
    );
  }, [
    activeDashboardTab,
    authLoading,
    authLandingMode,
    isAdmin,
    isApproved,
    needsEmailVerification,
    profile,
    profileError,
    profileLoading,
    registrationDraft,
    registrationError,
    registrationPending,
    user,
    verifyBusy,
    verifyError,
    verifyMessage,
  ]);

  return (
    <div className="app-shell">
      <div className="app-frame">
        {view === "home" && (
          <div className="hero-panel landing-hero">
            <div className="landing-topbar">
              <button
                className="btn-subtle landing-top-request"
                onClick={() => {
                  setAuthLandingMode("register");
                  setView("instructor");
                }}
              >
                Request Instructor Access
              </button>
            </div>

            <div className="landing-header">
              <h1 className="landing-title">The Beer Game</h1>
              <p className="text-muted landing-subtitle">
                Run multi-week supply chain rounds with live teams. Students join with a session
                code. Instructors create and control game sessions.
              </p>
            </div>

            <div className="landing-role-grid">
              <article className="landing-role-card">
                <h3>Students / Players</h3>
                <p>Have your session code ready, then join your team and role when prompted.</p>
                <div className="landing-role-action">
                  <button className="btn-primary landing-btn" onClick={() => setView("join")}>
                    Join Game
                  </button>
                </div>
              </article>
              <article className="landing-role-card">
                <h3>Instructors / Admin</h3>
                <p>Create sessions, assign teams, monitor rounds, and review instructor access.</p>
                <div className="landing-role-action">
                  <button
                    className="btn-primary landing-btn"
                    onClick={() => {
                      setAuthLandingMode("login");
                      setView("instructor");
                    }}
                  >
                    Instructor / Admin
                  </button>
                </div>
              </article>
            </div>
          </div>
        )}

        {view === "instructor" && (
          <div className="dashboard-stack">
            <div>
              <button className="btn-subtle" onClick={() => setView("home")}>
                Back
              </button>
            </div>
            {authSection}
          </div>
        )}

        {view === "join" && (
          <div className="dashboard-stack">
            <div>
              <button className="btn-subtle" onClick={() => setView("home")}>
                Back
              </button>
            </div>
            <PlayerJoin
              onJoined={() => {
                setView("player");
              }}
            />
          </div>
        )}

        {view === "player" && <PlayerView />}
      </div>
    </div>
  );
};

export default App;
