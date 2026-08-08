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

test("Notion disconnect clears local credentials even if remote revocation is best effort", async () => {
  await notionAuth.connectNotion();
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  await notionAuth.disconnectNotion();
  expect(await notionAuth.getNotionConnectionStatus()).toEqual({ connected: false });
});
