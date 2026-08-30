import { expect, test } from "bun:test";
import {
  CLOUD_AUTH_EXPIRES_AT_KEY,
  CLOUD_AUTH_OPT_IN_KEY,
  CLOUD_AUTH_PROFILE_KEY,
  CloudAuthService,
  firebaseTokenExpiresAt,
  firebaseTokenUserId,
  type CloudAuthToken,
} from "@src/services/cloud-auth";
import { CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-config";

const profile = {
  uid: "user-1",
  name: "Ada",
  email: "ada@example.com",
  photoURL: null,
};

const storage = (seed: Record<string, unknown> = {}) => {
  const values = new Map(Object.entries(seed));
  return {
    values,
    adapter: {
      async get(keys: string | string[]) {
        return Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((key) => values.has(key))
            .map((key) => [key, values.get(key)]),
        );
      },
      async set(entries: Record<string, unknown>) {
        for (const [key, value] of Object.entries(entries)) values.set(key, value);
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
      },
    },
  };
};

const token = (expiresAt: number, value = "firebase-token"): CloudAuthToken => ({
  token: value,
  expiresAt,
  user: profile,
});

test("cloud auth requires explicit connection before a hosted session can upload", async () => {
  const local = storage();
  let requests = 0;
  const service = new CloudAuthService({
    storage: local.adapter,
    requestHostedToken: async () => {
      requests += 1;
      return token(Date.now() + 60_000);
    },
  });

  expect(await service.getToken()).toBe("");
  expect(requests).toBe(0);
  expect(await service.status()).toMatchObject({ connected: false, optedIn: false });
});

test("development auth can auto-connect the same identity without an iframe", async () => {
  const now = 1_000_000;
  const local = storage();
  const service = new CloudAuthService({
    storage: local.adapter,
    now: () => now,
    autoConnect: true,
    requestHostedToken: async () => ({
      token: "dev:user_demo",
      expiresAt: now + 60_000,
      user: { ...profile, uid: "user_demo" },
    }),
  });

  expect(await service.getCredentials()).toEqual({
    token: "dev:user_demo",
    userId: "user_demo",
  });
  expect(await service.status()).toMatchObject({
    connected: true,
    optedIn: true,
    user: { uid: "user_demo" },
  });
});

test("cloud auth connection persists identity and refreshes one expired token once", async () => {
  const now = 1_000_000;
  const local = storage();
  const requests: Array<{ interactive: boolean; forceRefresh: boolean }> = [];
  const responses = [token(now + 10_000, "first"), token(now + 3_600_000, "fresh")];
  const service = new CloudAuthService({
    storage: local.adapter,
    now: () => now,
    requestHostedToken: async (request) => {
      requests.push(request);
      return responses.shift() as CloudAuthToken;
    },
  });

  expect(await service.connect()).toMatchObject({ connected: true, optedIn: true, user: profile });
  expect(await Promise.all([service.getToken(), service.getToken()])).toEqual(["fresh", "fresh"]);
  expect(requests).toEqual([
    // An explicit connect confirms the account; the silent refresh must not.
    { interactive: true, forceRefresh: true, selectAccount: true },
    { interactive: false, forceRefresh: true },
  ]);
  expect(local.values.get(CLOUD_SYNC_TOKEN_KEY)).toBe("fresh");
  expect(local.values.get(CLOUD_AUTH_EXPIRES_AT_KEY)).toBe(now + 3_600_000);
  expect(local.values.get(CLOUD_AUTH_PROFILE_KEY)).toEqual(profile);
  expect(local.values.get(CLOUD_AUTH_OPT_IN_KEY)).toBe(true);
});

