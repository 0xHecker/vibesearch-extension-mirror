import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import {
  resolveToastErrorMessage,
  showErrorToast,
  showLoadingToast,
  showSuccessToast,
} from "@src/utils/toast-feedback";
import { useCallback } from "react";
import { z } from "zod";

const importRetryResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

type ProcessStatusRetryOptions = {
  refreshResults: () => void;
  lockPrivateSpace: (detail: string) => Promise<void>;
  clearProcessStatus: (statusId: string) => void;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
  setRetryingProcessId: (statusId: string | null) => void;
};

/** Executes the retry action advertised by a process-status row. */
export function useProcessStatusRetry({
  refreshResults,
  lockPrivateSpace,
  clearProcessStatus,
  upsertProcessStatus,
  setRetryingProcessId,
}: ProcessStatusRetryOptions) {
  return useCallback(
    async (status: SearchProcessStatusItem): Promise<void> => {
      const action = status.retryAction;
      if (!action) return;

      const toastId = showLoadingToast(
        `Retrying ${status.label.toLowerCase()}...`,
        "quick",
      );
      setRetryingProcessId(status.id);
      upsertProcessStatus({
        ...status,
        state: "processing",
        detail: "Retry requested...",
        updatedAt: Date.now(),
      });

      try {
        if (action === "RETRY_QUERY") {
          refreshResults();
          showSuccessToast("Retrying query...", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }
        if (action === "TRIGGER_EMBEDDING") {
          await chrome.runtime.sendMessage({
            type: "TRIGGER_EMBEDDING",
            target: "background",
          });
          showSuccessToast("Embedding refresh queued.", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }
        if (action === "TRIGGER_OCR") {
          await chrome.runtime.sendMessage({
            type: "TRIGGER_OCR",
            target: "background",
          });
          showSuccessToast("Image OCR queued.", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }
        if (action === "REBUILD_INDEX") {
          await chrome.runtime.sendMessage({
            service: "items",
            type: "markSearchIndexDirty",
            target: "offscreen",
          });
          refreshResults();
          showSuccessToast("Search index rebuild queued.", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }
        if (action === "REBUILD_VECTORS") {
          await chrome.runtime.sendMessage({
            service: "sync",
            type: "rebuildAndCompact",
            target: "offscreen",
            payload: { reembedMissing: true },
          });
          showSuccessToast("Vector rebuild started.", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }
        if (action === "LOCK_PRIVATE_SPACE") {
          await lockPrivateSpace("Private space locked.");
          showSuccessToast("Private space lock requested.", {
            id: toastId,
            tempo: "quick",
          });
          return;
        }

        const response = importRetryResponseSchema.parse(
          await chrome.runtime.sendMessage({
            target: "background",
            type: "IMPORT_RETRY_FAILED",
            payload: { statusId: status.id },
          }),
        );
        if (!response.success) {
          throw new Error(response.error ?? "Import retry failed.");
        }
        clearProcessStatus(status.id);
        showSuccessToast("Import retry queued.", {
          id: toastId,
          tempo: "quick",
        });
      } catch (error) {
        const message = resolveToastErrorMessage(
          error,
          "Retry request failed.",
        );
        upsertProcessStatus({
          ...status,
          state: "error",
          detail: message,
          updatedAt: Date.now(),
        });
        showErrorToast(message, { id: toastId });
      } finally {
        setRetryingProcessId(null);
      }
    },
    [
      clearProcessStatus,
      lockPrivateSpace,
      refreshResults,
      setRetryingProcessId,
      upsertProcessStatus,
    ],
  );
}
