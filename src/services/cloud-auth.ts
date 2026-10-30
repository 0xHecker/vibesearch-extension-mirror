import { requireLegacyCloud } from "./extension-policy";
import { z } from "zod";
import { FIREFOX_RUNTIME_FRAME_ID, setupOffscreenDocument } from "./offscreen-helper";
import {
  CLOUD_SYNC_TOKEN_KEY,
  DEVELOPMENT_CLOUD_AUTH_ENABLED,
  DEVELOPMENT_CLOUD_AUTH_UID,
  DEFAULT_VIBESEARCH_AUTH_URL,
} from "./cloud-config";
import {
  CLOUD_AUTH_EXPIRES_AT_KEY,
  CLOUD_AUTH_OPT_IN_KEY,
  CLOUD_AUTH_PROFILE_KEY,
  CLOUD_AUTH_REJECTED_AT_KEY,
  runtimeCloudAuthStorage,
} from "./cloud-auth-storage-bridge";

export {
  CLOUD_AUTH_EXPIRES_AT_KEY,
  CLOUD_AUTH_OPT_IN_KEY,
  CLOUD_AUTH_PROFILE_KEY,
  CLOUD_AUTH_REJECTED_AT_KEY,
} from "./cloud-auth-storage-bridge";

const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const AUTH_FRAME_ID = "vibesearch-cloud-auth-frame";
const AUTH_FRAME_READY_TIMEOUT_MS = 20_000;
const AUTH_REQUEST_TIMEOUT_MS = 120_000;

export type CloudAuthProfile = {
  uid: string;
  name: string | null;
  email: string | null;
  photoURL: string | null;
};

export type CloudAuthToken = {
  token: string;
  expiresAt: number;
  user: CloudAuthProfile;
};

export type CloudAuthCredentials = CloudConnectionLifetime & {
  token: string;
  userId: string;
  isCurrent?: () => boolean;
};

export const cloudAuthConnectionSchema = z.object({
  token: z.string(),
  userId: z.string(),
  leaseId: z.string().max(200),
});
export type CloudAuthConnectionDescriptor = z.infer<typeof cloudAuthConnectionSchema>;
export type CloudConnectionLifetime = {
  isCurrent?: () => boolean;
  validate?: () => Promise<boolean>;
  reject?: () => Promise<void>;
};
export type CloudAuthConnection = CloudAuthCredentials & CloudConnectionLifetime;

export type CloudAuthStatus = {
  connected: boolean;
  optedIn: boolean;
  needsReconnect: boolean;
  expiresAt: number;
  user: CloudAuthProfile | null;
};

type HostedAuthRequest = {
  interactive: boolean;
  forceRefresh: boolean;
  /**
   * Ask the hosted page for the Google account chooser even when a web session
   * is already live in this browser. Set for an explicit connect so logging out
   * and back in confirms the account instead of silently reusing the last one.
   */
  selectAccount?: boolean;
};

type CloudAuthStorage = {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

export type CloudAuthServiceOptions = {
  storage?: CloudAuthStorage;
  requestHostedToken?: (request: HostedAuthRequest) => Promise<CloudAuthToken>;
  /** Ran after an explicit disconnect, to drop account-scoped local state. */
  onDisconnected?: () => Promise<void>;
  now?: () => number;
  autoConnect?: boolean;
};

const chromeStorage: CloudAuthStorage = {
  get: (keys) => chrome.storage?.local
    ? chrome.storage.local.get(keys)
    : runtimeCloudAuthStorage.get(keys),
  set: (values) => chrome.storage?.local
    ? chrome.storage.local.set(values)
    : runtimeCloudAuthStorage.set(values),
  remove: (keys) => chrome.storage?.local
    ? chrome.storage.local.remove(keys)
    : runtimeCloudAuthStorage.remove(keys),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalizeProfile = (value: unknown): CloudAuthProfile | null => {
  if (!isRecord(value) || typeof value.uid !== "string" || !value.uid.trim()) return null;
  return {
    uid: value.uid.trim(),
    name: nullableString(value.name),
    email: nullableString(value.email),
    photoURL: nullableString(value.photoURL),
  };
};

const decodeBase64Url = (value: string): string => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
};

export const firebaseTokenExpiresAt = (token: string): number => {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const parsed = JSON.parse(decodeBase64Url(payload)) as { exp?: unknown };
    return Number.isSafeInteger(parsed.exp) && Number(parsed.exp) > 0 ? Number(parsed.exp) * 1000 : 0;
  } catch {
    return 0;
  }
};

