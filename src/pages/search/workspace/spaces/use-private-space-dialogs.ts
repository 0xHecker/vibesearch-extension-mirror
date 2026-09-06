import {
  PRIVATE_PASSWORD_MIN_LENGTH,
  PRIVATE_SPACE_ID,
} from "@src/common/spaces";
import type { JsonValue } from "@src/common/json-value";
import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import type { PrivateAccessMode } from "../dialogs/private-space-access-dialog";
import type { SpaceListItem } from "../query/model";
import {
  showErrorToast,
  showLoadingToast,
  showSuccessToast,
} from "@src/utils/toast-feedback";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { z } from "zod";
import { pickTwoRecoveryQuestions } from "../query/model";

const commandResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

type PrivateSpaceDialogsOptions = {
  activeSpaceId: string;
  selectedFolderId: string;
  loadSpaces: () => Promise<SpaceListItem[]>;
  setActiveSpaceId: Dispatch<SetStateAction<string>>;
  setSelectedFolderId: Dispatch<SetStateAction<string>>;
  refresh: () => void;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
};

async function sendSpaceCommand(
  type:
    | "lockSpace"
    | "setPrivatePassword"
    | "recoverPrivatePassword"
    | "unlockSpace"
    | "changePrivatePassword",
  payload: JsonValue,
): Promise<z.infer<typeof commandResponseSchema>> {
  return commandResponseSchema.parse(
    await chrome.runtime.sendMessage({
      service: "spaces",
      type,
      target: "offscreen",
      payload,
    }),
  );
}

function accessActionLabel(mode: PrivateAccessMode): string {
  if (mode === "setup") return "Configuring private space...";
  if (mode === "recovery") return "Recovering private space...";
  return "Unlocking private space...";
}

function accessSuccessDetail(mode: PrivateAccessMode): string {
  if (mode === "setup") return "Private space is configured and unlocked.";
  if (mode === "recovery") return "Private space recovered and unlocked.";
  return "Private space unlocked.";
}

