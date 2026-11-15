import * as crypto from "crypto";
import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { CloudBillingClient } from "@google-cloud/billing";

admin.initializeApp();

const db = admin.firestore();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const SMTP2GO_API_KEY = defineSecret("SMTP2GO_API_KEY");
const MAIL_FROM = defineSecret("MAIL_FROM");
const ADMIN_EMAIL = defineSecret("ADMIN_EMAIL");
const APP_BASE_URL = defineSecret("APP_BASE_URL");

type UserRole = "admin" | "instructor";
type InstructorStatus = "pending" | "approved" | "rejected" | "revoked";
type GameStatus = "lobby" | "in_progress" | "ended";
type Role = "retailer" | "wholesaler" | "distributor" | "factory";

interface InstructorDoc {
  email: string;
  name: string;
  institution: string;
  country: string;
  role: UserRole;
  status: InstructorStatus;
  emailVerified?: boolean;
  reviewedBy: string | null;
  reviewedAt: admin.firestore.Timestamp | null;
  createdAt: admin.firestore.Timestamp;
  sessionsCreatedCount: number;
  playersJoinedCount: number;
}

interface GameConfigInput {
  nWeeks?: number;
  inventoryCost?: number;
  backlogCost?: number;
  customerDemand?: number[];
  extraOrderDelay?: boolean;
  displayUpstreamBackorders?: boolean;
}

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").replaceAll("/", "_");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newSessionToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function isTimestampExpired(ts: unknown): boolean {
  if (!(ts instanceof admin.firestore.Timestamp)) {
    return false;
  }
  return ts.toMillis() <= Date.now();
}

function parseGameCode(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "gameCode is required.");
  }
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z2-9]{4,8}$/.test(code)) {
    throw new HttpsError("invalid-argument", "Invalid game code format.");
  }
  return code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeConfig(input?: GameConfigInput) {
  const nWeeks = Math.max(1, Math.round(Number(input?.nWeeks ?? 40)));
  const inventoryCost = Math.max(0, Number(input?.inventoryCost ?? 0.5));
  const backlogCost = Math.max(0, Number(input?.backlogCost ?? 1.0));
  const customerDemand = Array.from({ length: nWeeks }, (_, i) => (i < 4 ? 4 : 8));

  return {
    nWeeks,
    inventoryCost,
    backlogCost,
    customerDemand,
    extraOrderDelay: Boolean(input?.extraOrderDelay),
    displayUpstreamBackorders: Boolean(input?.displayUpstreamBackorders),
  };
}

function requireAuthUid(request: { auth?: { uid?: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  return uid;
}

async function getInstructorDoc(uid: string) {
  return db.collection("instructors").doc(uid).get();
}

async function enforceRateLimit(
  uid: string,
  key: string,
  maxCalls: number,
  windowSec: number
): Promise<void> {
  const ref = db.collection("rateLimits").doc(`${uid}_${key}`);
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({ count: 1, windowStart: now, updatedAt: now });
    return;
  }

  const data = snap.data() as { count?: number; windowStart?: number };
  const windowStart = typeof data.windowStart === "number" ? data.windowStart : 0;
  const count = typeof data.count === "number" ? data.count : 0;

  if (now - windowStart >= windowMs) {
    await ref.set({ count: 1, windowStart: now, updatedAt: now });
    return;
  }

  if (count >= maxCalls) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many requests. Please slow down and try again shortly."
    );
  }

  await ref.update({
    count: admin.firestore.FieldValue.increment(1),
    updatedAt: now,
  });
}

async function requireAdmin(uid: string): Promise<admin.firestore.DocumentSnapshot> {
  const snap = await getInstructorDoc(uid);
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "Admin profile not found.");
  }
  const data = snap.data() as InstructorDoc;
  if (data.role !== "admin" || data.status !== "approved") {
    throw new HttpsError("permission-denied", "Admin privileges required.");
  }
  return snap;
}

async function requireApprovedInstructor(uid: string): Promise<admin.firestore.DocumentSnapshot> {
  const snap = await getInstructorDoc(uid);
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "Instructor profile not found.");
  }
  const data = snap.data() as InstructorDoc;
  if (data.status !== "approved" || (data.role !== "admin" && data.role !== "instructor")) {
    throw new HttpsError("permission-denied", "Approved instructor access required.");
  }
  return snap;
}

