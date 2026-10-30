import { legacyCloudEnabled } from "@src/services/extension-policy";
import { z } from "zod";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  BoundedOpfsCleanupBatch,
  mapWithConcurrencyStable,
  type OpfsFileIdentity,
  uploadOpfsFileToR2,
} from "@src/services/media-storage";
import { isOnline } from "@src/workers/background/network-state";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

export const OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME =
  "opfs-media-reconcile-continuation";
export const OPFS_MEDIA_RECONCILE_CURSOR_KEY =
  "vibesearch:opfsMediaReconcileCursor:v1";

const OPFS_PROMOTION_SCAN_PAGE_SIZE = 50;
const OPFS_PROMOTION_CLEANUP_FILES_PER_RUN = 700;

type OpfsMediaPromotionPage = {
  items: { id: string; media: NonNullable<ItemDocType["media"]> }[];
  nextCursor: string | null;
  hasMore: boolean;
  scannedCount: number;
};

const promoteOpfsMediaToR2 = async (): Promise<void> => {
  if (!await legacyCloudEnabled()) return;
  if (!isOnline()) return;
  let afterId = "";
  const cleanupBatch = new BoundedOpfsCleanupBatch(
    OPFS_PROMOTION_CLEANUP_FILES_PER_RUN,
  );

  try {
    while (isOnline()) {
      let page: OpfsMediaPromotionPage;
      try {
        page = await sendForwardedToOffscreen<OpfsMediaPromotionPage>({
          service: "items",
          type: "listItemsWithOpfsMedia",
          payload: {
            afterId,
            limit: OPFS_PROMOTION_SCAN_PAGE_SIZE,
          },
        });
      } catch (e) {
        console.error("[promoteOpfsMedia] list failed", e);
        return;
      }
      if (!page) return;

      for (const { id, media } of page.items || []) {
        if (!isOnline()) return;
        const promotions = (
          await mapWithConcurrencyStable(media || [], 2, async (entry) => {
            if (!entry?.opfsPath) return null;
            try {
              const uploaded = await uploadOpfsFileToR2(
                entry.opfsPath,
                entry.originalUrl,
              );
              if (!uploaded) return null;
              return {
                opfsPath: entry.opfsPath,
                s3Url: uploaded.r2Url,
                sourceIdentity: uploaded.sourceIdentity,
              };
            } catch (e) {
              console.error(
                "[promoteOpfsMedia] upload failed for",
                entry.opfsPath,
                e,
              );
              return null;
            }
          })
        ).filter(
          (
            promotion,
          ): promotion is {
            opfsPath: string;
            s3Url: string;
            sourceIdentity: OpfsFileIdentity;
          } => promotion !== null,
        );

        if (promotions.length === 0) continue;

        try {
          const result = await sendForwardedToOffscreen<{
            success: boolean;
            promotedOpfsPaths: string[];
            error?: string;
          }>({
            service: "items",
            type: "applyOpfsMediaPromotions",
            payload: { id, promotions },
          });
          if (!result?.success) {
            console.error(
              "[promoteOpfsMedia] conditional commit failed for",
              id,
              result?.error || "UNKNOWN_ERROR",
            );
            continue;
          }
          const promotionByPath = new Map(
            promotions.map(
              (promotion) => [promotion.opfsPath, promotion] as const,
            ),
          );
          for (const opfsPath of result.promotedOpfsPaths || []) {
            const promotion = promotionByPath.get(opfsPath);
            if (promotion) {
              cleanupBatch.add({
                opfsPath,
                sourceIdentity: promotion.sourceIdentity,
              });
            }
          }
        } catch (e) {
          console.error(
            "[promoteOpfsMedia] conditional commit failed for",
            id,
            e,
          );
        }
      }

      if (!page.hasMore) return;
      const nextCursor = (page.nextCursor || "").trim();
      if (!nextCursor || nextCursor <= afterId) {
        console.error("[promoteOpfsMedia] item scan cursor did not advance");
        return;
      }
      afterId = nextCursor;
    }
  } finally {
    try {
      await cleanupBatch.flush(async (files) => {
        await sendForwardedToOffscreen({
          service: "items",
          type: "deleteUnreferencedOpfsMedia",
          payload: { files },
        });
      });
      if (cleanupBatch.overflowed) {
        console.warn(
          "[promoteOpfsMedia] deferred excess OPFS cleanup to keep the run bounded",
        );
      }
    } catch (e) {
      // Promotion is durable already. Leave local files in place rather than
      // failing the run or deleting without a complete reference scan.
      console.warn("[promoteOpfsMedia] cleanup deferred", e);
    }
  }
};

let opfsPromotionInFlight: Promise<void> | null = null;
let opfsPromotionQueued = false;
export const triggerOpfsPromotion = (): Promise<void> => {
  if (!isOnline()) return Promise.resolve();
  opfsPromotionQueued = true;
  if (opfsPromotionInFlight) return opfsPromotionInFlight;

  const promotion = (async () => {
    while (opfsPromotionQueued && isOnline()) {
      opfsPromotionQueued = false;
      await promoteOpfsMediaToR2();
    }
  })()
    .catch((error) => console.error("[promoteOpfsMedia] error", error))
    .finally(() => {
      opfsPromotionInFlight = null;
    });
  opfsPromotionInFlight = promotion;
  return promotion;
};

let opfsMediaReconcileInFlight: Promise<void> | null = null;
export const reconcileOrphanedOpfsMedia = (): Promise<void> => {
  if (opfsMediaReconcileInFlight) return opfsMediaReconcileInFlight;
  const run = (async () => {
    const cursorState = await chrome.storage.local.get(
      OPFS_MEDIA_RECONCILE_CURSOR_KEY,
    );
    const parsedCursor = z
      .string()
      .safeParse(cursorState[OPFS_MEDIA_RECONCILE_CURSOR_KEY]);
    const afterId = parsedCursor.success ? parsedCursor.data : "";
    const result = await sendForwardedToOffscreen<{
      scanned: number;
      deleted: number;
      nextCursor: string | null;
      hasMore: boolean;
    }>({
      service: "items",
      type: "reconcileOrphanedOpfsItemDirectories",
      payload: { afterId, limit: 5_000 },
    });
    if (result.hasMore && result.nextCursor && result.nextCursor > afterId) {
      await chrome.storage.local.set({
        [OPFS_MEDIA_RECONCILE_CURSOR_KEY]: result.nextCursor,
      });
      await chrome.alarms.create(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME, {
        when: Date.now() + 1_000,
      });
      return;
    }
    await chrome.storage.local.remove(OPFS_MEDIA_RECONCILE_CURSOR_KEY);
    await chrome.alarms.clear(OPFS_MEDIA_RECONCILE_CONTINUATION_ALARM_NAME);
  })().finally(() => {
    opfsMediaReconcileInFlight = null;
  });
  opfsMediaReconcileInFlight = run;
  return run;
};
