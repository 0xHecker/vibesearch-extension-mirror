import { z } from "zod";
import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  fetchWithTimeout,
  readBoundedResponseText,
} from "@src/services/google-workspace-sync";
import type { ShareSnapshotV1 } from "@src/services/share-snapshot";
import { validateSnapshot } from "@src/services/share-snapshot/codec";
import { forwardProcessingTriggerToOffscreen } from "@src/workers/background/processing-triggers";
import { scheduleContextMenuRefresh } from "@src/workers/background/context-menus";
import {
  isVibeShareUrl,
  normalizeHttpUrl,
} from "@src/workers/background/import-utils";
import { sendProcessStatus } from "@src/workers/background/process-status";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

const SHARE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const SHARE_SNAPSHOT_FETCH_TIMEOUT_MS = 60_000;
const ShareEnvelopeSchema = z.object({ snapshot: z.unknown() });

const SHARE_WORKER_JSON_BASE = "https://share-worker.shanmukh6789op.workers.dev";
const sharePairFromShareUrl = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    const viewer = pathname.match(/\/s\/([^/]+?)(?:\.json)?$/);
    if (viewer) return viewer[1];
    const api = pathname.match(
      /\/v1\/public-shares\/([^/]+?)(?:\/export\.json)?$/,
    );
    if (api) return api[1];
  } catch {
    // fall through to null
  }
  return null;
};
const fetchShareSnapshot = async (url: string): Promise<ShareSnapshotV1> => {
  const normalized = normalizeHttpUrl(url);
  if (!normalized || !isVibeShareUrl(normalized))
    throw new Error("INVALID_SHARE_URL");
  // A share link may point at the HTML viewer (e.g. share.watermelons.workers.dev)
  // or the worker. Either way, fetch the snapshot JSON from the worker's export
  // endpoint instead of the viewer's HTML page.
  const pair = sharePairFromShareUrl(normalized);
  const fetchUrl = pair
    ? `${SHARE_WORKER_JSON_BASE}/s/${pair}.json`
    : normalized;
  return fetchWithTimeout(
    fetchUrl,
    {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    },
    SHARE_SNAPSHOT_FETCH_TIMEOUT_MS,
    "SHARE_FETCH_TIMEOUT",
    async (response, signal) => {
      if (!response.ok)
        throw new Error(`SHARE_FETCH_FAILED_${response.status}`);
      let text: string;
      try {
        text = await readBoundedResponseText(
          response,
          signal,
          SHARE_SNAPSHOT_MAX_BYTES,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "GOOGLE_API_RESPONSE_TOO_LARGE"
        ) {
          throw new Error("SHARE_SNAPSHOT_TOO_LARGE");
        }
        throw error;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("SHARE_SNAPSHOT_INVALID_JSON");
      }
      try {
        return validateSnapshot(body);
      } catch {
        const envelope = ShareEnvelopeSchema.safeParse(body);
        if (!envelope.success) throw new Error("SHARE_SNAPSHOT_MISSING");
        return validateSnapshot(envelope.data.snapshot);
      }
    },
  );
};
export const importSharedLink = async (
  url: string,
  targetSpaceId = PUBLIC_SPACE_ID,
) => {
  const jobId = `share-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sendProcessStatus(
    jobId,
    "Shared link import",
    "processing",
    "Fetching shared snapshot...",
  );
  const snapshot = await fetchShareSnapshot(url);
  sendProcessStatus(
    jobId,
    "Shared link import",
    "processing",
    `Importing ${snapshot.items.length} items...`,
  );
  const result = await sendForwardedToOffscreen({
    service: "dbManager",
    type: "importSharedSnapshot",
    payload: {
      snapshot,
      targetSpaceId,
      rootFolderName: snapshot.title,
    },
  });
  await forwardProcessingTriggerToOffscreen("TRIGGER_EMBEDDING").catch(
    () => {},
  );
  scheduleContextMenuRefresh("high");
  sendProcessStatus(
    jobId,
    "Shared link import",
    "success",
    `Imported ${snapshot.items.length} items.`,
  );
  return result;
};