const EMAIL_DAILY_CAP = 500;

function todayKeyUtc(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

async function reserveEmailQuota(): Promise<boolean> {
  const dayKey = todayKeyUtc();
  const ref = db.collection("emailQuota").doc(dayKey);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number((snap.data() as { count?: number }).count ?? 0) : 0;
    if (current >= EMAIL_DAILY_CAP) {
      return false;
    }
    tx.set(
      ref,
      {
        count: current + 1,
        dayKey,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });
}

async function sendEmail(params: {
  to: string[];
  subject: string;
  text: string;
  html: string;
}) {
  const apiKey = SMTP2GO_API_KEY.value();
  const sender = MAIL_FROM.value();
  if (!apiKey || !sender) {
    logger.warn("SMTP2GO secrets are not configured; skipping email", {
      to: params.to,
      subject: params.subject,
    });
    return;
  }

  const allowed = await reserveEmailQuota();
  if (!allowed) {
    logger.warn("Daily email quota exceeded; dropping send.", {
      cap: EMAIL_DAILY_CAP,
      to: params.to,
      subject: params.subject,
    });
    return;
  }

  const resp = await fetch("https://api.smtp2go.com/v3/email/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      to: params.to,
      sender,
      subject: params.subject,
      text_body: params.text,
      html_body: params.html,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    logger.error("SMTP2GO delivery failed", { status: resp.status, body });
    throw new HttpsError("internal", "Failed to send email notification.");
  }
}

/** Sends an email but never throws: notification failures must not fail the caller's action. */
async function trySendEmail(params: Parameters<typeof sendEmail>[0]): Promise<boolean> {
  try {
    await sendEmail(params);
    return true;
  } catch (err) {
    logger.error("Email send failed", { to: params.to, subject: params.subject, err });
    return false;
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notifyAdminOfApplication(profile: {
  name: string;
  email: string;
  institution: string;
  country: string;
}) {
  const appUrl = APP_BASE_URL.value();
  const emailText = [
    "New Beer Game instructor application received (email verified).",
    `Name: ${profile.name}`,
    `Email: ${profile.email}`,
    `Institution: ${profile.institution}`,
    `Country: ${profile.country}`,
    "",
    `Review in app: ${appUrl}`,
  ].join("\n");

  await trySendEmail({
    to: [ADMIN_EMAIL.value()],
    subject: "Beer Game: New instructor application",
    text: emailText,
    html: `<p>${escapeHtml(emailText).replace(/\n/g, "<br />")}</p>`,
  });
}

function isAdminEmailUser(user: admin.auth.UserRecord): boolean {
  const adminEmail = ADMIN_EMAIL.value().trim().toLowerCase();
  // Require a verified email so nobody can claim admin by registering the
  // admin address before the owner does.
  return Boolean(adminEmail) && user.email?.toLowerCase() === adminEmail && user.emailVerified;
}

async function setAuthClaims(uid: string, role: UserRole | null, status: InstructorStatus | null) {
  if (!role || !status) {
    await admin.auth().setCustomUserClaims(uid, null);
    return;
  }

  await admin.auth().setCustomUserClaims(uid, {
    role,
    status,
  });
}

async function generateUniqueGameCode(): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 20; i += 1) {
    let code = "";
    for (let j = 0; j < 4; j += 1) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const snap = await db.collection("games").doc(code).get();
    if (!snap.exists) {
      return code;
    }
  }
  throw new HttpsError("resource-exhausted", "Could not allocate a unique game code.");
}

export const ensureAdminProfile = onCall(
  { enforceAppCheck: true, maxInstances: 100, secrets: [ADMIN_EMAIL] },
  async (request) => {
    const uid = requireAuthUid(request);
    const user = await admin.auth().getUser(uid);
    if (!isAdminEmailUser(user)) {
      return { created: false };
    }

    const profileRef = db.collection("instructors").doc(uid);
    const profileSnap = await profileRef.get();
    if (profileSnap.exists) {
      return { created: false };
    }

    await profileRef.set({
      email: user.email,
      name: user.displayName ?? "Admin",
      institution: "",
      country: "",
      role: "admin",
      status: "approved",
      reviewedBy: uid,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      sessionsCreatedCount: 0,
      playersJoinedCount: 0,
    });

    await setAuthClaims(uid, "admin", "approved");
    return { created: true };
  }
);

export const submitInstructorApplication = onCall(
  { enforceAppCheck: true, maxInstances: 100, secrets: [ADMIN_EMAIL, SMTP2GO_API_KEY, MAIL_FROM, APP_BASE_URL] },
  async (request) => {
    const uid = requireAuthUid(request);
    await enforceRateLimit(uid, "submitInstructorApplication", 5, 300);
    const name = typeof request.data?.name === "string" ? request.data.name.trim() : "";
    const institution =
      typeof request.data?.institution === "string" ? request.data.institution.trim() : "";
    const country = typeof request.data?.country === "string" ? request.data.country.trim() : "";

    if (!name || !institution || !country) {
      throw new HttpsError("invalid-argument", "name, institution, and country are required.");
    }

    const user = await admin.auth().getUser(uid);
    if (!user.email) {
      throw new HttpsError("failed-precondition", "User email is required.");
    }

    const profileRef = db.collection("instructors").doc(uid);
    const existingSnap = await profileRef.get();
    const existing = existingSnap.exists ? (existingSnap.data() as InstructorDoc) : null;

    if (existing && (existing.status === "approved" || existing.status === "revoked")) {
      // Never let a re-submission reset an approved/revoked account.
      return { status: existing.status, role: existing.role };
    }

    if (existing && existing.status === "pending") {
      // Allow correcting details on a pending application without resetting it.
      await profileRef.set(
        {
          name,
          institution,
          country,
          emailVerified: existing.emailVerified === true || user.emailVerified,
        },
        { merge: true }
      );
      return { status: existing.status, role: existing.role };
    }

    // New application, or re-application after a rejection.
    const isAdmin = isAdminEmailUser(user);
    const role: UserRole = isAdmin ? "admin" : "instructor";
    const status: InstructorStatus = isAdmin ? "approved" : "pending";
    const emailVerified = isAdmin ? true : Boolean(user.emailVerified);

    await profileRef.set(
      {
        email: user.email,
        name,
        institution,
        country,
        role,
        status,
        emailVerified,
        reviewedBy: isAdmin ? uid : null,
        reviewedAt: isAdmin ? admin.firestore.FieldValue.serverTimestamp() : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sessionsCreatedCount: existing?.sessionsCreatedCount ?? 0,
        playersJoinedCount: existing?.playersJoinedCount ?? 0,
      },
      { merge: true }
    );

    await setAuthClaims(uid, role, status);

    // If the email is already verified (e.g. completing an application after
    // verifying), syncEmailVerified will not send the notification, so send it now.
    if (!isAdmin && emailVerified) {
      await notifyAdminOfApplication({ name, email: user.email, institution, country });
    }

    return { status, role };
  }
);

export const syncEmailVerified = onCall(
  { enforceAppCheck: true, maxInstances: 100, secrets: [ADMIN_EMAIL, SMTP2GO_API_KEY, MAIL_FROM, APP_BASE_URL] },
  async (request) => {
    const uid = requireAuthUid(request);
    // Read the Auth record rather than the ID token: the token's
    // email_verified claim stays stale until the client force-refreshes it.
    const user = await admin.auth().getUser(uid);
    if (!user.emailVerified) {
      return { emailVerified: false };
    }

    const profileRef = db.collection("instructors").doc(uid);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
      return { emailVerified: true };
    }

    const profile = profileSnap.data() as InstructorDoc;
    if (profile.emailVerified === true) {
      return { emailVerified: true };
    }

    await profileRef.set({ emailVerified: true }, { merge: true });

    if (profile.role === "instructor" && profile.status === "pending") {
      await notifyAdminOfApplication(profile);
    }

    return { emailVerified: true };
  }
);

