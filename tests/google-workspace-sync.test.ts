import { expect, test } from "bun:test";
import {
  clearGoogleWorkspaceAuth,
  downloadGoogleWorkspaceBackupBlob,
  fetchWithTimeout,
  getGoogleDriveAccountId,
  googleOwnedBackupListQuery,
  googleSyncStateForAccount,
  googleSyncStateForAccountStore,
  isUsableOwnedGoogleBackupFile,
  listGoogleWorkspaceBackups,
  normalizeGoogleWorkspaceSyncStateStore,
  readBoundedResponseText,
  shouldUseGoogleResumableUpload,
  syncSnapshotFileToGoogleWorkspace,
  syncGoogleBackupTargets,
  upsertGoogleSyncStateForAccount,
} from "@src/services/google-workspace-sync";

type ChromeStore = Record<string, unknown>;

const installGoogleChromeHarness = (initialLocal: ChromeStore = {}) => {
  const local = { ...initialLocal };
  const session: ChromeStore = {};
  let clearAllCachedAuthTokensCalls = 0;
  const chromeStub = {
    identity: {
      getAuthToken: async () => ({ token: "drive-token" }),
      removeCachedAuthToken: async () => {},
      clearAllCachedAuthTokens: async () => {
        clearAllCachedAuthTokensCalls += 1;
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: local[key] }),
        set: async (values: ChromeStore) => Object.assign(local, values),
        remove: async (key: string) => {
          delete local[key];
        },
      },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (values: ChromeStore) => Object.assign(session, values),
        remove: async (key: string) => {
          delete session[key];
        },
      },
    },
  };
  (globalThis as typeof globalThis & { chrome: unknown }).chrome = chromeStub;
  return {
    local,
    session,
    get clearAllCachedAuthTokensCalls() {
      return clearAllCachedAuthTokensCalls;
    },
  };
};

const jsonResponse = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

