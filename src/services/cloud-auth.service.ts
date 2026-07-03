/**
 * cloud-auth.service.ts
 *
 * The **same auth the web + mobile apps use** (Google → Firebase), brought to the
 * extension. `vibesearch-api` authorizes with a **Firebase ID token**; this module
 * obtains + refreshes one and stores it at `AUTH_TOKEN_STORAGE_KEY` so
 * `archive.service` and `cloud-sync.service` can push to the cloud.
 *
 * It uses the Firebase **Identity Toolkit REST API** directly (not the heavy
 * Firebase SDK) because it must run inside the MV3 service worker (no DOM / no
 * IndexedDB persistence). Two entry points:
 *   • signInWithGoogle()          — chrome.identity → Google token → signInWithIdp
 *   • signInWithTestCredentials() — email/password (mirrors apps/api/scripts/smoke.sh;
 *                                   used to verify the cloud path without OAuth)
 * Tokens auto-refresh via securetoken.googleapis.com.
 */
import { AUTH_TOKEN_STORAGE_KEY, setStoredAuthToken, clearStoredAuthToken } from "./archive.service";
import { getGoogleAccessToken, clearGoogleAccessToken } from "./google-auth";

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1/accounts";
const SECURE_TOKEN = "https://securetoken.googleapis.com/v1/token";

/** chrome.storage.local key holding the Firebase refresh token + account info. */
const SESSION_KEY = "vibesearch:cloudSession";

export interface CloudSession {
  uid: string;
  email?: string;
  refreshToken: string;
  /** epoch ms when the current id token expires. */
  expiresAt: number;
}

export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

/** The Firebase Web API key — same value the web app uses (`VITE_FIREBASE_API_KEY`). */
function resolveFirebaseApiKey(): string {
  // Direct static access so Vite inlines it at build time (optional chaining would
  // prevent the static replacement).
  const key = import.meta.env.VITE_FIREBASE_API_KEY;
  if (!key || !key.trim()) {
    throw new CloudAuthError(
      "Missing VITE_FIREBASE_API_KEY — set the same Firebase web config the web app uses.",
    );
  }
  return key.trim();
}

async function readSession(): Promise<CloudSession | null> {
  try {
    const row = await chrome.storage.local.get(SESSION_KEY);
    const s = row?.[SESSION_KEY];
    return s && typeof s.refreshToken === "string" ? (s as CloudSession) : null;
  } catch {
    return null;
  }
}

async function writeSession(session: CloudSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

/** Persist a fresh id token both as the API bearer and in the session record. */
async function persistToken(params: {
  idToken: string;
  refreshToken: string;
  expiresInSec: number;
  uid: string;
  email?: string;
}): Promise<void> {
  await setStoredAuthToken(params.idToken);
  await writeSession({
    uid: params.uid,
    email: params.email,
    refreshToken: params.refreshToken,
    expiresAt: Date.now() + Math.max(0, params.expiresInSec - 60) * 1000,
  });
}

/** Sign in with the same Google account flow as web/mobile → Firebase ID token. */
export async function signInWithGoogle(interactive = true): Promise<CloudSession> {
  const apiKey = resolveFirebaseApiKey();
  const google = await getGoogleAccessToken(interactive);
  const res = await fetch(`${IDENTITY_TOOLKIT}:signInWithIdp?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postBody: `access_token=${encodeURIComponent(google.token)}&providerId=google.com`,
      requestUri: "https://vibesearch.app",
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !data.idToken) {
    throw new CloudAuthError(data?.error ? JSON.stringify(data.error) : "Google sign-in failed.");
  }
  await persistToken({
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresInSec: Number(data.expiresIn ?? "3600"),
    uid: data.localId,
    email: data.email,
  });
  return (await readSession())!;
}

/**
 * Sign in with an email/password test account (mirrors smoke.sh). Lets the cloud
 * path be exercised without interactive Google consent. Tries sign-in, then sign-up.
 */
export async function signInWithTestCredentials(email: string, password: string): Promise<CloudSession> {
  const apiKey = resolveFirebaseApiKey();
  const call = (op: "signInWithPassword" | "signUp") =>
    fetch(`${IDENTITY_TOOLKIT}:${op}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  let res = await call("signInWithPassword");
  let data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !data.idToken) {
    res = await call("signUp");
    data = (await res.json().catch(() => ({}))) as Record<string, string>;
  }
  if (!res.ok || !data.idToken) {
    throw new CloudAuthError(data?.error ? JSON.stringify(data.error) : "Test sign-in failed.");
  }
  await persistToken({
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresInSec: Number(data.expiresIn ?? "3600"),
    uid: data.localId,
    email,
  });
  return (await readSession())!;
}

/** Return a valid Firebase ID token, refreshing via the refresh token if expired. */
export async function getValidIdToken(): Promise<string | null> {
  const session = await readSession();
  if (!session) return null;
  if (Date.now() < session.expiresAt) {
    const row = await chrome.storage.local.get(AUTH_TOKEN_STORAGE_KEY);
    const cached = row?.[AUTH_TOKEN_STORAGE_KEY];
    if (typeof cached === "string" && cached) return cached;
  }
  // Refresh.
  try {
    const apiKey = resolveFirebaseApiKey();
    const res = await fetch(`${SECURE_TOKEN}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (!res.ok || !data.id_token) return null;
    await setStoredAuthToken(data.id_token);
    await writeSession({
      ...session,
      refreshToken: data.refresh_token || session.refreshToken,
      expiresAt: Date.now() + Math.max(0, Number(data.expires_in ?? "3600") - 60) * 1000,
    });
    return data.id_token;
  } catch {
    return null;
  }
}

export async function getCloudAccount(): Promise<{ uid: string; email?: string } | null> {
  const s = await readSession();
  return s ? { uid: s.uid, email: s.email } : null;
}

export async function isSignedIn(): Promise<boolean> {
  return (await getValidIdToken()) != null;
}

export async function signOutCloud(): Promise<void> {
  await clearStoredAuthToken();
  try {
    await chrome.storage.local.remove(SESSION_KEY);
  } catch {
    /* ignore */
  }
  try {
    await clearGoogleAccessToken();
  } catch {
    /* ignore */
  }
}
