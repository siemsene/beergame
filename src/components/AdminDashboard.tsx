import React, { useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase";
import { adminDeleteInstructor, adminReviewInstructor, adminRevokeInstructor } from "../api";
import { InstructorProfile, InstructorStatus } from "../types/auth";
import { describeFirebaseError } from "../utils/firebaseErrors";

const DIRECTORY_LIMIT = 500;

interface InstructorRow extends InstructorProfile {
  uid: string;
}

type DirectoryFilter = "all" | InstructorStatus;
type DirectorySortKey = "sessions" | "players";
type SortDirection = "asc" | "desc";
type AlertTone = "success" | "error";

const AdminDashboard: React.FC = () => {
  const [rows, setRows] = React.useState<InstructorRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [alert, setAlert] = React.useState<{ tone: AlertTone; message: string } | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DirectoryFilter>("all");
  const [sortKey, setSortKey] = useState<DirectorySortKey>("sessions");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  React.useEffect(() => {
    const q = query(collection(db, "instructors"), orderBy("createdAt", "desc"), limit(DIRECTORY_LIMIT));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next = snap.docs.map((docSnap) => {
          const data = docSnap.data() as InstructorProfile;
          return {
            uid: docSnap.id,
            ...data,
          };
        });
        setRows(next);
        setLoading(false);
      },
      (err) => {
        console.error("instructor list snapshot failed", err);
        setAlert({ tone: "error", message: describeFirebaseError(err, "Failed to load instructors.") });
        setLoading(false);
      }
    );

    return unsub;
  }, []);

  const pending = useMemo(() => rows.filter((r) => r.status === "pending"), [rows]);
  const unverifiedPendingCount = useMemo(
    () => rows.filter((r) => r.status === "pending" && r.emailVerified === false).length,
    [rows]
  );
  const approvedCount = useMemo(() => rows.filter((r) => r.status === "approved").length, [rows]);
  const rejectedRevokedCount = useMemo(
    () => rows.filter((r) => r.status === "rejected" || r.status === "revoked").length,
    [rows]
  );
  const pendingCount = pending.length - unverifiedPendingCount;

  const onReview = async (uid: string, decision: "approve" | "reject") => {
    setBusyUid(uid);
    setAlert(null);
    try {
      const result = await adminReviewInstructor({ instructorUid: uid, decision });
      const verb = decision === "approve" ? "approved" : "rejected";
      setAlert({
        tone: "success",
        message:
          result.emailSent === false
            ? `Application ${verb}, but the notification email could not be sent. Please let the instructor know directly.`
            : `Application ${verb} successfully.`,
      });
    } catch (err) {
      console.error("adminReviewInstructor failed", err);
      setAlert({
        tone: "error",
        message: describeFirebaseError(err, "Unable to update application status."),
      });
    } finally {
      setBusyUid(null);
    }
  };

  const onRevoke = async (uid: string) => {
    if (
      !window.confirm(
        "Revoke this instructor's access now? They will no longer be able to host sessions."
      )
    ) {
      return;
    }

    setBusyUid(uid);
    setAlert(null);
    try {
      const result = await adminRevokeInstructor({ instructorUid: uid });
      setAlert({
        tone: "success",
        message:
          result.emailSent === false
            ? "Instructor access revoked, but the notification email could not be sent."
            : "Instructor access revoked.",
      });
    } catch (err) {
      console.error("adminRevokeInstructor failed", err);
      setAlert({ tone: "error", message: describeFirebaseError(err, "Unable to revoke instructor.") });
    } finally {
      setBusyUid(null);
    }
  };

  const onDelete = async (uid: string) => {
    if (
      !window.confirm(
        "Permanently delete this instructor? This removes the profile and the sign-in account."
      )
    ) {
      return;
    }

    setBusyUid(uid);
    setAlert(null);
    try {
      await adminDeleteInstructor({ instructorUid: uid });
      setAlert({ tone: "success", message: "Instructor deleted." });
    } catch (err) {
      console.error("adminDeleteInstructor failed", err);
      setAlert({ tone: "error", message: describeFirebaseError(err, "Unable to delete instructor.") });
    } finally {
      setBusyUid(null);
    }
  };

  const filteredRows = useMemo(() => {
    const text = search.trim().toLowerCase();
    return rows.filter((row) => {
      const statusOk = statusFilter === "all" || row.status === statusFilter;
      if (!statusOk) {
        return false;
      }
      if (!text) {
        return true;
      }
      return [row.name, row.email, row.institution]
        .join(" ")
        .toLowerCase()
        .includes(text);
    });
  }, [rows, search, statusFilter]);

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows].sort((a, b) => {
      const aValue = sortKey === "sessions" ? a.sessionsCreatedCount ?? 0 : a.playersJoinedCount ?? 0;
      const bValue = sortKey === "sessions" ? b.sessionsCreatedCount ?? 0 : b.playersJoinedCount ?? 0;
      if (aValue === bValue) {
        return a.name.localeCompare(b.name);
      }
      return sortDirection === "asc" ? aValue - bValue : bValue - aValue;
    });
    return sorted;
  }, [filteredRows, sortDirection, sortKey]);

  if (loading) {
    return <div className="panel">Loading admin dashboard...</div>;
  }

  return (
    <div className="dashboard-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>Admin Dashboard</h2>
            <p>Review instructor applications and monitor usage in one place.</p>
          </div>
        </div>
        {rows.length >= DIRECTORY_LIMIT && (
          <div className="alert alert-error">
            Showing the {DIRECTORY_LIMIT} most recent profiles only; counts below may be incomplete.
          </div>
        )}
        <div className="metric-grid">
          <article className="metric-card">
            <strong>{pendingCount}</strong>
            <span className="metric-label">Pending applications</span>
          </article>
          <article className="metric-card">
            <strong>{unverifiedPendingCount}</strong>
            <span className="metric-label">Awaiting email verification</span>
          </article>
          <article className="metric-card">
            <strong>{approvedCount}</strong>
            <span className="metric-label">Approved instructors</span>
          </article>
          <article className="metric-card">
            <strong>{rejectedRevokedCount}</strong>
            <span className="metric-label">Rejected or revoked</span>
          </article>
          <article className="metric-card">
            <strong>{rows.length}</strong>
            <span className="metric-label">Total instructor profiles</span>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h3>Pending Reviews</h3>
            <p>Applications waiting for an admin decision.</p>
          </div>
          <span className="chip chip-pending">{pending.length} pending</span>
        </div>

        {pending.length === 0 ? (
          <div className="empty-state">No pending applications right now.</div>
        ) : (
          <div className="card-grid">
            {pending.map((row) => (
              <article key={row.uid} className="item-card">
                <h4>{row.name}</h4>
                <p className="item-card-meta">{row.email}</p>
                {row.emailVerified === false && (
                  <p className="item-card-meta">
                    <span className="chip chip-pending">email not verified</span>{" "}
                    Approving re-checks verification and only succeeds once the applicant has
                    clicked their verification link.
                  </p>
                )}
                <p className="item-card-meta">
                  {row.institution} - {row.country}
                </p>
                <p className="item-card-meta">
                  Submitted: {formatUnknownDate(row.createdAt) ?? "Unknown"}
                </p>
                <div className="actions-row">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busyUid === row.uid}
                    onClick={() => onReview(row.uid, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busyUid === row.uid}
                    onClick={() => onReview(row.uid, "reject")}
                  >
                    Reject
                  </button>
                </div>
                {busyUid === row.uid && (
                  <p className="item-card-meta spacer-top-sm">
                    Updating status...
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h3>Instructor Directory</h3>
            <p>Search by profile details and sort by usage metrics.</p>
          </div>
        </div>

        <div className="toolbar">
          <div className="toolbar-field">
            <label htmlFor="admin-search">Search</label>
            <input
              id="admin-search"
              className="input"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, institution"
            />
          </div>
          <div className="toolbar-field">
            <label htmlFor="admin-status-filter">Status</label>
            <select
              id="admin-status-filter"
              className="select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DirectoryFilter)}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="revoked">Revoked</option>
            </select>
          </div>
          <div className="toolbar-field">
            <label htmlFor="admin-sort-key">Sort by</label>
            <select
              id="admin-sort-key"
              className="select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as DirectorySortKey)}
            >
              <option value="sessions">Sessions created</option>
              <option value="players">Players joined</option>
            </select>
          </div>
          <div className="toolbar-field">
            <label htmlFor="admin-sort-direction">Direction</label>
            <select
              id="admin-sort-direction"
              className="select"
              value={sortDirection}
              onChange={(e) => setSortDirection(e.target.value as SortDirection)}
            >
              <option value="desc">High to low</option>
              <option value="asc">Low to high</option>
            </select>
          </div>
        </div>

        {sortedRows.length === 0 ? (
          <div className="empty-state spacer-top-md">
            No instructors match the current filters.
          </div>
        ) : (
          <div className="table-wrap spacer-top-md">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Instructor</th>
                  <th>Status</th>
                  <th className="num">Sessions</th>
                  <th className="num">Players</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const sessions = row.sessionsCreatedCount ?? 0;
                  const players = row.playersJoinedCount ?? 0;
                  return (
                    <tr key={row.uid}>
                      <td>
                        <strong>{row.name}</strong>
                        <div className="text-muted">{row.email}</div>
                        <div className="text-muted">{row.institution}</div>
                      </td>
                      <td>
                        <span className={`chip chip-${row.status}`}>{row.status}</span>
                      </td>
                      <td className="num">{sessions}</td>
                      <td className="num">{players}</td>
                      <td>
                        {row.role !== "admin" &&
                          (row.status === "pending" ||
                            row.status === "rejected" ||
                            row.status === "revoked") && (
                            <button
                              type="button"
                              className="btn-primary"
                              disabled={busyUid === row.uid}
                              onClick={() => onReview(row.uid, "approve")}
                            >
                              {row.status === "revoked" ? "Restore" : "Approve"}
                            </button>
                          )}{" "}
                        {row.role !== "admin" && row.status === "pending" && (
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busyUid === row.uid}
                            onClick={() => onReview(row.uid, "reject")}
                          >
                            Reject
                          </button>
                        )}
                        {row.role !== "admin" && row.status === "approved" && (
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busyUid === row.uid}
                            onClick={() => onRevoke(row.uid)}
                          >
                            Revoke
                          </button>
                        )}
                        {row.role !== "admin" &&
                          (row.status === "rejected" || row.status === "revoked") && (
                          <button
                            type="button"
                            className="btn-danger"
                            disabled={busyUid === row.uid}
                            onClick={() => onDelete(row.uid)}
                          >
                            Delete
                          </button>
                        )}
                        {row.role === "admin" && <span className="text-muted">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div aria-live="polite">
        {alert && (
          <div className={`alert ${alert.tone === "error" ? "alert-error" : "alert-success"}`}>
            {alert.message}
          </div>
        )}
      </div>
    </div>
  );
};

function formatUnknownDate(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toLocaleString();
  }

  if (typeof value === "object") {
    const v = value as { toDate?: () => Date; toMillis?: () => number; seconds?: number };
    if (typeof v.toDate === "function") {
      return v.toDate().toLocaleString();
    }
    if (typeof v.toMillis === "function") {
      return new Date(v.toMillis()).toLocaleString();
    }
    if (typeof v.seconds === "number") {
      return new Date(v.seconds * 1000).toLocaleString();
    }
  }

  return null;
}

export default AdminDashboard;
