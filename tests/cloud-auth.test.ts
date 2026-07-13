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
    { interactive: true, forceRefresh: true },
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

test("opaque development tokens remain compatible with the bounded uploader", async () => {
  const local = storage({ [CLOUD_SYNC_TOKEN_KEY]: "test-token" });
  const service = new CloudAuthService({ storage: local.adapter });
  expect(await service.getToken()).toBe("test-token");
  expect(await service.status()).toMatchObject({ connected: true, optedIn: true });
});

test("Firebase expiry parsing accepts base64url JWT payloads and rejects opaque tokens", () => {
  const payload = btoa(JSON.stringify({ exp: 1234, sub: "firebase-user" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  expect(firebaseTokenExpiresAt(`header.${payload}.signature`)).toBe(1_234_000);
  expect(firebaseTokenUserId(`header.${payload}.signature`)).toBe("firebase-user");
  expect(firebaseTokenUserId("dev:local-user")).toBe("local-user");
  expect(firebaseTokenExpiresAt("opaque")).toBe(0);
});
