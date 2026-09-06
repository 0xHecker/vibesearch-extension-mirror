import type { getDb } from "@src/services/DatabaseService";
import type { deleteAllMediaForItem } from "@src/services/media-storage";
import type { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";

export type SpaceDatabase = Awaited<ReturnType<typeof getDb>>;

export type SpaceAccessView = {
  isUnlocked: boolean;
  requiresPassword: boolean;
  hasRecovery: boolean;
  recoveryQuestions: string[];
  autoLockMs: number;
  remainingMs?: number;
  lastActivityAt?: number;
};

export type RecoveryQuestionInput = {
  question: string;
  answer: string;
};

export type SpaceListItem = {
  id: string;
  name: string;
  slug: string;
  spaceGroupId: string | null;
  isPrivate: boolean;
  sortOrder: number;
  isArchived: boolean;
  deletedAt: number;
  purgeAt: number;
  createdAt: number;
  updatedAt: number;
  access: SpaceAccessView;
};

export type SpacesControllerOptions = {
  getDb?: typeof getDb;
  now?: () => number;
  deleteAllMediaForItem?: typeof deleteAllMediaForItem;
  notifyArchivedItemsPurged?: typeof notifyArchivedItemsPurged;
};

export type SpaceAccessState = {
  access: Record<
    string,
    {
      isUnlocked: boolean;
      remainingMs?: number;
      lastActivityAt?: number;
    }
  >;
};

export type SpaceOperationResult = { success: boolean };
