import { nextBinMutationTimestamp } from "@src/common/bin";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  assertSpaceUnlocked,
  isWriteConflict,
  notifyDatabaseChanged,
} from "@src/services/items/runtime";
import type { MyDatabase } from "@src/services/DatabaseService";
import { withEntityMutationLock } from "@src/services/entity-mutation-lock";
import {
  listOpfsMediaItemDirectoryIds,
  opfsFileIdentitiesEqual,
  readOpfsFileIdentity,
  withOpfsMutationLock,
  type OpfsFileIdentity,
} from "@src/services/media-storage";
import {
  deleteUnreferencedOpfsFiles,
  deleteUnreferencedOpfsItemDirectories,
} from "@src/services/opfs-media-lifecycle";
import { readIdKeysetPage } from "@src/services/rxdb-keyset-pagination";
import { spaceSessionService } from "@src/services/space-session.service";
import { z } from "zod";

type ItemMedia = NonNullable<ItemDocType["media"]>;

export type ItemOpfsMediaOptions = {
  readOpfsFileIdentity?: typeof readOpfsFileIdentity;
};

export type ListItemsWithOpfsMediaPayload = {
  afterId?: string;
  limit?: number;
};

export type OpfsMediaItem = {
  id: string;
  media: ItemMedia;
};

export type ListItemsWithOpfsMediaResult = {
  items: OpfsMediaItem[];
  nextCursor: string | null;
  hasMore: boolean;
  scannedCount: number;
};

export type ApplyOpfsMediaPromotionsPayload = {
  id: string;
  promotions: {
    opfsPath: string;
    s3Url: string;
    sourceIdentity: OpfsFileIdentity;
  }[];
};

export type ApplyOpfsMediaPromotionsResult = {
  success: boolean;
  promotedOpfsPaths: string[];
  error?: string;
};

export type DeleteUnreferencedOpfsMediaPayload = {
  files: { opfsPath: string; sourceIdentity: OpfsFileIdentity }[];
};

export type DeleteUnreferencedOpfsMediaResult = {
  deletedOpfsPaths: string[];
};

export type ReconcileOrphanedOpfsPayload = {
  afterId?: string;
  limit?: number;
};

export type ReconcileOrphanedOpfsResult = {
  scanned: number;
  deleted: number;
  nextCursor: string | null;
  hasMore: boolean;
};

type ValidPromotion = {
  opfsPath: string;
  s3Url: string;
  sourceIdentity: OpfsFileIdentity;
};

type AppliedPromotions = {
  media: ItemMedia;
  appliedPaths: Set<string>;
};

const opfsIdentitySchema = z.object({
  size: z.number().finite(),
  lastModified: z.number().finite(),
  sampleSha256: z.string().min(1),
});

const promotionSchema = z.object({
  opfsPath: z.string().min(1),
  s3Url: z.string().trim().min(1),
  sourceIdentity: opfsIdentitySchema,
});

const deletionCandidateSchema = z.object({
  opfsPath: z.string().min(1),
  sourceIdentity: opfsIdentitySchema,
});

function parsePromotions(
  promotions: ApplyOpfsMediaPromotionsPayload["promotions"],
): Map<string, ValidPromotion> {
  const parsedByPath = new Map<string, ValidPromotion>();
  for (const candidate of promotions) {
    const parsed = promotionSchema.safeParse(candidate);
    if (parsed.success) parsedByPath.set(parsed.data.opfsPath, parsed.data);
  }
  return parsedByPath;
}

export async function listItemsWithOpfsMedia(
  db: MyDatabase,
  payload: ListItemsWithOpfsMediaPayload = {},
): Promise<ListItemsWithOpfsMediaResult> {
  const requestedLimit = payload.limit ?? 50;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
    : 50;
  const page = await readIdKeysetPage({
    collection: db.items,
    selector: { deletedAt: { $eq: 0 } },
    pageSize: limit,
    afterId: (payload.afterId || "").trim(),
  });

  const items: OpfsMediaItem[] = [];
  for (const document of page.documents) {
    const media = document.get("media") || [];
    if (!media.some((entry: ItemMedia[number]) => Boolean(entry.opfsPath))) continue;
    const spaceId = document.get("spaceId") || PUBLIC_SPACE_ID;
    if (spaceId === PRIVATE_SPACE_ID && !spaceSessionService.isUnlocked(PRIVATE_SPACE_ID)) {
      continue;
    }
    items.push({ id: document.primary, media });
  }
  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    scannedCount: page.documents.length,
  };
}

function applyVerifiedPromotions(
  media: ItemMedia,
  verifiedByPath: ReadonlyMap<string, string>,
): AppliedPromotions {
  const appliedPaths = new Set<string>();
  const nextMedia = media.map((entry) => {
    const opfsPath = entry.opfsPath || "";
    const s3Url = verifiedByPath.get(opfsPath);
    if (!s3Url) return entry;
    appliedPaths.add(opfsPath);
    const { opfsPath: _localPath, ...entryWithoutLocalPath } = entry;
    const uploadedEntry: ItemMedia[number] = {
      ...entryWithoutLocalPath,
      s3Url,
      storageType: "s3",
    };
    return uploadedEntry;
  });
  return { media: nextMedia, appliedPaths };
}

