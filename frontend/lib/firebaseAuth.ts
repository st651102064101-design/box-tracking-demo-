/* Email-link sign-in for "ลืมรหัสผ่าน?". These values identify the Firebase web app
   and are public by design; they do not grant access on their own. */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signOut,
} from 'firebase/auth';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyAbKW5BY5pSAB4eVJRKR1EDIo-uDmpPn98',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'smarttrace-login.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'smarttrace-login',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '1:1097244573512:web:f19e51a5e62b2a399dbd7d',
};

const EMAIL_KEY = 'st_reset_email';

function app(): FirebaseApp {
  return getApps()[0] ?? initializeApp(config);
}

/** Sends the sign-in link. The link brings the user back to /login?reset=1. */
export async function sendResetLink(email: string) {
  const url = `${window.location.origin}/login?reset=1`;
  await sendSignInLinkToEmail(getAuth(app()), email, { url, handleCodeInApp: true });
  window.localStorage.setItem(EMAIL_KEY, email);
}

/** True when this page was opened from a reset link. */
export function isResetLinkPage(): boolean {
  return isSignInWithEmailLink(getAuth(app()), window.location.href);
}

/** The email the link was requested for on this device, if any. */
export function savedResetEmail(): string {
  return window.localStorage.getItem(EMAIL_KEY) ?? '';
}

/** Proves the email from the link and returns a fresh ID token. */
export async function tokenFromResetLink(email: string): Promise<string> {
  const auth = getAuth(app());
  const cred = await signInWithEmailLink(auth, email, window.location.href);
  window.localStorage.removeItem(EMAIL_KEY);
  const idToken = await cred.user.getIdToken();
  await signOut(auth); // the app keeps its own session; Firebase is only the proof
  return idToken;
}