export const adminReviewInstructor = onCall(
  { enforceAppCheck: true, maxInstances: 100, secrets: [SMTP2GO_API_KEY, MAIL_FROM, APP_BASE_URL] },
  async (request) => {
    const reviewerUid = requireAuthUid(request);
    await requireAdmin(reviewerUid);

    const instructorUid =
      typeof request.data?.instructorUid === "string" ? request.data.instructorUid.trim() : "";
    const decision = request.data?.decision === "approve" ? "approve" : request.data?.decision;

    if (!instructorUid || (decision !== "approve" && decision !== "reject")) {
      throw new HttpsError("invalid-argument", "Valid instructorUid and decision are required.");
    }

    const instructorRef = db.collection("instructors").doc(instructorUid);
    const instructorSnap = await instructorRef.get();
    if (!instructorSnap.exists) {
      throw new HttpsError("not-found", "Instructor profile not found.");
    }

    const instructorData = instructorSnap.data() as InstructorDoc;
    if (instructorData.role === "admin") {
      throw new HttpsError("failed-precondition", "Admin account cannot be reviewed.");
    }
    if (decision === "approve" && instructorData.emailVerified !== true) {
      // The profile flag can lag behind Auth (the user verified but never
      // returned to the app), so check the Auth record directly.
      let authVerified = false;
      try {
        authVerified = (await admin.auth().getUser(instructorUid)).emailVerified;
      } catch (err) {
        logger.warn("Could not load auth user during review", { instructorUid, err });
      }
      if (!authVerified) {
        throw new HttpsError(
          "failed-precondition",
          "Cannot approve: this instructor has not verified their email address yet."
        );
      }
      await instructorRef.set({ emailVerified: true }, { merge: true });
    }

    const nextStatus: InstructorStatus = decision === "approve" ? "approved" : "rejected";
    await instructorRef.set(
      {
        role: "instructor",
        status: nextStatus,
        reviewedBy: reviewerUid,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (decision === "approve") {
      await admin.auth().updateUser(instructorUid, { disabled: false });
      await setAuthClaims(instructorUid, "instructor", "approved");
    } else {
      await setAuthClaims(instructorUid, "instructor", "rejected");
    }

    const appUrl = APP_BASE_URL.value();
    const verdict = decision === "approve" ? "approved" : "rejected";
    const emailSent = await trySendEmail({
      to: [instructorData.email],
      subject: `Beer Game instructor application ${verdict}`,
      text:
        verdict === "approved"
          ? `Your instructor access has been approved. You can now sign in at ${appUrl}.`
          : "Your instructor access request was not approved.",
      html:
        verdict === "approved"
          ? `<p>Your instructor access has been approved. You can now sign in at <a href="${appUrl}">${appUrl}</a>.</p>`
          : "<p>Your instructor access request was not approved.</p>",
    });

    return { status: nextStatus, emailSent };
  }
);

export const adminRevokeInstructor = onCall(
  { enforceAppCheck: true, maxInstances: 100, secrets: [SMTP2GO_API_KEY, MAIL_FROM] },
  async (request) => {
    const reviewerUid = requireAuthUid(request);
    await requireAdmin(reviewerUid);

    const instructorUid =
      typeof request.data?.instructorUid === "string" ? request.data.instructorUid.trim() : "";
    if (!instructorUid) {
      throw new HttpsError("invalid-argument", "instructorUid is required.");
    }

    const instructorRef = db.collection("instructors").doc(instructorUid);
    const instructorSnap = await instructorRef.get();
    if (!instructorSnap.exists) {
      throw new HttpsError("not-found", "Instructor profile not found.");
    }

    const instructorData = instructorSnap.data() as InstructorDoc;
    if (instructorData.role === "admin") {
      throw new HttpsError("failed-precondition", "Admin account cannot be revoked.");
    }

    await instructorRef.set(
      {
        status: "revoked",
        reviewedBy: reviewerUid,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await admin.auth().updateUser(instructorUid, { disabled: true });
    await setAuthClaims(instructorUid, "instructor", "revoked");

    const emailSent = await trySendEmail({
      to: [instructorData.email],
      subject: "Beer Game instructor access revoked",
      text: "Your instructor access has been revoked by the administrator.",
      html: "<p>Your instructor access has been revoked by the administrator.</p>",
    });

    return { status: "revoked", emailSent };
  }
);

export const adminDeleteInstructor = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const reviewerUid = requireAuthUid(request);
  await requireAdmin(reviewerUid);

  const instructorUid =
    typeof request.data?.instructorUid === "string" ? request.data.instructorUid.trim() : "";
  if (!instructorUid) {
    throw new HttpsError("invalid-argument", "instructorUid is required.");
  }

  const instructorRef = db.collection("instructors").doc(instructorUid);
  const instructorSnap = await instructorRef.get();
  if (!instructorSnap.exists) {
    throw new HttpsError("not-found", "Instructor profile not found.");
  }

  const instructorData = instructorSnap.data() as InstructorDoc;
  if (instructorData.role === "admin") {
    throw new HttpsError("failed-precondition", "Admin account cannot be deleted.");
  }
  if (instructorData.status !== "rejected" && instructorData.status !== "revoked") {
    throw new HttpsError(
      "failed-precondition",
      "Only rejected or revoked instructors can be deleted."
    );
  }

  await instructorRef.delete();

  try {
    await admin.auth().deleteUser(instructorUid);
  } catch (err) {
    logger.warn("Failed to delete auth user during instructor delete", {
      uid: instructorUid,
      err,
    });
  }

  return { deleted: true };
});

export const createSession = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const uid = requireAuthUid(request);
  const instructorSnap = await requireApprovedInstructor(uid);
  const instructor = instructorSnap.data() as InstructorDoc;

  const config = sanitizeConfig(request.data?.config as GameConfigInput | undefined);
  const notes = typeof request.data?.notes === "string" ? request.data.notes.trim() : "";

  const code = await generateUniqueGameCode();
  const now = admin.firestore.Timestamp.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + THIRTY_DAYS_MS);

  await db.collection("games").doc(code).set({
    status: "lobby",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
    ownerInstructorId: uid,
    ownerInstructorEmail: instructor.email,
    config,
    notes,
    humanJoinCount: 0,
  });

  await instructorSnap.ref.set(
    {
      sessionsCreatedCount: admin.firestore.FieldValue.increment(1),
    },
    { merge: true }
  );

  return { gameCode: code };
});