export const firebaseTokenUserId = (token: string): string => {
  const payload = token.split(".")[1];
  if (!payload) return token.startsWith("dev:") ? token.slice(4).trim() : "";
  try {
    const parsed = JSON.parse(decodeBase64Url(payload)) as { sub?: unknown; user_id?: unknown };
    const value = typeof parsed.sub === "string" ? parsed.sub : parsed.user_id;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
};

const normalizeHostedToken = (value: unknown, now = Date.now()): CloudAuthToken => {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token.trim()) {
    throw new Error("CLOUD_AUTH_TOKEN_MISSING");
  }
  const user = normalizeProfile(value.user);
  if (!user) throw new Error("CLOUD_AUTH_PROFILE_MISSING");
  const expiresAt = Number.isSafeInteger(value.expiresAt)
    ? Number(value.expiresAt)
    : firebaseTokenExpiresAt(value.token);
  if (expiresAt <= now) throw new Error("CLOUD_AUTH_TOKEN_EXPIRED");
  return { token: value.token.trim(), expiresAt, user };
};

let framePromise: Promise<HTMLIFrameElement> | null = null;

const ensureAuthFrame = (): Promise<HTMLIFrameElement> => {
  if (framePromise) return framePromise;
  if (typeof document === "undefined" || typeof window === "undefined") {
    return Promise.reject(new Error("CLOUD_AUTH_FRAME_UNAVAILABLE"));
  }

  framePromise = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const authUrl = new URL(DEFAULT_VIBESEARCH_AUTH_URL);
    const existing = document.getElementById(AUTH_FRAME_ID) as HTMLIFrameElement | null;
    const frame = existing ?? document.createElement("iframe");
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (error) {
        framePromise = null;
        if (!existing) frame.remove();
        reject(error);
      } else {
        resolve(frame);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== authUrl.origin || event.source !== frame.contentWindow) return;
      if (!isRecord(event.data) || event.data.source !== "vibesearch-web-auth" || event.data.type !== "ready") return;
      finish();
    };
    const timeout = window.setTimeout(
      () => finish(new Error("CLOUD_AUTH_FRAME_TIMEOUT")),
      AUTH_FRAME_READY_TIMEOUT_MS,
    );

    window.addEventListener("message", onMessage);
    if (!existing) {
      frame.id = AUTH_FRAME_ID;
      frame.src = authUrl.toString();
      // Firebase's MV3 popup flow must run in a rendered iframe hosted by the
      // offscreen document. Setting `hidden` makes the frame `display: none`
      // and Brave/Chromium can leave `signInWithPopup()` pending forever.
      // The parent offscreen document is itself invisible to the user.
      frame.title = "VibeSearch account authentication";
      document.body.append(frame);
    } else {
      frame.contentWindow?.postMessage(
        { source: "vibesearch-extension", type: "ready-check" },
        authUrl.origin,
      );
    }
  });
  return framePromise;
};

export const requestHostedCloudToken = async (request: HostedAuthRequest): Promise<CloudAuthToken> => {
  await requireLegacyCloud();
  const frame = await ensureAuthFrame();
  const authUrl = new URL(DEFAULT_VIBESEARCH_AUTH_URL);
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

  return new Promise<CloudAuthToken>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, token?: CloudAuthToken) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolve(token as CloudAuthToken);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== authUrl.origin || event.source !== frame.contentWindow || !isRecord(event.data)) return;
      if (event.data.source !== "vibesearch-web-auth" || event.data.type !== "token" || event.data.requestId !== requestId) return;
      if (event.data.ok !== true) {
        finish(new Error(typeof event.data.error === "string" ? event.data.error : "CLOUD_AUTH_FAILED"));
        return;
      }
      try {
        finish(undefined, normalizeHostedToken(event.data.payload));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("CLOUD_AUTH_INVALID_RESPONSE"));
      }
    };
    const timeout = window.setTimeout(
      () => finish(new Error("CLOUD_AUTH_REQUEST_TIMEOUT")),
      request.interactive ? AUTH_REQUEST_TIMEOUT_MS : AUTH_FRAME_READY_TIMEOUT_MS,
    );
    window.addEventListener("message", onMessage);
    frame.contentWindow?.postMessage(
      {
        source: "vibesearch-extension",
        type: "token",
        requestId,
        interactive: request.interactive,
        forceRefresh: request.forceRefresh,
        selectAccount: request.selectAccount === true,
      },
      authUrl.origin,
    );
  });
};

