import { expect, test } from "bun:test";
import {
  fetchWithTimeout,
  getGoogleDriveAccountId,
  googleOwnedBackupListQuery,
  googleSyncStateForAccount,
  googleSyncStateForAccountStore,
  isUsableOwnedGoogleBackupFile,
  normalizeGoogleWorkspaceSyncStateStore,
  readBoundedResponseText,
  shouldUseGoogleResumableUpload,
  syncGoogleBackupTargets,
  upsertGoogleSyncStateForAccount,
} from "@src/services/google-workspace-sync";

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