export const deleteSession = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const uid = requireAuthUid(request);
  const instructorSnap = await requireApprovedInstructor(uid);
  const instructor = instructorSnap.data() as InstructorDoc;

  const gameCode = parseGameCode(request.data?.gameCode);
  const gameRef = db.collection("games").doc(gameCode);
  const gameSnap = await gameRef.get();

  if (!gameSnap.exists) {
    return { deleted: false };
  }

  const gameData = gameSnap.data() as Record<string, unknown>;
  const owner = typeof gameData.ownerInstructorId === "string" ? gameData.ownerInstructorId : null;

  if (instructor.role !== "admin" && owner !== uid) {
    throw new HttpsError("permission-denied", "Cannot delete sessions owned by another instructor.");
  }

  await db.recursiveDelete(gameRef);
  return { deleted: true };
});

export const joinOrResumePlayer = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const callerUid = requireAuthUid(request);
  await enforceRateLimit(callerUid, "joinOrResumePlayer", 10, 60);
  const gameCode = parseGameCode(request.data?.gameCode);
  const rawName = typeof request.data?.name === "string" ? request.data.name : "";
  const name = rawName.trim();
  if (!name) {
    throw new HttpsError("invalid-argument", "name is required.");
  }

  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    throw new HttpsError("invalid-argument", "Invalid player name.");
  }

  const gameRef = db.collection("games").doc(gameCode);
  const playersRef = gameRef.collection("players");
  const nameRef = gameRef.collection("playerNames").doc(normalizedName);

  let payload: Record<string, unknown> | null = null;

  await db.runTransaction(async (tx) => {
    const gameSnap = await tx.get(gameRef);
    if (!gameSnap.exists) {
      throw new HttpsError("not-found", "No game with that ID was found.");
    }

    const gameData = gameSnap.data() as Record<string, unknown>;
    const status = gameData.status as GameStatus;

    if (status === "ended") {
      throw new HttpsError("failed-precondition", "This game has already ended.");
    }

    if (isTimestampExpired(gameData.expiresAt)) {
      throw new HttpsError("failed-precondition", "This game has expired.");
    }

    const nameSnap = await tx.get(nameRef);

    if (nameSnap.exists) {
      if (status === "lobby") {
        throw new HttpsError("already-exists", "NAME_TAKEN");
      }

      const lock = nameSnap.data() as { playerId?: string };
      const playerId = lock.playerId;
      if (!playerId) {
        throw new HttpsError("failed-precondition", "Invalid existing player lock.");
      }

      const playerRef = playersRef.doc(playerId);
      const playerSnap = await tx.get(playerRef);
      if (!playerSnap.exists) {
        throw new HttpsError("failed-precondition", "Existing player could not be resumed.");
      }

      const playerData = playerSnap.data() as Record<string, unknown>;
      const token = newSessionToken();
      tx.update(playerRef, {
        sessionTokenHash: hashToken(token),
        lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      payload = {
        mode: "reconnected",
        playerId,
        role: playerData.role ?? "pending",
        sessionToken: token,
      };
      return;
    }

    const token = newSessionToken();
    const commonPlayerFields = {
      name,
      normalizedName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isRobot: false,
      sessionTokenHash: hashToken(token),
      lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
      removedAt: null,
      removedBy: null,
    };

    if (status === "lobby") {
      const playerRef = playersRef.doc();
      tx.set(playerRef, {
        ...commonPlayerFields,
        teamId: null,
        role: null,
        teamName: null,
      });
      tx.set(nameRef, {
        playerId: playerRef.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        humanJoinCount: admin.firestore.FieldValue.increment(1),
      });

      const ownerInstructorId = gameData.ownerInstructorId;
      if (typeof ownerInstructorId === "string" && ownerInstructorId.length > 0) {
        tx.set(
          db.collection("instructors").doc(ownerInstructorId),
          {
            playersJoinedCount: admin.firestore.FieldValue.increment(1),
          },
          { merge: true }
        );
      }

      payload = {
        mode: "created",
        playerId: playerRef.id,
        role: "pending",
        sessionToken: token,
      };
      return;
    }

    if (status !== "in_progress") {
      throw new HttpsError("failed-precondition", "Session is not joinable.");
    }

    const teamsSnap = await tx.get(gameRef.collection("teams"));
    let selectedTeam: admin.firestore.QueryDocumentSnapshot | null = null;
    let selectedRole: Role | null = null;

    for (const teamDoc of teamsSnap.docs) {
      const teamData = teamDoc.data() as Record<string, unknown>;
      const rawStages = isRecord(teamData.stages) ? teamData.stages : {};
      const stages = rawStages as Partial<Record<Role, Record<string, unknown>>>;
      const roles: Role[] = ["retailer", "wholesaler", "distributor", "factory"];
      for (const role of roles) {
        if (stages[role]?.isRobot === true) {
          selectedTeam = teamDoc;
          selectedRole = role;
          break;
        }
      }
      if (selectedTeam) {
        break;
      }
    }

    if (!selectedTeam || !selectedRole) {
      throw new HttpsError(
        "resource-exhausted",
        "This game is already in progress and all seats are taken."
      );
    }

    const teamData = selectedTeam.data() as Record<string, unknown>;
    const humanCount = typeof teamData.humanCount === "number" ? teamData.humanCount : 0;
    const teamName = typeof teamData.name === "string" ? teamData.name : null;

    const playerRef = playersRef.doc();
    tx.set(playerRef, {
      ...commonPlayerFields,
      teamId: selectedTeam.id,
      role: selectedRole,
      teamName,
    });

    tx.set(nameRef, {
      playerId: playerRef.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(selectedTeam.ref, {
      [`stages.${selectedRole}.playerId`]: playerRef.id,
      [`stages.${selectedRole}.playerName`]: name,
      [`stages.${selectedRole}.isRobot`]: false,
      humanCount: humanCount + 1,
    });

    tx.update(gameRef, {
      humanJoinCount: admin.firestore.FieldValue.increment(1),
    });

    const ownerInstructorId = gameData.ownerInstructorId;
    if (typeof ownerInstructorId === "string" && ownerInstructorId.length > 0) {
      tx.set(
        db.collection("instructors").doc(ownerInstructorId),
        {
          playersJoinedCount: admin.firestore.FieldValue.increment(1),
        },
        { merge: true }
      );
    }

    payload = {
      mode: "created",
      playerId: playerRef.id,
      role: selectedRole,
      sessionToken: token,
    };
  });

  if (!payload) {
    throw new HttpsError("internal", "Failed to join game.");
  }

  return payload;
});

async function validatePlayerToken(params: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
}) {
  const gameRef = db.collection("games").doc(params.gameCode);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) {
    throw new HttpsError("not-found", "Game not found.");
  }

  const gameData = gameSnap.data() as Record<string, unknown>;
  if (isTimestampExpired(gameData.expiresAt)) {
    throw new HttpsError("failed-precondition", "Session has expired.");
  }

  const playerRef = gameRef.collection("players").doc(params.playerId);
  const playerSnap = await playerRef.get();
  if (!playerSnap.exists) {
    throw new HttpsError("not-found", "Player not found.");
  }

  const playerData = playerSnap.data() as Record<string, unknown>;
  const storedHash = typeof playerData.sessionTokenHash === "string" ? playerData.sessionTokenHash : "";
  const incomingHash = hashToken(params.sessionToken);

  if (!storedHash || storedHash.length !== incomingHash.length) {
    throw new HttpsError("permission-denied", "Invalid player token.");
  }

  const isValid = crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(incomingHash));
  if (!isValid) {
    throw new HttpsError("permission-denied", "Invalid player token.");
  }

  return {
    gameRef,
    gameData,
    playerRef,
    playerData,
  };
}