export const requestDevelopmentCloudToken = async (): Promise<CloudAuthToken> => ({
  token: `dev:${DEVELOPMENT_CLOUD_AUTH_UID}`,
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  user: {
    uid: DEVELOPMENT_CLOUD_AUTH_UID,
    name: "Dev User",
    email: null,
    photoURL: null,
  },
});

export class CloudAuthService {
  private readonly storage: CloudAuthStorage;
  private readonly requestToken: (request: HostedAuthRequest) => Promise<CloudAuthToken>;
  private readonly now: () => number;
  private readonly autoConnect: boolean;
  private readonly onDisconnected?: () => Promise<void>;
  private refreshInFlight: Promise<string> | null = null;
  private mutationGeneration = 0;
  private completedMutationGeneration = 0;
  private storageMutationTail: Promise<void> = Promise.resolve();
  private readonly instanceId = crypto.randomUUID();

  constructor(options: CloudAuthServiceOptions = {}) {
    this.storage = options.storage ?? chromeStorage;
    this.requestToken = options.requestHostedToken ?? (
      DEVELOPMENT_CLOUD_AUTH_ENABLED ? requestDevelopmentCloudToken : requestHostedCloudToken
    );
    this.now = options.now ?? Date.now;
    this.autoConnect = options.autoConnect ?? DEVELOPMENT_CLOUD_AUTH_ENABLED;
    this.onDisconnected = options.onDisconnected;
  }

  private async read() {
    const row = await this.storage.get([
      CLOUD_SYNC_TOKEN_KEY,
      CLOUD_AUTH_EXPIRES_AT_KEY,
      CLOUD_AUTH_PROFILE_KEY,
      CLOUD_AUTH_OPT_IN_KEY,
      CLOUD_AUTH_REJECTED_AT_KEY,
    ]);
    const token = typeof row[CLOUD_SYNC_TOKEN_KEY] === "string" ? row[CLOUD_SYNC_TOKEN_KEY].trim() : "";
    const storedExpiry = Number.isSafeInteger(row[CLOUD_AUTH_EXPIRES_AT_KEY])
      ? Number(row[CLOUD_AUTH_EXPIRES_AT_KEY])
      : 0;
    const rejectedAt = Number.isSafeInteger(row[CLOUD_AUTH_REJECTED_AT_KEY])
      ? Number(row[CLOUD_AUTH_REJECTED_AT_KEY])
      : 0;
    return {
      token,
      expiresAt: storedExpiry || firebaseTokenExpiresAt(token),
      rejectedAt,
      user: normalizeProfile(row[CLOUD_AUTH_PROFILE_KEY]),
      optedIn: this.autoConnect || row[CLOUD_AUTH_OPT_IN_KEY] === true || Boolean(token),
    };
  }

