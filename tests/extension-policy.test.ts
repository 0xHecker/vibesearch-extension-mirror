import { expect, spyOn, test } from "bun:test";
import { CloudSyncService, CLOUD_SYNC_QUEUE_KEY, CLOUD_SYNC_TOKEN_KEY } from "@src/services/cloud-sync";
import { embeddingService } from "@src/services/embedding.service";
import { EmbeddingWorkerClient } from "@src/services/embedding-worker-client";
import {
  DEFAULT_EXTENSION_POLICY, EXTENSION_POLICY_KEY, legacyBrowserEnabled, legacyCloudEnabled,
  parseExtensionPolicy, readExtensionPolicy, requireLegacyBrowser, requireLegacyCloud,
  writeExtensionPolicy, type ExtensionPolicy,
} from "@src/services/extension-policy";

const browserPolicy: ExtensionPolicy = { version: 1, mode: "legacy-browser", legacyCloudEnabled: true };
const localPolicy: ExtensionPolicy = { version: 1, mode: "local-only", legacyCloudEnabled: false };

function profileStorage(upgraded = false, readError?: Error) {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new Map<string, unknown>();
  if (upgraded) {
    storage.set(CLOUD_SYNC_TOKEN_KEY, "synthetic-stored-token");
    storage.set(CLOUD_SYNC_QUEUE_KEY, [{ collection: "items", id: "old", updatedAt: 1, deletedAt: 0, queuedAt: 1 }]);
    storage.set("old-opfs-manifest", { file: "preserved" });
  }
  let writes = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: {
      get: async (key: string) => {
        if (readError) throw readError;
        return { [key]: storage.get(key) };
      },
      set: async (value: Record<string, unknown>) => {
        writes++;
        for (const [key, entry] of Object.entries(value)) storage.set(key, entry);
      },
    } } },
  });
  return {
    storage,
    writes: () => writes,
    restore: () => {
      if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
      else Reflect.deleteProperty(globalThis, "chrome");
    },
  };
}

function cloudProbe() {
  let credentials = 0;
  let fetches = 0;
  const service = new CloudSyncService({
    getCredentials: async () => { credentials++; return { token: "", userId: "" }; },
    fetcher: async () => { fetches++; throw new Error("Network is forbidden in this test"); },
  });
  return { service, counts: () => ({ credentials, fetches }) };
}

test("missing policy preserves browser/cloud eligibility and upgraded credentials and pending work", async () => {
  for (const upgraded of [false, true]) {
    const profile = profileStorage(upgraded);
    const before = structuredClone(Array.from(profile.storage));
    const probe = cloudProbe();
    try {
      expect(DEFAULT_EXTENSION_POLICY).toEqual(browserPolicy);
      expect(parseExtensionPolicy(undefined)).toEqual(browserPolicy);
      expect(await readExtensionPolicy()).toEqual(browserPolicy);
      expect(await legacyBrowserEnabled()).toBe(true);
      expect(await legacyCloudEnabled()).toBe(true);
      await requireLegacyBrowser();
      await requireLegacyCloud();
      await expect(probe.service.syncAll()).rejects.toThrow("CLOUD_SYNC_AUTH_REQUIRED");
      expect(probe.counts()).toEqual({ credentials: 1, fetches: 0 });
      expect(profile.writes()).toBe(0);
      expect(Array.from(profile.storage)).toEqual(before);
      expect(profile.storage.has(EXTENSION_POLICY_KEY)).toBe(false);
    } finally { profile.restore(); }
  }
});

