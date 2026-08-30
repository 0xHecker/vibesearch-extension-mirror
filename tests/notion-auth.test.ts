import { afterEach, beforeEach, expect, test } from "bun:test";

const localRows: Record<string, unknown> = {};
const launches: string[] = [];
let callbackStateOverride = "";
let brokerResponse: Record<string, unknown> = {
  accessToken: "notion-access",
  refreshToken: "notion-refresh",
  expiresIn: 3600,
  workspaceId: "workspace-a",
  workspaceName: "Personal",
};

const installChrome = () => {
  for (const key of Object.keys(localRows)) delete localRows[key];
  launches.length = 0;
  callbackStateOverride = "";
  brokerResponse = {
    accessToken: "notion-access",
    refreshToken: "notion-refresh",
    expiresIn: 3600,
    workspaceId: "workspace-a",
    workspaceName: "Personal",
  };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
    identity: {
      getRedirectURL: () => "https://heembgihcngbcadkkpcmkhhlldkidoph.chromiumapp.org/notion",
      launchWebAuthFlow: async ({ url }: { url: string }) => {
        launches.push(url);
        const state = new URL(url).searchParams.get("state") || "";
        return `https://heembgihcngbcadkkpcmkhhlldkidoph.chromiumapp.org/notion#handoff=one-time&state=${callbackStateOverride || state}`;
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: localRows[key] }),
        set: async (values: Record<string, unknown>) => Object.assign(localRows, values),
        remove: async (key: string) => {
          delete localRows[key];
        },
      },
    },
  };
};

const originalFetch = globalThis.fetch;
const notionAuth = await import("../src/services/notion-auth");

beforeEach(() => {
  installChrome();
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/notion/revoke")) return Response.json({ revoked: true });
    return Response.json(brokerResponse);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Notion connect validates state, persists the workspace, and reuses the token", async () => {
  const connected = await notionAuth.connectNotion();
  expect(connected).toEqual({
    connected: true,
    workspaceId: "workspace-a",
    workspaceName: "Personal",
  });
  expect(launches).toHaveLength(1);
  expect(new URL(launches[0]).pathname).toBe("/oauth/notion/start");
  expect(await notionAuth.getNotionAccessToken({ interactive: false })).toBe("notion-access");
  expect(launches).toHaveLength(1);
});

test("Notion accepts a documented long-lived token with no refresh token", async () => {
  brokerResponse = {
    accessToken: "long-lived-access",
    workspaceId: "workspace-a",
  };

  await notionAuth.connectNotion();
  expect(await notionAuth.getNotionAccessToken({ interactive: false }))
    .toBe("long-lived-access");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({
    connected: true,
    workspaceId: "workspace-a",
  });
});

test("Notion connect rejects a callback with a mismatched state", async () => {
  callbackStateOverride = "wrong_state_123456789";
  await expect(notionAuth.connectNotion()).rejects.toThrow("NOTION_AUTH_STATE_MISMATCH");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});

test("expired Notion access refreshes without opening another auth window", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "expired-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() - 1,
    workspaceId: "workspace-a",
  };
  brokerResponse = {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresIn: 3600,
  };

  await expect(notionAuth.getNotionAccessToken({ interactive: false })).resolves.toBe("fresh-access");
  expect(launches).toHaveLength(0);
});

test("a refresh response without a replacement refresh token retains the existing grant", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "expired-access",
    refreshToken: "rotating-refresh",
    expiresAt: Date.now() - 1,
  };
  brokerResponse = {
    accessToken: "fresh-access",
    expiresIn: 3600,
  };

  await expect(notionAuth.getNotionAccessToken({ interactive: false })).resolves.toBe("fresh-access");
  expect(localRows[notionAuth.__notionAuthTesting.storageKey]).toMatchObject({
    accessToken: "fresh-access",
    refreshToken: "rotating-refresh",
  });
});

test("a transient refresh failure preserves the local authorization for retry", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "expired-access",
    refreshToken: "still-valid-refresh",
    expiresAt: Date.now() - 1,
    workspaceId: "workspace-a",
  };
  globalThis.fetch = (async () => Response.json(
    { error: "NOTION_OAUTH_TIMEOUT" },
    { status: 504 },
  )) as typeof fetch;

  await expect(notionAuth.getNotionAccessToken({ interactive: false }))
    .rejects.toThrow("NOTION_OAUTH_TIMEOUT");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({
    connected: true,
    workspaceId: "workspace-a",
  });
  expect(launches).toHaveLength(0);
});

test("an invalid refresh grant clears the unusable local authorization", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "expired-access",
    refreshToken: "revoked-refresh",
    expiresAt: Date.now() - 1,
  };
  globalThis.fetch = (async () => Response.json(
    { error: "NOTION_OAUTH_PROVIDER_INVALID_GRANT" },
    { status: 400 },
  )) as typeof fetch;

  await expect(notionAuth.getNotionAccessToken({ interactive: false }))
    .rejects.toThrow("NOTION_NOT_CONNECTED");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});

test("a direct Notion 401 rotates once even before the stored access expiry", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "rejected-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() + 60 * 60 * 1_000,
  };
  brokerResponse = {
    accessToken: "fresh-access",
    refreshToken: "fresh-refresh",
    expiresIn: 3600,
  };
  const attemptedTokens: string[] = [];

  const result = await notionAuth.runWithNotionAccessToken(async (token) => {
    attemptedTokens.push(token);
    if (token === "rejected-access") throw new Error("NOTION_AUTH_EXPIRED");
    return "appended";
  }, { interactive: false });

  expect(result).toBe("appended");
  expect(attemptedTokens).toEqual(["rejected-access", "fresh-access"]);
  expect(launches).toHaveLength(0);
});

test("a rejected long-lived token disconnects when no refresh grant exists", async () => {
  localRows[notionAuth.__notionAuthTesting.storageKey] = {
    accessToken: "rejected-long-lived-access",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };

  await expect(notionAuth.runWithNotionAccessToken(async () => {
    throw new Error("NOTION_AUTH_EXPIRED");
  }, { interactive: false })).rejects.toThrow("NOTION_NOT_CONNECTED");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});

test("Notion disconnect clears local credentials even if remote revocation is best effort", async () => {
  await notionAuth.connectNotion();
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  await notionAuth.disconnectNotion();
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});

test("Notion disconnect asks the broker to revoke the access token", async () => {
  await notionAuth.connectNotion();
  let revokedToken = "";
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/oauth/notion/revoke")) {
      revokedToken = JSON.parse(String(init?.body)).token;
      return Response.json({ revoked: true });
    }
    return Response.json(brokerResponse);
  }) as typeof fetch;

  await notionAuth.disconnectNotion();
  expect(revokedToken).toBe("notion-access");
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});