  private async mutateStorage(operation: () => Promise<void>): Promise<void> {
    let release!: () => void;
    const previous = this.storageMutationTail;
    this.storageMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  private async persist(result: CloudAuthToken, generation: number): Promise<void> {
    await this.mutateStorage(async () => {
      if (generation !== this.mutationGeneration) return;
      await this.storage.set({
        [CLOUD_SYNC_TOKEN_KEY]: result.token,
        [CLOUD_AUTH_EXPIRES_AT_KEY]: result.expiresAt,
        [CLOUD_AUTH_PROFILE_KEY]: result.user,
        [CLOUD_AUTH_OPT_IN_KEY]: true,
        // A freshly issued token clears any previous refusal.
        [CLOUD_AUTH_REJECTED_AT_KEY]: 0,
      });
    });
  }

  /**
   * The API refused this session (401/403). Local expiry claims cannot detect
   * that — an opaque token reports no expiry and would otherwise read as
   * "connected" forever — so the refusal is recorded and the stale token is
   * dropped. `optedIn` survives, so the UI asks for a reconnect instead of
   * pretending the account was never connected.
   */
  async markSessionRejected(leaseId?: string, rejectedToken?: string): Promise<void> {
    if (leaseId !== undefined && !this.validateConnection(leaseId)) return;
    const current = await this.read();
    if (leaseId !== undefined && !this.validateConnection(leaseId)) return;
    if (rejectedToken !== undefined && current.token !== rejectedToken) return;
    if (!current.optedIn && !current.token) return;
    const generation = ++this.mutationGeneration;
    this.refreshInFlight = null;
    await this.mutateStorage(async () => {
      await this.storage.remove([CLOUD_SYNC_TOKEN_KEY, CLOUD_AUTH_EXPIRES_AT_KEY]);
      await this.storage.set({ [CLOUD_AUTH_REJECTED_AT_KEY]: this.now() });
    });
    if (generation === this.mutationGeneration) this.completedMutationGeneration = generation;
  }

  async connect(): Promise<CloudAuthStatus> {
    const generation = ++this.mutationGeneration;
    try {
      const result = normalizeHostedToken(
        // An explicit connect always confirms the account, so reconnecting after
        // a disconnect never silently reuses the previous one.
        await this.requestToken({ interactive: true, forceRefresh: true, selectAccount: true }),
        this.now(),
      );
      await this.persist(result, generation);
    } finally {
      await this.storageMutationTail;
      if (generation === this.mutationGeneration) this.completedMutationGeneration = generation;
    }
    try {
      void chrome.runtime.sendMessage({ target: "background", type: "CLOUD_SYNC_QUEUED" });
    } catch {}
    return this.status();
  }

  async disconnect(): Promise<CloudAuthStatus> {
    const generation = ++this.mutationGeneration;
    await this.mutateStorage(async () => {
      await this.storage.remove([CLOUD_SYNC_TOKEN_KEY, CLOUD_AUTH_EXPIRES_AT_KEY, CLOUD_AUTH_PROFILE_KEY]);
      await this.storage.set({ [CLOUD_AUTH_OPT_IN_KEY]: false, [CLOUD_AUTH_REJECTED_AT_KEY]: 0 });
    });
    if (generation === this.mutationGeneration) this.completedMutationGeneration = generation;
    // A read position belongs to the account that produced it.
    await this.onDisconnected?.().catch(() => undefined);
    return this.status();
  }

  async invalidate(): Promise<void> {
    const generation = ++this.mutationGeneration;
    await this.mutateStorage(() => this.storage.remove([CLOUD_SYNC_TOKEN_KEY, CLOUD_AUTH_EXPIRES_AT_KEY]));
    if (generation === this.mutationGeneration) this.completedMutationGeneration = generation;
  }

  async getToken(forceRefresh = false): Promise<string> {
    const current = await this.read();
    if (!current.optedIn) return "";
    // A recorded refusal means the stored session is dead: never hand it back,
    // and never treat a missing expiry claim as proof of freshness.
    if (current.rejectedAt > 0 && !forceRefresh) return "";
    const opaqueToken = current.token && current.expiresAt === 0 && current.rejectedAt === 0;
    const freshToken = current.token && current.expiresAt > this.now() + TOKEN_REFRESH_SKEW_MS;
    if (!forceRefresh && (opaqueToken || freshToken)) return current.token;
    if (this.refreshInFlight) return this.refreshInFlight;

    const generation = this.mutationGeneration;
    this.refreshInFlight = this.requestToken({ interactive: false, forceRefresh: true })
      .then(async (result) => {
        const normalized = normalizeHostedToken(result, this.now());
        if (generation !== this.mutationGeneration) {
          const latest = await this.read();
          return latest.optedIn && latest.token &&
            (latest.expiresAt === 0 || latest.expiresAt > this.now())
            ? latest.token
            : "";
        }
        if (current.user && current.user.uid !== normalized.user.uid) this.mutationGeneration += 1;
        const persistedGeneration = this.mutationGeneration;
        await this.persist(normalized, persistedGeneration);
        if (persistedGeneration !== this.mutationGeneration) return "";
        this.completedMutationGeneration = persistedGeneration;
        return normalized.token;
      })
      .catch(async () => {
        if (generation !== this.mutationGeneration) {
          const latest = await this.read();
          return latest.optedIn && latest.token &&
            (latest.expiresAt === 0 || latest.expiresAt > this.now())
            ? latest.token
            : "";
        }
        if (current.token && current.expiresAt > this.now()) return current.token;
        return "";
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  async getCredentials(forceRefresh = false): Promise<CloudAuthCredentials> {
    const generation = this.mutationGeneration;
    if (generation !== this.completedMutationGeneration) return { token: "", userId: "" };
    const token = await this.getToken(forceRefresh);
    if (generation !== this.mutationGeneration) return { token: "", userId: "" };
    if (!token) return { token: "", userId: "" };
    const state = await this.read();
    // Token and profile are persisted together. If another connect/disconnect
    // wins between getToken() and this read, fail closed instead of pairing one
    // account's bearer token with another account's document ownership.
    if (generation !== this.mutationGeneration || state.token !== token) return { token: "", userId: "" };
    const tokenUserId = firebaseTokenUserId(token);
    const profileUserId = state.user?.uid || "";
    if (tokenUserId && profileUserId && tokenUserId !== profileUserId) {
      return { token: "", userId: "" };
    }
    return { token, userId: tokenUserId || profileUserId, isCurrent: () => generation === this.mutationGeneration };
  }

  async getConnection(forceRefresh = false): Promise<CloudAuthConnectionDescriptor> {
    const generation = this.mutationGeneration;
    const credentials = await this.getCredentials(forceRefresh);
    if (generation !== this.mutationGeneration || generation !== this.completedMutationGeneration) {
      return { token: "", userId: "", leaseId: "" };
    }
    return { token: credentials.token, userId: credentials.userId, leaseId: `${this.instanceId}:${generation}` };
  }

  validateConnection(leaseId: string): boolean {
    return this.mutationGeneration === this.completedMutationGeneration &&
      leaseId === `${this.instanceId}:${this.mutationGeneration}`;
  }

  async status(options: { refresh?: boolean } = {}): Promise<CloudAuthStatus> {
    if (options.refresh) await this.getToken();
    const state = await this.read();
    const connected = Boolean(
      state.optedIn &&
      state.token &&
      state.rejectedAt === 0 &&
      (state.expiresAt === 0 || state.expiresAt > this.now()),
    );
    return {
      connected,
      optedIn: state.optedIn,
      needsReconnect: state.optedIn && !connected,
      expiresAt: state.expiresAt,
      user: state.user,
    };
  }
}

export const cloudAuthService = new CloudAuthService();
let localAuthAuthority = false;

export const useLocalCloudAuthAuthority = (): void => { localAuthAuthority = true; };

const authRpcResponseSchema = z.object({ success: z.boolean(), payload: z.unknown().optional(), error: z.string().optional() });
const requestAuthAuthority = async (type: string, payload: Record<string, string | boolean> = {}): Promise<unknown> => {
  const backgroundContext = typeof document === "undefined" || Boolean(document.getElementById(FIREFOX_RUNTIME_FRAME_ID));
  if (backgroundContext) await setupOffscreenDocument();
  const response = authRpcResponseSchema.parse(await chrome.runtime.sendMessage({
    target: "offscreen", service: "cloudAuth", type, payload,
    ...(backgroundContext ? { isForwarded: true } : {}),
  }));
  if (!response.success) throw new Error(response.error || "CLOUD_AUTH_AUTHORITY_UNAVAILABLE");
  return response.payload;
};

export const getCloudAuthConnection = async (forceRefresh = false): Promise<CloudAuthConnection> => {
  const descriptor = localAuthAuthority
    ? await cloudAuthService.getConnection(forceRefresh)
    : cloudAuthConnectionSchema.parse(await requestAuthAuthority("connection", { forceRefresh }));
  let current = descriptor.leaseId !== "";
  const localCurrent = () => current && (!localAuthAuthority || cloudAuthService.validateConnection(descriptor.leaseId));
  return {
    token: descriptor.token,
    userId: descriptor.userId,
    isCurrent: localCurrent,
    validate: async () => {
      if (!localCurrent()) return false;
      try {
        current = localAuthAuthority
          ? cloudAuthService.validateConnection(descriptor.leaseId)
          : z.boolean().parse(await requestAuthAuthority("validateConnection", { leaseId: descriptor.leaseId }));
      } catch { current = false; }
      return localCurrent();
    },
    reject: async () => {
      if (!localCurrent() || !descriptor.token) return;
      if (localAuthAuthority) await cloudAuthService.markSessionRejected(descriptor.leaseId, descriptor.token);
      else await requestAuthAuthority("rejectConnection", { leaseId: descriptor.leaseId, token: descriptor.token });
      current = false;
    },
  };
};

export const getCloudAuthToken = async (forceRefresh = false): Promise<string> =>
  (await getCloudAuthConnection(forceRefresh)).token;
export const getCloudAuthCredentials = async (forceRefresh = false): Promise<CloudAuthCredentials> => {
  const connection = await getCloudAuthConnection(forceRefresh);
  return connection.token ? connection : { token: "", userId: "" };
};
