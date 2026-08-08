import { beforeEach, expect, test } from "bun:test";

type SessionStore = Record<string, unknown>;

const createChromeStub = () => {
  const session: SessionStore = {};
  const local: SessionStore = {};
  const launches: Array<{ url: string; interactive: boolean }> = [];
  let wrongState = false;
  let launchError: Error | null = null;
  const identity = {
    getAuthToken: async () => {
      throw new Error("OAuth client not configured");
    },
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
    getRedirectURL: () =>
      "https://79b931bae05b4f7fe17cea71d798bae59d4b81d5.extensions.allizom.org/google",
    launchWebAuthFlow: async ({ url, interactive }: { url: string; interactive: boolean }) => {
      launches.push({ url, interactive });
      if (launchError) throw launchError;
      const request = new URL(url);
      const redirectUri = request.searchParams.get("redirect_uri") || "";
      const state = wrongState ? "wrong-state" : request.searchParams.get("state") || "";
      return `${redirectUri}#access_token=test-token&expires_in=3600&scope=scope-a&state=${state}`;
    },
  };
  const storageSession = {
    get: async (key: string) => ({ [key]: session[key] }),
    set: async (values: SessionStore) => Object.assign(session, values),
    remove: async (key: string) => {
      delete session[key];
    },
  };
  const storageLocal = {
    get: async (key: string) => ({ [key]: local[key] }),
    set: async (values: SessionStore) => Object.assign(local, values),
    remove: async (key: string) => {
      delete local[key];
    },
  };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    identity,
    storage: { session: storageSession, local: storageLocal },
  };
  return {
    launches,
    setWrongState(value: boolean) {
      wrongState = value;
    },
    setLaunchError(error: Error | null) {
      launchError = error;
    },
  };
};

const chromeAuth = await import("../src/services/google-auth");
const firefoxAuth = await import("../src/services/google-auth.firefox");

test("Google backup requests only the app-created Drive-file scope", () => {
  expect(chromeAuth.GOOGLE_WORKSPACE_SCOPES).toEqual([
    "https://www.googleapis.com/auth/drive.file",
  ]);
  expect(firefoxAuth.GOOGLE_WORKSPACE_SCOPES).toEqual([
    "https://www.googleapis.com/auth/drive.file",
  ]);
});

beforeEach(async () => {
  createChromeStub();
  await chromeAuth.clearGoogleAccessToken();
  await firefoxAuth.clearGoogleAccessToken();
});

test("Chrome web fallback uses prompt=none for probes and reuses its session token", async () => {
  const harness = createChromeStub();
  await chromeAuth.clearGoogleAccessToken();

  await expect(chromeAuth.getGoogleAccessToken(false)).resolves.toMatchObject({ token: "test-token" });
  await expect(chromeAuth.getGoogleAccessToken(false)).resolves.toMatchObject({ token: "test-token" });

  expect(harness.launches).toHaveLength(1);
  const request = new URL(harness.launches[0].url);
  expect(request.searchParams.get("prompt")).toBe("none");
  expect(request.searchParams.get("state")).toBeTruthy();
  expect(harness.launches[0].interactive).toBe(false);
});

test("web OAuth rejects a callback whose state nonce does not match", async () => {
  const harness = createChromeStub();
  harness.setWrongState(true);
  await chromeAuth.clearGoogleAccessToken();

  await expect(chromeAuth.getGoogleAccessToken(true)).rejects.toThrow("GOOGLE_AUTH_STATE_MISMATCH");
});

test("interactive Chrome fallback selects an account without forcing repeat consent", async () => {
  const harness = createChromeStub();
  await chromeAuth.clearGoogleAccessToken();

  await expect(chromeAuth.getGoogleAccessToken(true)).resolves.toMatchObject({ token: "test-token" });

  expect(harness.launches).toHaveLength(1);
  expect(new URL(harness.launches[0].url).searchParams.get("prompt")).toBe("select_account");
});

test("Firefox uses the provider-compatible loopback redirect and an ephemeral shared token cache", async () => {
  const harness = createChromeStub();
  await firefoxAuth.clearGoogleAccessToken();

  await expect(firefoxAuth.getGoogleAccessToken(false)).resolves.toMatchObject({ token: "test-token" });
  await expect(firefoxAuth.getGoogleAccessToken(false)).resolves.toMatchObject({ token: "test-token" });

  expect(harness.launches).toHaveLength(1);
  const request = new URL(harness.launches[0].url);
  expect(request.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1/mozoauth2/79b931bae05b4f7fe17cea71d798bae59d4b81d5",
  );
  expect(request.searchParams.get("prompt")).toBe("none");
  expect(harness.launches[0].interactive).toBe(false);

  await firefoxAuth.clearGoogleAccessToken();
  await firefoxAuth.getGoogleAccessToken(true);
  expect(harness.launches).toHaveLength(2);
  expect(new URL(harness.launches[1].url).searchParams.get("prompt")).toBe("consent");
});

test("explicit disconnect blocks silent provider reauthentication until Connect is clicked", async () => {
  const harness = createChromeStub();
  const { setGoogleWorkspaceExplicitlyDisconnected } = await import("../src/services/google-oauth-config");
  await chromeAuth.clearGoogleAccessToken();
  await setGoogleWorkspaceExplicitlyDisconnected(true);

  await expect(chromeAuth.getGoogleAccessToken(false)).rejects.toThrow("GOOGLE_ACCOUNT_DISCONNECTED");
  expect(harness.launches).toHaveLength(0);

  await expect(chromeAuth.getGoogleAccessToken(true)).resolves.toMatchObject({ token: "test-token" });
  expect(harness.launches).toHaveLength(1);
});

test("a cancelled Connect attempt keeps silent reauthentication disabled", async () => {
  const harness = createChromeStub();
  const { setGoogleWorkspaceExplicitlyDisconnected } = await import("../src/services/google-oauth-config");
  await chromeAuth.clearGoogleAccessToken();
  await setGoogleWorkspaceExplicitlyDisconnected(true);
  harness.setLaunchError(new Error("GOOGLE_AUTH_CANCELLED"));

  await expect(chromeAuth.getGoogleAccessToken(true)).rejects.toThrow("GOOGLE_AUTH_CANCELLED");
  harness.setLaunchError(null);
  await expect(chromeAuth.getGoogleAccessToken(false)).rejects.toThrow("GOOGLE_ACCOUNT_DISCONNECTED");
  expect(harness.launches).toHaveLength(1);
});
