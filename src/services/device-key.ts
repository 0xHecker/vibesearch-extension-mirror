/**
 * Login-optional archive identity. A random per-install secret unlocks the
 * anonymous archive namespace on the API without any account. The secret is
 * generated locally, never synced, and never stored server-side — the API only
 * keeps archives under a hash of it. Connecting an account claims (copies) the
 * anonymous archives into the user's namespace.
 */

const DEVICE_KEY_STORAGE_KEY = "vibesearch:archiveDeviceKey";
const DEVICE_KEY_BYTES = 32;

const randomDeviceKey = (): string => {
  const bytes = new Uint8Array(DEVICE_KEY_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type DeviceKeyRow = Record<string, unknown>;

const readStoredKey = async (): Promise<string> => {
  try {
    const row = (await chrome.storage.local.get(DEVICE_KEY_STORAGE_KEY)) as DeviceKeyRow;
    const value = row[DEVICE_KEY_STORAGE_KEY];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
};

/** Stable per-install archive identity; created on first use. */
export const getArchiveDeviceKey = async (): Promise<string> => {
  const existing = await readStoredKey();
  if (existing) return existing;
  const created = randomDeviceKey();
  try {
    await chrome.storage.local.set({ [DEVICE_KEY_STORAGE_KEY]: created });
  } catch {}
  return created;
};

/** Test/reset helper — rotating the key orphans the previous anon namespace. */
export const resetArchiveDeviceKeyForTests = async (): Promise<void> => {
  try {
    await chrome.storage.local.remove(DEVICE_KEY_STORAGE_KEY);
  } catch {}
};
