import { z } from "zod";
import { assertCloudConnectionCurrent, CloudConnectionRetiredError, getArchiveCloudConnection } from "./cloud-connection";
import { legacyCloudEnabled } from "./extension-policy";

const claimResponseSchema = z.object({ imported: z.number().int().nonnegative().optional() });

export const claimAnonymousArchives = async (): Promise<void> => {
  if (!await legacyCloudEnabled()) return;
  try {
    const connection = await getArchiveCloudConnection();
    const { token, deviceKey, apiBase } = connection;
    if (!token || !deviceKey) return;
    await assertCloudConnectionCurrent(connection);
    const response = await fetch(`${apiBase}/v1/archives/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-vs-device-key": deviceKey },
      credentials: "omit", cache: "no-store",
    });
    try { await assertCloudConnectionCurrent(connection); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.warn("[archive] anon claim failed", response.status);
      return;
    }
    const parsed = claimResponseSchema.safeParse(await response.json());
    await assertCloudConnectionCurrent(connection);
    if (parsed.success && parsed.data.imported) {
      console.info(`[archive] claimed ${parsed.data.imported} device archive(s) into account`);
      void chrome.runtime.sendMessage({ type: "DB_CHANGE", scope: "items" }).catch(() => undefined);
    }
  } catch (cause) {
    if (cause instanceof CloudConnectionRetiredError) return;
    console.warn("[archive] anon claim skipped", cause);
  }
};
