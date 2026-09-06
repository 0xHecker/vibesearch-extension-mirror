import {
  deleteSpaceForever,
  listBinnedSpaces,
  moveSpaceToBin,
  purgeExpiredSpaces,
  restoreSpaceFromBin,
} from "@src/services/spaces/bin-lifecycle";
import {
  SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE,
  ensureDefaultSpaces,
  maybeRepairFolderAndItemSpaceAssignments,
  repairFolderAndItemSpaceAssignments,
} from "@src/services/spaces/defaults-and-repair";
import { SpaceAuthentication } from "@src/services/spaces/authentication";
import {
  createSpace,
  listSpaces,
  moveSpaceToGroup,
  renameSpace,
  reorderSpaces,
} from "@src/services/spaces/records";
import type {
  RecoveryQuestionInput,
  SpaceAccessState,
  SpaceListItem,
  SpaceOperationResult,
  SpacesControllerOptions,
} from "@src/services/spaces/types";

export { SPACE_ASSIGNMENT_REPAIR_PAGE_SIZE };
export type { SpaceListItem, SpacesControllerOptions };

/**
 * Stable router-facing API for spaces. Domain behavior lives under
 * `services/spaces/`, grouped by the responsibility a maintainer is seeking.
 */
export class SpacesController {
  private readonly authentication: SpaceAuthentication;

  constructor(private readonly options: SpacesControllerOptions = {}) {
    this.authentication = new SpaceAuthentication(options);
  }

  ensureDefaults(): Promise<void> {
    return ensureDefaultSpaces(this.options);
  }

  repairFolderAndItemSpaceAssignments(): Promise<{
    folderUpdates: number;
    itemUpdates: number;
  }> {
    return repairFolderAndItemSpaceAssignments(this.options);
  }

  maybeRepairFolderAndItemSpaceAssignments(): Promise<{
    repaired: boolean;
    folderUpdates: number;
    itemUpdates: number;
  }> {
    return maybeRepairFolderAndItemSpaceAssignments(this.options);
  }

  listSpaces(): Promise<SpaceListItem[]> {
    return listSpaces(this.options);
  }

  createSpace(payload: {
    name: string;
    spaceGroupId?: string | null;
  }): Promise<SpaceListItem> {
    return createSpace(this.options, payload);
  }

  renameSpace(payload: { id: string; name: string }): Promise<SpaceOperationResult> {
    return renameSpace(this.options, payload);
  }

  moveToSpaceGroup(payload: {
    spaceId: string;
    spaceGroupId: string | null;
  }): Promise<SpaceOperationResult> {
    return moveSpaceToGroup(this.options, payload);
  }

  setPrivatePassword(payload: {
    spaceId?: string;
    password: string;
    currentPassword?: string;
    recoveryQuestions?: RecoveryQuestionInput[];
  }): Promise<SpaceOperationResult> {
    return this.authentication.setPassword(payload);
  }

  unlockSpace(payload: {
    spaceId?: string;
    password: string;
  }): Promise<SpaceOperationResult> {
    return this.authentication.unlock(payload);
  }

  changePrivatePassword(payload: {
    spaceId?: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<SpaceOperationResult> {
    return this.authentication.changePassword(payload);
  }

  recoverPrivatePassword(payload: {
    spaceId?: string;
    answer1: string;
    answer2: string;
    newPassword: string;
  }): Promise<SpaceOperationResult> {
    return this.authentication.recoverPassword(payload);
  }

  async lockSpace(payload: { spaceId?: string }): Promise<SpaceOperationResult> {
    return this.authentication.lock(payload);
  }

  async touchSpaceActivity(payload: { spaceId: string }): Promise<SpaceOperationResult> {
    return this.authentication.touch(payload);
  }

  getSpaceAccessState(payload?: { spaceId?: string }): Promise<SpaceAccessState> {
    return this.authentication.getAccessState(payload);
  }

  moveToBin(payload: {
    id: string;
  }): Promise<{ success: boolean; purgeAt: number }> {
    return moveSpaceToBin(this.options, payload);
  }

  restoreFromBin(payload: {
    id: string;
  }): Promise<{ success: boolean; relocated?: boolean; message?: string }> {
    return restoreSpaceFromBin(this.options, payload);
  }

  listBinSpaces(): Promise<SpaceListItem[]> {
    return listBinnedSpaces(this.options);
  }

  purgeExpired(): Promise<{ purgedSpaceIds: string[] }> {
    return purgeExpiredSpaces(this.options);
  }

  deleteSpaceForever(payload: {
    id: string;
    expectedDeletedAt: number;
  }): Promise<{ success: boolean; removedItems: number }> {
    return deleteSpaceForever(this.options, payload);
  }

  reorderSpaces(payload: {
    orderedIds: string[];
    spaceGroupId?: string | null;
  }): Promise<SpaceOperationResult> {
    return reorderSpaces(this.options, payload);
  }
}

export const spacesController = new SpacesController();