/** Owns private-space credentials, recovery, locking, and password changes. */
export function usePrivateSpaceDialogs({
  activeSpaceId,
  selectedFolderId,
  loadSpaces,
  setActiveSpaceId,
  setSelectedFolderId,
  refresh,
  upsertProcessStatus,
}: PrivateSpaceDialogsOptions) {
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockConfirmPassword, setUnlockConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [unlockQuestion1, setUnlockQuestion1] = useState("");
  const [unlockQuestion2, setUnlockQuestion2] = useState("");
  const [unlockAnswer1, setUnlockAnswer1] = useState("");
  const [unlockAnswer2, setUnlockAnswer2] = useState("");
  const [unlockDialogError, setUnlockDialogError] = useState<string | null>(
    null,
  );
  const [unlockDialogLoading, setUnlockDialogLoading] = useState(false);
  const [unlockDialogMode, setUnlockDialogMode] =
    useState<PrivateAccessMode>("unlock");

  const [changePasswordDialogOpen, setChangePasswordDialogOpen] =
    useState(false);
  const [changePasswordCurrent, setChangePasswordCurrent] = useState("");
  const [changePasswordNext, setChangePasswordNext] = useState("");
  const [changePasswordConfirm, setChangePasswordConfirm] = useState("");
  const [changePasswordError, setChangePasswordError] = useState<string | null>(
    null,
  );
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  const resetUnlockDialogState = useCallback((): void => {
    setUnlockPassword("");
    setUnlockConfirmPassword("");
    setUnlockQuestion1("");
    setUnlockQuestion2("");
    setUnlockAnswer1("");
    setUnlockAnswer2("");
    setUnlockDialogError(null);
    setUnlockDialogLoading(false);
  }, []);

  const clearUnlockCredentials = useCallback((): void => {
    setUnlockDialogError(null);
    setUnlockPassword("");
    setUnlockConfirmPassword("");
    setUnlockAnswer1("");
    setUnlockAnswer2("");
  }, []);

  const shuffleRecoveryQuestions = useCallback((): void => {
    const [question1, question2] = pickTwoRecoveryQuestions();
    setUnlockQuestion1(question1);
    setUnlockQuestion2(question2);
    setUnlockAnswer1("");
    setUnlockAnswer2("");
  }, []);

  useEffect(() => {
    if (
      unlockDialogOpen &&
      unlockDialogMode === "setup" &&
      !unlockQuestion1 &&
      !unlockQuestion2
    ) {
      const [question1, question2] = pickTwoRecoveryQuestions();
      setUnlockQuestion1(question1);
      setUnlockQuestion2(question2);
    }
  }, [unlockDialogMode, unlockDialogOpen, unlockQuestion1, unlockQuestion2]);

  const openPrivateAccess = useCallback(
    (mode: PrivateAccessMode): void => {
      setUnlockDialogMode(mode);
      resetUnlockDialogState();
      setUnlockDialogOpen(true);
    },
    [resetUnlockDialogState],
  );

  const lockPrivateSpace = useCallback(
    async (detail: string): Promise<void> => {
      let locked = false;
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await sendSpaceCommand("lockSpace", {
            spaceId: PRIVATE_SPACE_ID,
          });
          if (!response.success) {
            throw new Error(response.error ?? "Could not lock private space.");
          }
          locked = true;
          break;
        } catch (error) {
          lastError =
            error instanceof Error ? error : new Error("Private lock failed.");
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 120 * (attempt + 1));
          });
        }
      }

      if (!locked && lastError) {
        console.error("Failed to lock private space:", lastError);
      }
      await loadSpaces().catch(() => []);
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: locked ? "success" : "error",
        detail: locked
          ? detail
          : "Could not lock private space immediately. It will auto-lock on timeout.",
        retryAction: locked ? undefined : "LOCK_PRIVATE_SPACE",
        updatedAt: Date.now(),
      });
    },
    [loadSpaces, upsertProcessStatus],
  );

  const submitPrivateAccess = useCallback(async (): Promise<void> => {
    setUnlockDialogError(null);
    setUnlockDialogLoading(true);
    const toastId = showLoadingToast(accessActionLabel(unlockDialogMode));
    try {
      let response: z.infer<typeof commandResponseSchema>;
      if (unlockDialogMode === "setup") {
        if (unlockPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
          throw new Error(
            `Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`,
          );
        }
        if (unlockPassword !== unlockConfirmPassword) {
          throw new Error("Passwords do not match.");
        }
        if (
          unlockQuestion1.trim().length < 4 ||
          unlockQuestion2.trim().length < 4
        ) {
          throw new Error("Add two clear recovery questions.");
        }
        if (
          unlockAnswer1.trim().length < 2 ||
          unlockAnswer2.trim().length < 2
        ) {
          throw new Error("Add answers for both recovery questions.");
        }
        response = await sendSpaceCommand("setPrivatePassword", {
          spaceId: PRIVATE_SPACE_ID,
          password: unlockPassword,
          recoveryQuestions: [
            { question: unlockQuestion1, answer: unlockAnswer1 },
            { question: unlockQuestion2, answer: unlockAnswer2 },
          ],
        });
      } else if (unlockDialogMode === "recovery") {
        if (unlockPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
          throw new Error(
            `Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`,
          );
        }
        if (unlockPassword !== unlockConfirmPassword) {
          throw new Error("Passwords do not match.");
        }
        if (!unlockAnswer1.trim() || !unlockAnswer2.trim()) {
          throw new Error("Answer both recovery questions.");
        }
        response = await sendSpaceCommand("recoverPrivatePassword", {
          spaceId: PRIVATE_SPACE_ID,
          answer1: unlockAnswer1,
          answer2: unlockAnswer2,
          newPassword: unlockPassword,
        });
      } else {
        response = await sendSpaceCommand("unlockSpace", {
          spaceId: PRIVATE_SPACE_ID,
          password: unlockPassword,
        });
      }

      if (!response.success) {
        throw new Error(response.error ?? "Unable to unlock private space.");
      }
      await loadSpaces();
      const preserveFolder =
        activeSpaceId === PRIVATE_SPACE_ID && selectedFolderId !== "all";
      setActiveSpaceId(PRIVATE_SPACE_ID);
      if (!preserveFolder) setSelectedFolderId("all");
      setUnlockDialogOpen(false);
      resetUnlockDialogState();
      refresh();
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "success",
        detail: accessSuccessDetail(unlockDialogMode),
        updatedAt: Date.now(),
      });
      showSuccessToast("Private space ready.", { id: toastId });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to unlock private space.";
      setUnlockDialogError(message);
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "error",
        detail: message,
        updatedAt: Date.now(),
      });
      showErrorToast(message, { id: toastId });
    } finally {
      setUnlockDialogLoading(false);
    }
  }, [
    activeSpaceId,
    loadSpaces,
    refresh,
    resetUnlockDialogState,
    selectedFolderId,
    setActiveSpaceId,
    setSelectedFolderId,
    unlockAnswer1,
    unlockAnswer2,
    unlockConfirmPassword,
    unlockDialogMode,
    unlockPassword,
    unlockQuestion1,
    unlockQuestion2,
    upsertProcessStatus,
  ]);

  const resetPasswordChange = useCallback((): void => {
    setChangePasswordCurrent("");
    setChangePasswordNext("");
    setChangePasswordConfirm("");
    setChangePasswordError(null);
  }, []);

  const openPasswordChange = useCallback((): void => {
    resetPasswordChange();
    setChangePasswordDialogOpen(true);
  }, [resetPasswordChange]);

  const submitPasswordChange = useCallback(async (): Promise<void> => {
    if (changePasswordNext.length < PRIVATE_PASSWORD_MIN_LENGTH) {
      setChangePasswordError(
        `Use at least ${PRIVATE_PASSWORD_MIN_LENGTH} characters.`,
      );
      return;
    }
    if (changePasswordNext !== changePasswordConfirm) {
      setChangePasswordError("Passwords do not match.");
      return;
    }

    setChangePasswordError(null);
    setChangePasswordLoading(true);
    const toastId = showLoadingToast("Updating private password...");
    try {
      const response = await sendSpaceCommand("changePrivatePassword", {
        spaceId: PRIVATE_SPACE_ID,
        currentPassword: changePasswordCurrent,
        newPassword: changePasswordNext,
      });
      if (!response.success) {
        throw new Error(response.error ?? "Failed to change password.");
      }
      await loadSpaces();
      setChangePasswordDialogOpen(false);
      resetPasswordChange();
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "success",
        detail: "Private space password updated.",
        updatedAt: Date.now(),
      });
      showSuccessToast("Private password updated.", { id: toastId });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to change private password.";
      setChangePasswordError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setChangePasswordLoading(false);
    }
  }, [
    changePasswordConfirm,
    changePasswordCurrent,
    changePasswordNext,
    loadSpaces,
    resetPasswordChange,
    upsertProcessStatus,
  ]);

  return {
    unlockDialogOpen,
    setUnlockDialogOpen,
    unlockPassword,
    setUnlockPassword,
    unlockConfirmPassword,
    setUnlockConfirmPassword,
    showPassword,
    setShowPassword,
    unlockQuestion1,
    setUnlockQuestion1,
    unlockQuestion2,
    setUnlockQuestion2,
    unlockAnswer1,
    setUnlockAnswer1,
    unlockAnswer2,
    setUnlockAnswer2,
    unlockDialogError,
    unlockDialogLoading,
    unlockDialogMode,
    setUnlockDialogMode,
    resetUnlockDialogState,
    clearUnlockCredentials,
    shuffleRecoveryQuestions,
    openPrivateAccess,
    submitPrivateAccess,
    lockPrivateSpace,
    changePasswordDialogOpen,
    setChangePasswordDialogOpen,
    changePasswordCurrent,
    setChangePasswordCurrent,
    changePasswordNext,
    setChangePasswordNext,
    changePasswordConfirm,
    setChangePasswordConfirm,
    changePasswordError,
    changePasswordLoading,
    resetPasswordChange,
    openPasswordChange,
    submitPasswordChange,
  };
}