test("Drive create and update dry-run stays bound to the verified Google account", async () => {
  const harness = installGoogleChromeHarness();
  const previousFetch = globalThis.fetch;
  const requests: Request[] = [];
  let uploadCount = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (url.pathname === "/drive/v3/about") {
      return jsonResponse({ user: { permissionId: "account-a" } });
    }
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      return jsonResponse({ files: [] });
    }
    if (url.pathname === "/drive/v3/files/drive-file" && request.method === "GET") {
      return jsonResponse({
        id: "drive-file",
        name: "vibesearch-export.json",
        mimeType: "application/json",
        ownedByMe: true,
        trashed: false,
        webViewLink: "https://drive.google.com/file/d/drive-file",
        appProperties: { vibesearchBackup: "library-v1" },
      });
    }
    if (url.pathname.startsWith("/upload/drive/v3/files")) {
      uploadCount += 1;
      return jsonResponse({
        id: "drive-file",
        webViewLink: "https://drive.google.com/file/d/drive-file",
      });
    }
    throw new Error(`Unexpected Google request: ${request.method} ${request.url}`);
  }) as typeof fetch;

  try {
    const first = await syncSnapshotFileToGoogleWorkspace(
      new Blob(["{\"schemaVersion\":1}"], { type: "application/json" }),
      { itemCount: 3, folderCount: 2 },
    );
    const second = await syncSnapshotFileToGoogleWorkspace(
      new Blob(["{\"schemaVersion\":1,\"updated\":true}"], { type: "application/json" }),
      { itemCount: 4, folderCount: 2 },
    );

    expect(first).toMatchObject({
      ok: true,
      accountId: "account-a",
      driveFileId: "drive-file",
      itemCount: 3,
    });
    expect(second).toMatchObject({
      ok: true,
      accountId: "account-a",
      driveFileId: "drive-file",
      itemCount: 4,
    });
    expect(uploadCount).toBe(2);
    expect(requests.filter((request) =>
      request.method === "POST" && request.url.includes("/upload/drive/v3/files?")
    )).toHaveLength(1);
    expect(requests.filter((request) =>
      request.method === "PATCH" && request.url.includes("/upload/drive/v3/files/drive-file?")
    )).toHaveLength(1);

    const stored = harness.local.vs_google_workspace_sync_v1 as {
      activeAccountId?: string;
      accounts?: Record<string, { driveFileId?: string; itemCount?: number }>;
    };
    expect(stored.activeAccountId).toBe("account-a");
    expect(stored.accounts?.["account-a"]).toMatchObject({
      driveFileId: "drive-file",
      itemCount: 4,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("large Drive create dry-run uses a bounded resumable session", async () => {
  installGoogleChromeHarness();
  const previousFetch = globalThis.fetch;
  const requests: Request[] = [];
  const byteSize = 5 * 1024 * 1024 + 1;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (url.pathname === "/drive/v3/about") {
      return jsonResponse({ user: { permissionId: "account-large" } });
    }
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      return jsonResponse({ files: [] });
    }
    if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
      return new Response("", {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload-session/vibesearch" },
      });
    }
    if (url.pathname === "/upload-session/vibesearch" && request.method === "PUT") {
      return jsonResponse({ id: "large-drive-file" });
    }
    throw new Error(`Unexpected Google request: ${request.method} ${request.url}`);
  }) as typeof fetch;

  try {
    await expect(syncSnapshotFileToGoogleWorkspace(
      new Blob([new Uint8Array(byteSize)], { type: "application/json" }),
      { itemCount: 1, folderCount: 0 },
    )).resolves.toMatchObject({
      ok: true,
      accountId: "account-large",
      driveFileId: "large-drive-file",
    });

    const initiation = requests.find((request) =>
      request.method === "POST" && request.url.includes("uploadType=resumable")
    );
    const upload = requests.find((request) =>
      request.method === "PUT" && request.url.includes("/upload-session/vibesearch")
    );
    expect(initiation?.headers.get("x-upload-content-length")).toBe(String(byteSize));
    expect(initiation?.headers.get("x-upload-content-type")).toBe(
      "application/json; charset=UTF-8",
    );
    expect(upload?.headers.get("authorization")).toBe("Bearer drive-token");
    expect(upload?.headers.get("content-type")).toBe("application/json; charset=UTF-8");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Drive upload rejects empty and oversized payloads before authentication or network I/O", async () => {
  const harness = installGoogleChromeHarness();
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network should not be reached");
  }) as typeof fetch;
  const oversized = new Blob(["oversized-test-double"]);
  Object.defineProperty(oversized, "size", { value: 64 * 1024 * 1024 + 1 });

  try {
    await expect(syncSnapshotFileToGoogleWorkspace(
      new Blob([]),
      { itemCount: 0, folderCount: 0 },
    )).rejects.toThrow("GOOGLE_BACKUP_TOO_LARGE");
    await expect(syncSnapshotFileToGoogleWorkspace(
      oversized,
      { itemCount: 0, folderCount: 0 },
    )).rejects.toThrow("GOOGLE_BACKUP_TOO_LARGE");
    expect(fetchCalls).toBe(0);
    expect(harness.local.vs_google_workspace_sync_v1).toBeUndefined();
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Drive list and download dry-run filters ownership and bounds restore input", async () => {
  installGoogleChromeHarness();
  const previousFetch = globalThis.fetch;
  const requests: Request[] = [];
  let oversizeDownload = false;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      return jsonResponse({
        files: [
          {
            id: "owned-file",
            name: "vibesearch-export.json",
            mimeType: "application/json",
            ownedByMe: true,
            trashed: false,
            modifiedTime: "2026-08-09T00:00:00.000Z",
            size: "24",
          },
          {
            id: "shared-file",
            name: "vibesearch-export.json",
            mimeType: "application/json",
            ownedByMe: false,
            trashed: false,
          },
        ],
      });
    }
    if (url.pathname === "/drive/v3/files/owned-file" && !url.searchParams.has("alt")) {
      return jsonResponse({
        id: "owned-file",
        name: "vibesearch-export.json",
        mimeType: "application/json",
        ownedByMe: true,
        trashed: false,
      });
    }
    if (url.pathname === "/drive/v3/files/owned-file" && url.searchParams.get("alt") === "media") {
      if (oversizeDownload) {
        return new Response("", {
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        });
      }
      return new Response('{"schemaVersion":1}', {
        headers: { "content-type": "application/json", "content-length": "19" },
      });
    }
    throw new Error(`Unexpected Google request: ${request.method} ${request.url}`);
  }) as typeof fetch;

  try {
    await expect(listGoogleWorkspaceBackups()).resolves.toEqual([{
      id: "owned-file",
      name: "vibesearch-export.json",
      modifiedTime: "2026-08-09T00:00:00.000Z",
      size: "24",
    }]);
    const blob = await downloadGoogleWorkspaceBackupBlob("owned-file");
    expect(await blob.text()).toBe('{"schemaVersion":1}');

    oversizeDownload = true;
    await expect(downloadGoogleWorkspaceBackupBlob("owned-file")).rejects.toThrow(
      "GOOGLE_BACKUP_TOO_LARGE",
    );
    expect(requests.some((request) => request.url.includes("alt=media"))).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Google disconnect clears active auth while retaining the account-bound Drive target", async () => {
  const harness = installGoogleChromeHarness({
    vs_google_workspace_sync_v1: {
      version: 2,
      activeAccountId: "account-a",
      accounts: {
        "account-a": {
          accountId: "account-a",
          driveFileId: "drive-file",
          lastSyncedAt: 100,
        },
      },
    },
  });

  await clearGoogleWorkspaceAuth();

  const stored = harness.local.vs_google_workspace_sync_v1 as {
    activeAccountId?: string;
    accounts?: Record<string, { driveFileId?: string }>;
  };
  expect(stored.activeAccountId).toBeUndefined();
  expect(stored.accounts?.["account-a"]?.driveFileId).toBe("drive-file");
  expect(harness.local["vibesearch:googleDisconnected:v1"]).toBe(true);
  expect(harness.clearAllCachedAuthTokensCalls).toBe(1);
});