export const heartbeatPlayer = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const callerUid = requireAuthUid(request);
  await enforceRateLimit(callerUid, "heartbeatPlayer", 60, 60);
  const gameCode = parseGameCode(request.data?.gameCode);
  const playerId = typeof request.data?.playerId === "string" ? request.data.playerId.trim() : "";
  const sessionToken =
    typeof request.data?.sessionToken === "string" ? request.data.sessionToken.trim() : "";

  if (!playerId || !sessionToken) {
    throw new HttpsError("invalid-argument", "playerId and sessionToken are required.");
  }

  const validated = await validatePlayerToken({ gameCode, playerId, sessionToken });
  await validated.playerRef.update({
    lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, serverTime: Date.now() };
});

export const submitPlayerOrder = onCall({ enforceAppCheck: true, maxInstances: 100 }, async (request) => {
  const callerUid = requireAuthUid(request);
  await enforceRateLimit(callerUid, "submitPlayerOrder", 30, 60);
  const gameCode = parseGameCode(request.data?.gameCode);
  const playerId = typeof request.data?.playerId === "string" ? request.data.playerId.trim() : "";
  const sessionToken =
    typeof request.data?.sessionToken === "string" ? request.data.sessionToken.trim() : "";
  const orderRaw = Number(request.data?.order);

  if (!playerId || !sessionToken || Number.isNaN(orderRaw)) {
    throw new HttpsError("invalid-argument", "playerId, sessionToken, and order are required.");
  }

  const order = Math.max(0, Math.round(orderRaw));
  const validated = await validatePlayerToken({ gameCode, playerId, sessionToken });

  const status = validated.gameData.status as GameStatus;
  if (status !== "in_progress") {
    throw new HttpsError("failed-precondition", "Game is not in progress.");
  }

  const teamId = typeof validated.playerData.teamId === "string" ? validated.playerData.teamId : null;
  const role = typeof validated.playerData.role === "string" ? validated.playerData.role : null;

  if (!teamId || !role) {
    throw new HttpsError("failed-precondition", "Player is not assigned to a role.");
  }

  const teamRef = validated.gameRef.collection("teams").doc(teamId);
  await db.runTransaction(async (tx) => {
    const teamSnap = await tx.get(teamRef);
    if (!teamSnap.exists) {
      throw new HttpsError("not-found", "Team not found.");
    }

    const teamData = teamSnap.data() as Record<string, unknown>;
    const ordersSubmitted = isRecord(teamData.ordersSubmitted) ? teamData.ordersSubmitted : {};
    const alreadySubmitted = ordersSubmitted[role] === true;
    if (alreadySubmitted) {
      return;
    }

    tx.update(teamRef, {
      [`pendingOrders.${role}`]: order,
      [`ordersSubmitted.${role}`]: true,
    });

    tx.update(validated.playerRef, {
      lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { ok: true };
});

interface BudgetNotificationPayload {
  costAmount?: number;
  budgetAmount?: number;
  alertThresholdExceeded?: number;
  forecastThresholdExceeded?: number;
  budgetDisplayName?: string;
}

export const billingKillSwitch = onMessagePublished(
  "billing-kill-switch",
  async (event) => {
    const projectId = process.env.GCLOUD_PROJECT;
    if (!projectId) {
      logger.error("Kill-switch fired but GCLOUD_PROJECT is unset; aborting.");
      return;
    }

    let payload: BudgetNotificationPayload = {};
    const messageJson = event.data?.message?.json;
    if (messageJson && typeof messageJson === "object") {
      payload = messageJson as BudgetNotificationPayload;
    } else {
      const raw = event.data?.message?.data;
      if (typeof raw === "string") {
        try {
          payload = JSON.parse(Buffer.from(raw, "base64").toString());
        } catch (err) {
          logger.warn("Kill-switch payload was not JSON; treating as forced trigger.", {
            err,
          });
        }
      }
    }

    const cost = Number(payload.costAmount ?? 0);
    const budget = Number(payload.budgetAmount ?? 0);

    // Budget alerts also fire for forecasted spend (forecastThresholdExceeded).
    // Only kill billing once *actual* cost has crossed the budget, otherwise a
    // single forecasting blip could nuke the project.
    if (budget > 0 && cost <= budget) {
      logger.info("Budget alert received but actual cost is within budget.", {
        cost,
        budget,
        budgetDisplayName: payload.budgetDisplayName,
      });
      return;
    }

    const projectName = `projects/${projectId}`;
    const billingClient = new CloudBillingClient();

    const [billingInfo] = await billingClient.getProjectBillingInfo({ name: projectName });
    if (!billingInfo.billingEnabled) {
      logger.info("Billing already disabled for project; nothing to do.", { projectId });
      return;
    }

    await billingClient.updateProjectBillingInfo({
      name: projectName,
      projectBillingInfo: { billingAccountName: "" },
    });

    logger.error("BILLING DISABLED via kill-switch", {
      projectId,
      cost,
      budget,
      budgetDisplayName: payload.budgetDisplayName,
    });
  }
);

export const cleanupOrphanAuthUsers = onSchedule(
  { schedule: "every monday 03:30", timeoutSeconds: 540 },
  async () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const RATE_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  let pageToken: string | undefined;
  let scanned = 0;
  let deletedAuthUsers = 0;

  do {
    const result: admin.auth.ListUsersResult = await admin.auth().listUsers(1000, pageToken);
    for (const user of result.users) {
      scanned += 1;
      const created = user.metadata.creationTime ? Date.parse(user.metadata.creationTime) : 0;
      const age = now - created;
      const isAnonymous = (user.providerData?.length ?? 0) === 0;
      const threshold = isAnonymous ? THIRTY_DAYS_MS : SEVEN_DAYS_MS;
      if (age < threshold) {
        continue;
      }

      const profileSnap = await db.collection("instructors").doc(user.uid).get();
      if (profileSnap.exists) {
        continue;
      }

      try {
        await admin.auth().deleteUser(user.uid);
        deletedAuthUsers += 1;
      } catch (err) {
        logger.warn("Failed to delete orphan auth user", { uid: user.uid, err });
      }
    }
    pageToken = result.pageToken;
  } while (pageToken);

  let deletedRateLimits = 0;
  while (true) {
    const cutoff = now - RATE_LIMIT_TTL_MS;
    const stale = await db
      .collection("rateLimits")
      .where("updatedAt", "<", cutoff)
      .limit(200)
      .get();
    if (stale.empty) {
      break;
    }
    const batch = db.batch();
    stale.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deletedRateLimits += stale.size;
  }

  logger.info("Orphan auth user cleanup complete", {
    scanned,
    deletedAuthUsers,
    deletedRateLimits,
  });
});

export const cleanupExpiredSessions = onSchedule("every monday 03:00", async () => {
  const now = admin.firestore.Timestamp.now();
  let deleted = 0;

  while (true) {
    const snap = await db
      .collection("games")
      .where("expiresAt", "<=", now)
      .limit(20)
      .get();

    if (snap.empty) {
      break;
    }

    for (const docSnap of snap.docs) {
      await db.recursiveDelete(docSnap.ref);
      deleted += 1;
    }
  }

  logger.info("Expired session cleanup complete", { deleted });
});
