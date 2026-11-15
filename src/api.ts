import { HttpsCallableResult, httpsCallable } from "firebase/functions";
import { signInAnonymously } from "firebase/auth";
import { auth, functions } from "./firebase";
import { GameConfig } from "./logic/gameModel";

let pendingAnon: Promise<unknown> | null = null;
async function ensurePlayerAuth() {
  if (auth.currentUser) {
    return;
  }
  if (!pendingAnon) {
    pendingAnon = signInAnonymously(auth).finally(() => {
      pendingAnon = null;
    });
  }
  await pendingAnon;
}

export interface JoinOrResumeResponse {
  mode: "created" | "reconnected";
  playerId: string;
  role: string;
  sessionToken: string;
}

const submitInstructorApplicationFn = httpsCallable<
  { name: string; institution: string; country: string },
  { status: string; role: string }
>(functions, "submitInstructorApplication");

const ensureAdminProfileFn = httpsCallable<
  Record<string, never>,
  { created: boolean }
>(functions, "ensureAdminProfile");

const syncEmailVerifiedFn = httpsCallable<
  Record<string, never>,
  { emailVerified: boolean }
>(functions, "syncEmailVerified");

const adminReviewInstructorFn = httpsCallable<
  { instructorUid: string; decision: "approve" | "reject" },
  { status: string; emailSent?: boolean }
>(functions, "adminReviewInstructor");

const adminRevokeInstructorFn = httpsCallable<
  { instructorUid: string },
  { status: string; emailSent?: boolean }
>(functions, "adminRevokeInstructor");

const adminDeleteInstructorFn = httpsCallable<
  { instructorUid: string },
  { deleted: boolean }
>(functions, "adminDeleteInstructor");

const createSessionFn = httpsCallable<
  { notes: string; config: GameConfig },
  { gameCode: string }
>(functions, "createSession");

const deleteSessionFn = httpsCallable<
  { gameCode: string },
  { deleted: boolean }
>(functions, "deleteSession");

const joinOrResumePlayerFn = httpsCallable<
  { gameCode: string; name: string },
  JoinOrResumeResponse
>(functions, "joinOrResumePlayer");

const submitPlayerOrderFn = httpsCallable<
  { gameCode: string; playerId: string; sessionToken: string; order: number },
  { ok: boolean }
>(functions, "submitPlayerOrder");

const heartbeatPlayerFn = httpsCallable<
  { gameCode: string; playerId: string; sessionToken: string },
  { ok: boolean; serverTime: number }
>(functions, "heartbeatPlayer");

function unwrap<T>(result: HttpsCallableResult<T>): T {
  return result.data;
}

export async function submitInstructorApplication(input: {
  name: string;
  institution: string;
  country: string;
}) {
  return unwrap(await submitInstructorApplicationFn(input));
}

export async function ensureAdminProfile() {
  return unwrap(await ensureAdminProfileFn({}));
}

export async function syncEmailVerified() {
  return unwrap(await syncEmailVerifiedFn({}));
}

export async function adminReviewInstructor(input: {
  instructorUid: string;
  decision: "approve" | "reject";
}) {
  return unwrap(await adminReviewInstructorFn(input));
}

export async function adminRevokeInstructor(input: { instructorUid: string }) {
  return unwrap(await adminRevokeInstructorFn(input));
}

export async function adminDeleteInstructor(input: { instructorUid: string }) {
  return unwrap(await adminDeleteInstructorFn(input));
}

export async function createSession(input: { notes: string; config: GameConfig }) {
  return unwrap(await createSessionFn(input));
}

export async function deleteSession(input: { gameCode: string }) {
  return unwrap(await deleteSessionFn(input));
}

export async function joinOrResumePlayer(input: {
  gameCode: string;
  name: string;
}) {
  await ensurePlayerAuth();
  return unwrap(await joinOrResumePlayerFn(input));
}

export async function submitPlayerOrder(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
  order: number;
}) {
  await ensurePlayerAuth();
  return unwrap(await submitPlayerOrderFn(input));
}

export async function heartbeatPlayer(input: {
  gameCode: string;
  playerId: string;
  sessionToken: string;
}) {
  await ensurePlayerAuth();
  return unwrap(await heartbeatPlayerFn(input));
}
