import { z } from "zod";
import { importSettingsPatchFromPayload } from "@src/common/import-settings";
import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { FolderDocType } from "@src/schemas/folder_schema";
import type { ItemDocType } from "@src/schemas/item_schema";
import type { ImportTargetSpace } from "@src/services/db-manager";
import { inferSource } from "@src/utils/infer-source";
import {
  forgetCancelledArchiveItem,
  markArchiveItemCancelled,
  queueServerArchive,
  triggerArchiveOutboxDrain,
} from "@src/workers/background/archive-orchestrator";
import { scheduleContextMenuRefresh } from "@src/workers/background/context-menus";
import {
  openDraftEditor,
  runTargetAction,
  scheduleScreenshotPostImportWork,
} from "@src/workers/background/import-actions";
import {
  isMetadataFetchablePageUrl,
  toItemPayload,
} from "@src/workers/background/import-content";
import type {
  ImportDraft,
  ImportDraftSubmitPayload,
} from "@src/workers/background/import-types";
import {
  autoFolderName,
  normalizeHttpUrl,
  pickHostLabel,
  trimText,
  uniqueList,
} from "@src/workers/background/import-utils";
import {
  deleteFailedImportAttempt,
  getFailedImportAttempt,
  getImportSettings,
  loadDrafts,
  resolveRetryTab,
  saveDrafts,
  setImportSettings,
} from "@src/workers/background/import-storage";
import { isTrustedExtensionSender } from "@src/workers/background/message-security";
import {
  listRecentProcessStatuses,
  sendProcessStatus,
} from "@src/workers/background/process-status";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

const ImportControlEnvelopeSchema = z.object({
  type: z.string(),
  payload: z.json().optional(),
});
const DraftIdPayloadSchema = z.object({ draftId: z.string().optional() });
const RetryPayloadSchema = z.object({ statusId: z.string() });
const ProcessStatusPayloadSchema = z.object({
  max: z.coerce.number().optional(),
});
const ItemSourceSchema = z.enum([
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "threads",
  "mastodon",
  "bluesky",
  "github",
  "spotify",
  "ytmusic",
  "vimeo",
  "soundcloud",
  "article",
]);
const SubmitDraftPayloadSchema = z.object({
  draftId: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  textContent: z.string().optional(),
  source: ItemSourceSchema.optional(),
  iconUrl: z.string().optional(),
  displayImageUrl: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  spaceId: z.string().optional(),
  folderId: z.string().optional(),
  parentId: z.union([z.string(), z.null()]).optional(),
  createFolderName: z.string().optional(),
});

type ImportControlPayload = z.infer<
  typeof ImportControlEnvelopeSchema
>["payload"];

export type ImportControlMessage = {
  type?: string;
  payload?: ImportControlPayload;
};

const readDraftId = (payload: ImportControlPayload): string => {
  const result = DraftIdPayloadSchema.safeParse(payload);
  return result.success ? (result.data.draftId?.trim() ?? "") : "";
};

const isSpaceUnlocked = async (spaceId: string): Promise<boolean> => {
  if (!spaceId || spaceId !== PRIVATE_SPACE_ID) return true;
  try {
    const state = await sendForwardedToOffscreen<{ isUnlocked?: boolean }>({
      service: "spaces",
      type: "getSpaceAccessState",
      payload: { spaceId },
    });
    return state?.isUnlocked === true;
  } catch {
    return false;
  }
};
const filterAccessibleDrafts = async (
  drafts: ImportDraft[],
): Promise<ImportDraft[]> => {
  if (!drafts.some((draft) => draft.target.spaceId === PRIVATE_SPACE_ID)) {
    return drafts;
  }
  const privateUnlocked = await isSpaceUnlocked(PRIVATE_SPACE_ID);
  return drafts.filter(
    (draft) => draft.target.spaceId !== PRIVATE_SPACE_ID || privateUnlocked,
  );
};