test("Drive connection is verified against the account endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let request: Request | null = null;
  globalThis.fetch = (async (input, init) => {
    request = new Request(input, init);
    return Response.json({ user: { permissionId: "account-a" } });
  }) as typeof fetch;
  try {
    await expect(getGoogleDriveAccountId("drive-token")).resolves.toBe("account-a");
    expect(request?.url).toContain("/drive/v3/about");
    expect(request?.headers.get("authorization")).toBe("Bearer drive-token");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Drive backup succeeds without contacting any secondary document service", async () => {
  const calls: string[] = [];
  const result = await syncGoogleBackupTargets({
    syncDrive: async () => {
      calls.push("drive");
      return { id: "drive-file", webViewLink: "https://drive.google.com/file/d/drive-file" };
    },
  });

  expect(calls).toEqual(["drive"]);
  expect(result.driveFile.id).toBe("drive-file");
});

test("Drive target is durably recorded immediately after the upload", async () => {
  const calls: string[] = [];
  await syncGoogleBackupTargets({
    syncDrive: async () => {
      calls.push("drive");
      return { id: "drive-file" };
    },
    afterDrive: async () => {
      calls.push("persist-drive");
    },
  });

  expect(calls).toEqual(["drive", "persist-drive"]);
});

test("a Drive response without a file id cannot be reported as a successful backup", async () => {
  await expect(syncGoogleBackupTargets({
    syncDrive: async () => ({}),
  })).rejects.toThrow("GOOGLE_DRIVE_FILE_ID_MISSING");
});

test("sync targets are never reused for a different Google account", () => {
  const accountA = {
    accountId: "account-a",
    driveFileId: "drive-a",
  };
  expect(googleSyncStateForAccount(accountA, "account-a")).toEqual(accountA);
  expect(googleSyncStateForAccount(accountA, "account-b")).toEqual({ accountId: "account-b" });
});

test("Drive targets survive account switching without cross-account reuse", () => {
  let store = normalizeGoogleWorkspaceSyncStateStore({});
  store = upsertGoogleSyncStateForAccount(store, {
    accountId: "account-a",
    driveFileId: "drive-a",
    lastSyncedAt: 10,
  });
  store = upsertGoogleSyncStateForAccount(store, {
    accountId: "account-b",
    driveFileId: "drive-b",
    lastSyncedAt: 20,
  });

  expect(googleSyncStateForAccountStore(store, "account-a").driveFileId).toBe("drive-a");
  expect(googleSyncStateForAccountStore(store, "account-b").driveFileId).toBe("drive-b");
  expect(googleSyncStateForAccountStore(store, "account-c")).toEqual({ accountId: "account-c" });
});

test("legacy unbound targets stay quarantined until ownership can be verified", () => {
  const store = normalizeGoogleWorkspaceSyncStateStore({
    driveFileId: "legacy-drive-file",
    driveFileUrl: "https://drive.google.com/legacy",
  });

  expect(store.accounts).toEqual({});
  expect(store.legacy?.driveFileId).toBe("legacy-drive-file");
});

test("Drive backup discovery requires an owned live JSON file with the app marker", () => {
  const query = googleOwnedBackupListQuery({ requireMarker: true });
  expect(query).toContain("'me' in owners");
  expect(query).toContain("mimeType = 'application/json'");
  expect(query).toContain("appProperties has");
  expect(isUsableOwnedGoogleBackupFile({
    id: "owned",
    mimeType: "application/json",
    ownedByMe: true,
    trashed: false,
    appProperties: { vibesearchBackup: "library-v1" },
  }, { requireMarker: true })).toBe(true);
  expect(isUsableOwnedGoogleBackupFile({
    id: "shared",
    mimeType: "application/json",
    ownedByMe: false,
    trashed: false,
    appProperties: { vibesearchBackup: "library-v1" },
  }, { requireMarker: true })).toBe(false);
});

test("Drive uploads switch to resumable mode above the multipart safety limit", () => {
  expect(shouldUseGoogleResumableUpload(5 * 1024 * 1024)).toBe(false);
  expect(shouldUseGoogleResumableUpload(5 * 1024 * 1024 + 1)).toBe(true);
});

test("Google request timeout remains active while a response body is stalled", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
  }))) as typeof fetch;
  try {
    await expect(fetchWithTimeout(
      "https://www.googleapis.com/test",
      {},
      20,
      "GOOGLE_TEST_TIMEOUT",
      (response, signal) => readBoundedResponseText(response, signal, 1_024),
    )).rejects.toThrow("GOOGLE_TEST_TIMEOUT");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Google JSON/error response bodies are bounded before parsing", async () => {
  const controller = new AbortController();
  const response = new Response("x".repeat(32), {
    headers: { "content-length": "32" },
  });

  await expect(readBoundedResponseText(response, controller.signal, 16)).rejects.toThrow(
    "GOOGLE_API_RESPONSE_TOO_LARGE",
  );
});
