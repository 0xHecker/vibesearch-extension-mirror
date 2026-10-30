import { getCloudAuthConnection, type CloudConnectionLifetime } from "./cloud-auth";
import { CLOUD_SYNC_API_BASE_KEY, resolveVibeSearchApiBase } from "./cloud-config";
import { getArchiveDeviceKey } from "./device-key";
import { requireLegacyCloud } from "./extension-policy";

export class CloudConnectionRetiredError extends Error {
  constructor() { super("CLOUD_CONNECTION_RETIRED"); this.name = "CloudConnectionRetiredError"; }
}

export const assertCloudConnectionCurrent = async (connection: CloudConnectionLifetime): Promise<void> => {
  if (connection.isCurrent?.() === false) throw new CloudConnectionRetiredError();
  await requireLegacyCloud();
  if (connection.isCurrent?.() === false || await connection.validate?.() === false || connection.isCurrent?.() === false) {
    throw new CloudConnectionRetiredError();
  }
};

export const getArchiveCloudConnection = async (forceRefresh = false) => {
  const [row, connection, deviceKey] = await Promise.all([
    chrome.storage.local.get(CLOUD_SYNC_API_BASE_KEY),
    getCloudAuthConnection(forceRefresh),
    getArchiveDeviceKey(),
  ]);
  const configured = typeof row[CLOUD_SYNC_API_BASE_KEY] === "string" ? row[CLOUD_SYNC_API_BASE_KEY].trim() : "";
  return { ...connection, deviceKey, apiBase: resolveVibeSearchApiBase(configured) };
};