test("explicit local-only choice stops cloud before credentials/fetch and models before the worker", async () => {
  const profile = profileStorage(true);
  const probe = cloudProbe();
  const embed = spyOn(EmbeddingWorkerClient.prototype, "embed").mockResolvedValue(new Float32Array());
  try {
    const existingData = structuredClone(Array.from(profile.storage));
    await writeExtensionPolicy(localPolicy);
    const before = structuredClone(Array.from(profile.storage));
    expect(await readExtensionPolicy()).toEqual(localPolicy);
    expect(await legacyBrowserEnabled()).toBe(false);
    expect(await legacyCloudEnabled()).toBe(false);
    await expect(probe.service.drain()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(probe.service.pull()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(probe.service.syncAll()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(probe.service.enqueueDocs({ items: [] })).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(probe.service.pushItem("saved-item")).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(embeddingService.generateEmbeddings({ sentences: ["old queued text"] })).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
    expect(embed).toHaveBeenCalledTimes(0);
    expect(probe.counts()).toEqual({ credentials: 0, fetches: 0 });
    expect(profile.writes()).toBe(1);
    expect(Array.from(profile.storage)).toEqual(before);
    expect(Array.from(profile.storage).filter(([key]) => key !== EXTENSION_POLICY_KEY)).toEqual(existingData);
  } finally { embed.mockRestore(); profile.restore(); }
});

test("an explicit browser choice retains its cloud opt-out", async () => {
  const profile = profileStorage(true);
  try {
    const policy: ExtensionPolicy = { version: 1, mode: "legacy-browser", legacyCloudEnabled: false };
    await writeExtensionPolicy(policy);
    expect(await readExtensionPolicy()).toEqual(policy);
    await requireLegacyBrowser();
    await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    expect(parseExtensionPolicy({ version: 1, mode: "legacy-browser" })).toEqual(policy);
  } finally { profile.restore(); }
});

test("corrupt and future policies stop cloud/models without rewriting stored data", async () => {
  const invalidPolicies = [
    null, "legacy-browser", [], { mode: "legacy-browser" },
    { version: 2, mode: "legacy-browser", legacyCloudEnabled: true },
    { version: 1, mode: "unknown", legacyCloudEnabled: true },
    { version: 1, mode: "legacy-browser", legacyCloudEnabled: "true" },
    { ...browserPolicy, unsupported: true },
  ];
  const embed = spyOn(EmbeddingWorkerClient.prototype, "embed").mockResolvedValue(new Float32Array());
  try {
    for (const value of invalidPolicies) {
      const profile = profileStorage(true);
      profile.storage.set(EXTENSION_POLICY_KEY, value);
      const before = structuredClone(Array.from(profile.storage));
      const probe = cloudProbe();
      try {
        expect(parseExtensionPolicy(value)).toEqual(localPolicy);
        expect(await readExtensionPolicy()).toEqual(localPolicy);
        await expect(requireLegacyBrowser()).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
        await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
        await expect(probe.service.syncAll()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
        await expect(embeddingService.generateEmbeddings({ sentences: ["saved text"] })).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
        expect(probe.counts()).toEqual({ credentials: 0, fetches: 0 });
        expect(profile.writes()).toBe(0);
        expect(Array.from(profile.storage)).toEqual(before);
      } finally { profile.restore(); }
    }
    expect(embed).toHaveBeenCalledTimes(0);
  } finally { embed.mockRestore(); }
});

test("unreadable storage fails closed before credential/fetch and worker access", async () => {
  const profile = profileStorage(true, new Error("Storage unavailable"));
  const before = structuredClone(Array.from(profile.storage));
  const probe = cloudProbe();
  const embed = spyOn(EmbeddingWorkerClient.prototype, "embed").mockResolvedValue(new Float32Array());
  try {
    expect(await readExtensionPolicy()).toEqual(localPolicy);
    await expect(requireLegacyBrowser()).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
    await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(probe.service.syncAll()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    await expect(embeddingService.generateEmbeddings({ sentences: ["saved text"] })).rejects.toThrow("LOCAL_ONLY_LEGACY_DISABLED");
    expect(embed).toHaveBeenCalledTimes(0);
    expect(probe.counts()).toEqual({ credentials: 0, fetches: 0 });
    expect(profile.writes()).toBe(0);
    expect(Array.from(profile.storage)).toEqual(before);
  } finally { embed.mockRestore(); profile.restore(); }
});

test("offscreen policy reads use the background authority and preserve its cloud opt-out", async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let policy: ExtensionPolicy = browserPolicy;
  const requests: unknown[] = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: {
    sendMessage: async (message: unknown) => {
      requests.push(message);
      return { success: true, payload: policy };
    },
  } } });
  try {
    expect(await readExtensionPolicy()).toEqual(browserPolicy);
    await requireLegacyCloud();
    policy = { version: 1, mode: "legacy-browser", legacyCloudEnabled: false };
    expect(await readExtensionPolicy()).toEqual(policy);
    await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    expect(requests).toEqual(Array.from({ length: 4 }, () => ({ target: "background", type: "EXTENSION_POLICY_READ" })));
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("offscreen malformed or failed policy authority cannot opt into legacy cloud", async () => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let response: unknown;
  let failure = false;
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: {
    sendMessage: async () => {
      if (failure) throw new Error("Background unavailable");
      return response;
    },
  } } });
  try {
    for (const malformed of [undefined, null, { success: false }, { success: true },
      { success: true, payload: { version: 2, mode: "legacy-browser", legacyCloudEnabled: true } }]) {
      response = malformed;
      expect(await readExtensionPolicy()).toEqual(localPolicy);
      await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
    }
    failure = true;
    expect(await readExtensionPolicy()).toEqual(localPolicy);
    await expect(requireLegacyCloud()).rejects.toThrow("LOCAL_ONLY_CLOUD_DISABLED");
  } finally {
    if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