test("disconnect prevents silent reconnection while leaving the hosted web session alone", async () => {
  const now = Date.now();
  const local = storage({
    [CLOUD_SYNC_TOKEN_KEY]: "stored",
    [CLOUD_AUTH_EXPIRES_AT_KEY]: now + 60_000,
    [CLOUD_AUTH_PROFILE_KEY]: profile,
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  let requests = 0;
  const service = new CloudAuthService({
    storage: local.adapter,
    requestHostedToken: async () => {
      requests += 1;
      return token(now + 60_000);
    },
  });

  expect(await service.disconnect()).toMatchObject({ connected: false, optedIn: false });
  expect(await service.getToken()).toBe("");
  expect(requests).toBe(0);
  expect(local.values.has(CLOUD_SYNC_TOKEN_KEY)).toBe(false);
});

test("an in-flight refresh cannot undo an explicit disconnect", async () => {
  const now = 1_000_000;
  const local = storage({
    [CLOUD_SYNC_TOKEN_KEY]: "expiring-token",
    [CLOUD_AUTH_EXPIRES_AT_KEY]: now + 60_000,
    [CLOUD_AUTH_PROFILE_KEY]: profile,
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  let finishRefresh!: (result: CloudAuthToken) => void;
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const service = new CloudAuthService({
    storage: local.adapter,
    now: () => now,
    requestHostedToken: async () => {
      refreshStarted();
      return new Promise<CloudAuthToken>((resolve) => {
        finishRefresh = resolve;
      });
    },
  });

  const refreshing = service.getToken();
  await started;
  await service.disconnect();
  finishRefresh(token(now + 3_600_000, "late-refresh"));

  expect(await refreshing).toBe("");
  expect(await service.status()).toMatchObject({ connected: false, optedIn: false });
  expect(local.values.has(CLOUD_SYNC_TOKEN_KEY)).toBe(false);
});

test("opaque development tokens remain compatible with the bounded uploader", async () => {
  const local = storage({ [CLOUD_SYNC_TOKEN_KEY]: "test-token" });
  const service = new CloudAuthService({ storage: local.adapter });
  expect(await service.getToken()).toBe("test-token");
  expect(await service.status()).toMatchObject({ connected: true, optedIn: true });
});

test("a session the API refused stops reporting Connected and asks for a reconnect", async () => {
  // The exact state behind "Connected" + "session expired": an opaque token
  // carries no expiry claim, so nothing local can tell it is dead.
  const local = storage({
    [CLOUD_SYNC_TOKEN_KEY]: "opaque-but-dead",
    [CLOUD_AUTH_PROFILE_KEY]: profile,
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  const service = new CloudAuthService({ storage: local.adapter });

  expect(await service.status()).toMatchObject({ connected: true, needsReconnect: false });

  await service.markSessionRejected();

  expect(await service.status()).toMatchObject({
    connected: false,
    optedIn: true,
    needsReconnect: true,
  });
  // The dead token must never be handed to a caller again.
  expect(await service.getToken()).toBe("");
  expect(local.values.has(CLOUD_SYNC_TOKEN_KEY)).toBe(false);
  // The profile survives so the reconnect prompt can name the account.
  expect(local.values.get(CLOUD_AUTH_PROFILE_KEY)).toMatchObject({ email: "ada@example.com" });
});

test("reconnecting after a refusal clears the rejected state", async () => {
  const now = 5_000_000;
  const local = storage({
    [CLOUD_SYNC_TOKEN_KEY]: "opaque-but-dead",
    [CLOUD_AUTH_PROFILE_KEY]: profile,
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  const service = new CloudAuthService({
    storage: local.adapter,
    now: () => now,
    requestHostedToken: async () => token(now + 3_600_000, "fresh-token"),
  });

  await service.markSessionRejected();
  expect(await service.status()).toMatchObject({ needsReconnect: true });

  expect(await service.connect()).toMatchObject({ connected: true, needsReconnect: false });
  expect(await service.getToken()).toBe("fresh-token");
});

test("a refused session is not resurrected by an unparseable stored token", async () => {
  const local = storage({
    [CLOUD_SYNC_TOKEN_KEY]: "opaque-but-dead",
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  const service = new CloudAuthService({
    storage: local.adapter,
    // A silent refresh is impossible without an interactive session.
    requestHostedToken: async () => {
      throw new Error("refresh unavailable");
    },
  });

  await service.markSessionRejected();

  // Even a forced refresh cannot revive it, and status must stay honest.
  expect(await service.getToken(true)).toBe("");
  expect(await service.status({ refresh: true })).toMatchObject({
    connected: false,
    needsReconnect: true,
  });
});

test("an explicit connect always asks the hosted page to confirm the account", async () => {
  // Logging out and back in must not silently reuse the previous account just
  // because a web session is still live in this browser.
  const requests: Array<{ interactive: boolean; selectAccount?: boolean }> = [];
  const now = 2_000_000;
  const local = storage();
  const service = new CloudAuthService({
    storage: local.adapter,
    now: () => now,
    requestHostedToken: async (request) => {
      requests.push({ interactive: request.interactive, selectAccount: request.selectAccount });
      return token(now + 3_600_000);
    },
  });

  await service.connect();
  expect(requests).toEqual([{ interactive: true, selectAccount: true }]);

  // Disconnect, then connect again: the chooser is requested every time.
  await service.disconnect();
  await service.connect();
  expect(requests).toEqual([
    { interactive: true, selectAccount: true },
    { interactive: true, selectAccount: true },
  ]);

  // Silent background refreshes must never pop a chooser at the user.
  await service.getToken(true);
  expect(requests.at(-1)).toMatchObject({ interactive: false });
  expect(requests.at(-1)?.selectAccount).not.toBe(true);
});

test("credentials never combine one account token with another account profile", async () => {
  const now = 1_000_000;
  let reads = 0;
  const account = (uid: string, tokenValue: string) => ({
    [CLOUD_SYNC_TOKEN_KEY]: tokenValue,
    [CLOUD_AUTH_EXPIRES_AT_KEY]: now + 60_000,
    [CLOUD_AUTH_PROFILE_KEY]: { ...profile, uid },
    [CLOUD_AUTH_OPT_IN_KEY]: true,
  });
  const service = new CloudAuthService({
    now: () => now,
    storage: {
      async get(keys: string | string[]) {
        reads += 1;
        const current = reads === 1
          ? account("user-1", "token-1")
          : account("user-2", "token-2");
        return Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((key) => key in current)
            .map((key) => [key, current[key as keyof typeof current]]),
        );
      },
      async set() {},
      async remove() {},
    },
  });

  expect(await service.getCredentials()).toEqual({ token: "", userId: "" });
});

test("Firebase expiry parsing accepts base64url JWT payloads and rejects opaque tokens", () => {
  const payload = btoa(JSON.stringify({ exp: 1234, sub: "firebase-user" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  expect(firebaseTokenExpiresAt(`header.${payload}.signature`)).toBe(1_234_000);
  expect(firebaseTokenUserId(`header.${payload}.signature`)).toBe("firebase-user");
  expect(firebaseTokenUserId("dev:local-user")).toBe("local-user");
  expect(firebaseTokenExpiresAt("opaque")).toBe(0);
});
