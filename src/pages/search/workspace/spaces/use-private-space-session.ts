import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { SearchProcessStatusItem } from "@src/pages/search/components/SearchProcessStatus";
import type { PrivateAccessMode } from "../dialogs/private-space-access-dialog";
import type { SpaceListItem } from "@src/services/spaces/types";
import { useCallback, useEffect, useRef } from "react";
import {
  SPACE_ACCESS_POLL_MS,
  SPACE_ACTIVITY_TOUCH_THROTTLE_MS,
} from "../query/model";

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "pointerdown",
  "keydown",
  "wheel",
  "scroll",
  "focus",
];

type PrivateSpaceSessionOptions = {
  activeSpaceId: string;
  isPrivateUnlocked: boolean;
  unlockDialogOpen: boolean;
  loadSpaces: () => Promise<SpaceListItem[]>;
  openPrivateAccess: (mode: PrivateAccessMode) => void;
  lockPrivateSpace: (detail: string) => Promise<void>;
  upsertProcessStatus: (status: SearchProcessStatusItem) => void;
};

/** Maintains private-space activity, lock polling, and leave-space locking. */
export function usePrivateSpaceSession({
  activeSpaceId,
  isPrivateUnlocked,
  unlockDialogOpen,
  loadSpaces,
  openPrivateAccess,
  lockPrivateSpace,
  upsertProcessStatus,
}: PrivateSpaceSessionOptions): void {
  const lastActivityTouch = useRef(0);
  const previousActiveSpace = useRef(PUBLIC_SPACE_ID);

  const touchActivity = useCallback(async (): Promise<void> => {
    if (activeSpaceId !== PRIVATE_SPACE_ID || !isPrivateUnlocked) return;
    const now = Date.now();
    if (now - lastActivityTouch.current < SPACE_ACTIVITY_TOUCH_THROTTLE_MS) {
      return;
    }
    lastActivityTouch.current = now;
    try {
      await chrome.runtime.sendMessage({
        service: "spaces",
        type: "touchSpaceActivity",
        target: "offscreen",
        payload: { spaceId: PRIVATE_SPACE_ID },
      });
    } catch (error) {
      console.error("Failed to touch private space session:", error);
    }
  }, [activeSpaceId, isPrivateUnlocked]);

  useEffect(() => {
    if (activeSpaceId !== PRIVATE_SPACE_ID || !isPrivateUnlocked) return;
    const handleActivity = (): void => void touchActivity();
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleActivity, { passive: true });
    }
    return () => {
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleActivity);
      }
    };
  }, [activeSpaceId, isPrivateUnlocked, touchActivity]);

  useEffect(() => {
    const pollAccess = async (): Promise<void> => {
      const spaces = await loadSpaces();
      const privateSpace = spaces.find(
        (space) => space.id === PRIVATE_SPACE_ID,
      );
      if (
        activeSpaceId !== PRIVATE_SPACE_ID ||
        !privateSpace ||
        privateSpace.access.isUnlocked
      ) {
        return;
      }
      if (!unlockDialogOpen) {
        openPrivateAccess(
          privateSpace.access.requiresPassword ? "setup" : "unlock",
        );
      }
      upsertProcessStatus({
        id: "private-space",
        label: "Private space",
        state: "success",
        detail:
          "Private space is locked. Unlock it to keep browsing this private folder.",
        updatedAt: Date.now(),
      });
    };

    void pollAccess();
    const timer = window.setInterval(
      () => void pollAccess(),
      SPACE_ACCESS_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [
    activeSpaceId,
    loadSpaces,
    openPrivateAccess,
    unlockDialogOpen,
    upsertProcessStatus,
  ]);

  useEffect(() => {
    const previous = previousActiveSpace.current;
    previousActiveSpace.current = activeSpaceId;
    if (
      previous !== PRIVATE_SPACE_ID ||
      activeSpaceId === PRIVATE_SPACE_ID ||
      !isPrivateUnlocked
    ) {
      return;
    }
    void lockPrivateSpace("Private space locked when you left it.");
  }, [activeSpaceId, isPrivateUnlocked, lockPrivateSpace]);
}
