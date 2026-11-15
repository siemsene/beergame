import { FirebaseError } from "firebase/app";

const AUTH_MESSAGES: Record<string, string> = {
  "auth/email-already-in-use":
    "An account with this email already exists. Use the Sign in tab (or Reset password) to continue your application.",
  "auth/invalid-email": "That email address is not valid.",
  "auth/weak-password": "That password is too weak. Use at least 8 characters.",
  "auth/password-does-not-meet-requirements":
    "That password does not meet the password requirements.",
  "auth/network-request-failed":
    "Could not reach the sign-in service. Check your internet connection, disable VPN/ad or privacy blockers for this site, or try another network or browser.",
  "auth/too-many-requests":
    "Too many attempts from this device or network. Please wait a few minutes and try again.",
  "auth/operation-not-allowed": "Email/password registration is currently disabled.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/user-disabled": "This account has been disabled. Contact the administrator.",
  "auth/missing-email": "Enter your email address.",
  "auth/firebase-app-check-token-is-invalid":
    "Browser verification failed. Disable ad or privacy blockers for this site, or try another browser.",
};

const FUNCTIONS_MESSAGES: Record<string, string> = {
  "functions/unauthenticated": "Your session has expired. Sign out and sign in again.",
  "functions/unavailable":
    "The server could not be reached. Check your connection and try again.",
  "functions/internal": "The server hit an unexpected error. Please try again.",
};

/**
 * Turns a Firebase Auth / callable Functions error into a message that is safe
 * and useful to show to the user. Always appends the error code so that users
 * reporting a problem give us something to diagnose.
 */
export function describeFirebaseError(err: unknown, fallback: string): string {
  if (err instanceof FirebaseError) {
    const known = AUTH_MESSAGES[err.code] ?? FUNCTIONS_MESSAGES[err.code];
    if (known) {
      return `${known} (${err.code})`;
    }
    // Callable HttpsErrors thrown on purpose by our functions carry a
    // human-readable message (e.g. "Cannot approve an instructor whose email
    // has not been verified.").
    if (err.code.startsWith("functions/") && err.message && err.message !== "INTERNAL") {
      return `${err.message} (${err.code})`;
    }
    return `${fallback} (${err.code})`;
  }
  return fallback;
}

export function firebaseErrorCode(err: unknown): string | null {
  return err instanceof FirebaseError ? err.code : null;
}