export const handleImportControlMessage = async (
  message: ImportControlMessage,
  sender: chrome.runtime.MessageSender,
) => {
  if (!isTrustedExtensionSender(sender))
    return { success: false, error: "UNAUTHORIZED_SENDER" };

  const envelope = ImportControlEnvelopeSchema.safeParse(message);
  if (!envelope.success)
    return { success: false, error: "INVALID_IMPORT_MESSAGE" };
  const { type, payload: payloadRaw } = envelope.data;

  if (type === "IMPORT_RETRY_FAILED") {
    const retryPayload = RetryPayloadSchema.safeParse(payloadRaw);
    const statusId = retryPayload.success
      ? retryPayload.data.statusId.trim()
      : "";
    if (!statusId) return { success: false, error: "MISSING_STATUS_ID" };
    const attempt = getFailedImportAttempt(statusId);
    if (!attempt) return { success: false, error: "IMPORT_RETRY_NOT_FOUND" };
    const retryTab = await resolveRetryTab(attempt.tab);
    await runTargetAction(attempt.target, attempt.context, retryTab);
    deleteFailedImportAttempt(statusId);
    return { success: true, payload: { retried: true } };
  }

  if (type === "IMPORT_GET_SETTINGS") {
    return { success: true, payload: await getImportSettings() };
  }
  if (type === "IMPORT_GET_PROCESS_STATUSES") {
    const statusPayload = ProcessStatusPayloadSchema.safeParse(payloadRaw);
    const max = statusPayload.success ? (statusPayload.data.max ?? 12) : 12;
    return { success: true, payload: listRecentProcessStatuses(max) };
  }
  if (type === "IMPORT_SET_SETTINGS") {
    return {
      success: true,
      payload: await setImportSettings(
        importSettingsPatchFromPayload(payloadRaw),
      ),
    };
  }
  if (type === "IMPORT_LIST_DRAFTS") {
    const drafts = await filterAccessibleDrafts(await loadDrafts());
    return {
      success: true,
      payload: drafts.map((draft) => ({
        id: draft.id,
        mode: draft.mode,
        title: draft.title,
        host: pickHostLabel(draft.context),
        createdAt: draft.createdAt,
      })),
    };
  }
  if (type === "IMPORT_GET_DRAFT") {
    const draftId = readDraftId(payloadRaw);
    const [allDrafts, settings, targets] = await Promise.all([
      loadDrafts(),
      getImportSettings(),
      sendForwardedToOffscreen<ImportTargetSpace[]>({
        service: "dbManager",
        type: "getImportTargets",
        payload: {
          maxSpaces: 14,
          maxFoldersPerSpace: 40,
          maxItemsPerFolder: 12,
        },
      }).catch(() => []),
    ]);
    const drafts = await filterAccessibleDrafts(allDrafts);
    const draft = draftId
      ? allDrafts.find((entry) => entry.id === draftId) || null
      : drafts[0] || null;
    return { success: true, payload: { draft, settings, targets } };
  }
  if (type === "IMPORT_OPEN_EDITOR") {
    const draftId = readDraftId(payloadRaw);
    const accessibleDrafts = await filterAccessibleDrafts(await loadDrafts());
    let targetId = draftId;
    if (targetId && !accessibleDrafts.some((draft) => draft.id === targetId)) {
      targetId = "";
    }
    if (!targetId) targetId = accessibleDrafts[0]?.id || "";
    if (!targetId) return { success: false, error: "NO_IMPORT_DRAFTS" };
    await openDraftEditor(targetId);
    return { success: true, payload: { opened: true, draftId: targetId } };
  }
  if (type === "IMPORT_DELETE_DRAFT") {
    const draftId = readDraftId(payloadRaw);
    if (!draftId) return { success: false, error: "MISSING_DRAFT_ID" };
    const drafts = await loadDrafts();
    const removed = drafts.find((entry) => entry.id === draftId);
    await saveDrafts(drafts.filter((entry) => entry.id !== draftId));
    if (removed?.itemId) await markArchiveItemCancelled(removed.itemId);
    return { success: true, payload: { deleted: true } };
  }
  if (type === "IMPORT_SUBMIT_DRAFT") {
    const submitted = SubmitDraftPayloadSchema.safeParse(payloadRaw);
    if (!submitted.success)
      return { success: false, error: "INVALID_DRAFT_PAYLOAD" };
    const payload: ImportDraftSubmitPayload = submitted.data;
    const draftId = (payload?.draftId || "").trim();
    if (!draftId) return { success: false, error: "MISSING_DRAFT_ID" };

    const drafts = await loadDrafts();
    const draft = drafts.find((entry) => entry.id === draftId);
    if (!draft) return { success: false, error: "DRAFT_NOT_FOUND" };

    const primaryUrl = normalizeHttpUrl(payload.url || draft.primaryUrl);
    if (!primaryUrl) return { success: false, error: "INVALID_URL" };
    const originalDraftUrl = normalizeHttpUrl(draft.primaryUrl);
    const didPrimaryUrlChange =
      !!originalDraftUrl && originalDraftUrl !== primaryUrl;
    const effectiveMedia = didPrimaryUrlChange ? undefined : draft.media;
    const effectiveDisplayImageUrl = didPrimaryUrlChange
      ? undefined
      : (payload.displayImageUrl ?? draft.displayImageUrl);
    const effectiveShouldFetchMetadata = didPrimaryUrlChange
      ? isMetadataFetchablePageUrl(primaryUrl)
      : (draft.shouldFetchMetadata ?? true);
    const effectiveIsMetaFetched = effectiveShouldFetchMetadata
      ? didPrimaryUrlChange
        ? false
        : (draft.isMetaFetched ?? false)
      : true;
    const effectiveSource =
      payload.source ||
      (didPrimaryUrlChange ? inferSource(primaryUrl) : draft.source);

    const spaceId =
      (payload.spaceId || draft.target.spaceId || PUBLIC_SPACE_ID).trim() ||
      PUBLIC_SPACE_ID;
    let folderId = (payload.folderId || draft.target.folderId || "").trim();
    if (folderId === "__new__" || !folderId) {
      const created = await sendForwardedToOffscreen<FolderDocType>({
        service: "folders",
        type: "create",
        payload: {
          name: (
            payload.createFolderName ||
            draft.target.newFolderName ||
            autoFolderName(draft.context, draft.mode)
          ).trim(),
          userId: "",
          spaceId,
          allowLockedPrivateWrite: true,
        },
      });
      if (!created?.id)
        return { success: false, error: "FOLDER_CREATE_FAILED" };
      folderId = created.id;
    }

    let parentId =
      folderId === (draft.target.folderId || "")
        ? draft.target.parentId || null
        : null;
    if (payload.parentId !== undefined) {
      parentId = payload.parentId || null;
    }

    const inserted = await sendForwardedToOffscreen<ItemDocType>({
      service: "items",
      type: "addToFolder",
      payload: toItemPayload({
        id: didPrimaryUrlChange ? undefined : draft.itemId,
        context: draft.context,
        mode: draft.mode,
        primaryUrl,
        folderId,
        parentId,
        title: trimText(
          (payload.title || draft.title || "").trim() || primaryUrl,
        ),
        textContent: (payload.textContent ?? draft.textContent ?? "").trim(),
        source: effectiveSource,
        iconUrl: payload.iconUrl ?? draft.iconUrl,
        displayImageUrl: effectiveDisplayImageUrl,
        media: effectiveMedia,
        ocrText: draft.ocrText,
        ocrStatus: draft.ocrStatus,
        ocrConfidence: draft.ocrConfidence,
        ocrLineCount: draft.ocrLineCount,
        ocrModelVersion: draft.ocrModelVersion,
        ocrSourceHash: draft.ocrSourceHash,
        shouldFetchMetadata: effectiveShouldFetchMetadata,
        isMetaFetched: effectiveIsMetaFetched,
        deferBackgroundProcessing:
          draft.mode === "shot" && !didPrimaryUrlChange,
      }),
    });

    let tags = uniqueList(draft.tags);
    if (payload.tags !== undefined) {
      tags = Array.isArray(payload.tags)
        ? uniqueList(payload.tags)
        : uniqueList(payload.tags.split(/[,\n]/));
    }

    for (const tagName of tags) {
      await sendForwardedToOffscreen({
        service: "tags",
        type: "addTagToItem",
        payload: { itemId: inserted.id, tagName },
      });
    }

    await saveDrafts(drafts.filter((entry) => entry.id !== draft.id));
    if (draft.archiveUrl) {
      if (
        didPrimaryUrlChange ||
        (draft.itemId && inserted.id !== draft.itemId)
      ) {
        if (draft.itemId) await markArchiveItemCancelled(draft.itemId);
        forgetCancelledArchiveItem(inserted.id);
        void queueServerArchive(inserted.id, primaryUrl).catch((error) =>
          console.warn(
            "[archive] edited draft preview could not be queued",
            error,
          ),
        );
      } else {
        void triggerArchiveOutboxDrain();
      }
    }
    if (draft.mode === "shot" && !didPrimaryUrlChange) {
      scheduleScreenshotPostImportWork(inserted.id, primaryUrl);
    }
    scheduleContextMenuRefresh("low");
    sendProcessStatus(
      `import-submit-${Date.now()}`,
      "Import",
      "success",
      "Draft imported.",
    );
    return { success: true, payload: inserted };
  }

  return { success: false, error: "UNSUPPORTED_IMPORT_MESSAGE" };
};