async function verifyOwnedPromotions(
  media: ItemMedia,
  promotionsByPath: ReadonlyMap<string, ValidPromotion>,
  readIdentity: typeof readOpfsFileIdentity,
): Promise<Map<string, string>> {
  const verifiedByPath = new Map<string, string>();
  const currentPaths = new Set(media.flatMap((entry) => entry.opfsPath ? [entry.opfsPath] : []));
  for (const opfsPath of currentPaths) {
    const promotion = promotionsByPath.get(opfsPath);
    if (!promotion) continue;
    const currentIdentity = await readIdentity(opfsPath);
    if (opfsFileIdentitiesEqual(currentIdentity, promotion.sourceIdentity)) {
      verifiedByPath.set(opfsPath, promotion.s3Url);
    }
  }
  return verifiedByPath;
}

export async function applyOpfsMediaPromotions(
  db: MyDatabase,
  payload: ApplyOpfsMediaPromotionsPayload,
  options: ItemOpfsMediaOptions = {},
): Promise<ApplyOpfsMediaPromotionsResult> {
  const itemId = payload.id.trim();
  if (!itemId) return { success: false, promotedOpfsPaths: [], error: "NOT_FOUND" };
  const promotionsByPath = parsePromotions(payload.promotions);
  if (promotionsByPath.size === 0) {
    return { success: true, promotedOpfsPaths: [] };
  }
  const readIdentity = options.readOpfsFileIdentity ?? readOpfsFileIdentity;

  return withEntityMutationLock(db, "item", itemId, () =>
    withOpfsMutationLock(async () => {
      const maxAttempts = 5;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const document = await db.items.findOne(itemId).exec();
        if (!document) {
          return { success: false, promotedOpfsPaths: [], error: "NOT_FOUND" };
        }

        const current = document.toMutableJSON();
        assertSpaceUnlocked(current.spaceId || PUBLIC_SPACE_ID);
        if (current.deletedAt > 0) {
          return { success: false, promotedOpfsPaths: [], error: "ITEM_NOT_LIVE" };
        }

        const verifiedByPath = await verifyOwnedPromotions(
          current.media || [],
          promotionsByPath,
          readIdentity,
        );
        const applied = applyVerifiedPromotions(current.media || [], verifiedByPath);
        if (applied.appliedPaths.size === 0) {
          return { success: true, promotedOpfsPaths: [] };
        }

        const displayImageUrl = applied.media.find((entry) => entry.type === "image")?.s3Url ||
          applied.media.find((entry) => entry.type === "image")?.originalUrl;
        const patch: Partial<ItemDocType> = {
          media: applied.media,
          updatedAt: nextBinMutationTimestamp(
            Date.now(),
            current.updatedAt,
            current.deletedAt,
          ),
          isDirty: true,
        };
        if (displayImageUrl) patch.displayImageUrl = displayImageUrl;

        try {
          await document.patch(patch);
          notifyDatabaseChanged("items");
          return {
            success: true,
            promotedOpfsPaths: Array.from(applied.appliedPaths),
          };
        } catch (error) {
          if (!isWriteConflict(error)) throw error;
        }
      }
      return { success: false, promotedOpfsPaths: [], error: "CONFLICT" };
    }),
  );
}

export async function deleteUnreferencedOpfsMedia(
  db: MyDatabase,
  payload: DeleteUnreferencedOpfsMediaPayload,
): Promise<DeleteUnreferencedOpfsMediaResult> {
  const files = payload.files.flatMap((candidate) => {
    const parsed = deletionCandidateSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  const deletedOpfsPaths = await deleteUnreferencedOpfsFiles(
    db,
    files.map((file) => ({
      opfsPath: file.opfsPath,
      expectedIdentity: file.sourceIdentity,
    })),
  );
  return { deletedOpfsPaths };
}

export async function reconcileOrphanedOpfsItemDirectories(
  db: MyDatabase,
  payload: ReconcileOrphanedOpfsPayload = {},
): Promise<ReconcileOrphanedOpfsResult> {
  const afterId = payload.afterId || "";
  const requestedLimit = payload.limit ?? 1_000;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(5_000, Math.floor(requestedLimit)))
    : 1_000;
  const allIds = await listOpfsMediaItemDirectoryIds();
  const firstIndex = afterId ? allIds.findIndex((id) => id > afterId) : 0;
  const startIndex = firstIndex < 0 ? allIds.length : firstIndex;
  const itemIds = allIds.slice(startIndex, startIndex + limit);
  const deletedIds = await deleteUnreferencedOpfsItemDirectories(db, itemIds);
  return {
    scanned: itemIds.length,
    deleted: deletedIds.length,
    nextCursor: itemIds.at(-1) || null,
    hasMore: startIndex + itemIds.length < allIds.length,
  };
}
