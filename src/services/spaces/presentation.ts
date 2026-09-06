import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  SPACE_NOT_BINNED,
  slugifySpaceName,
} from "@src/common/spaces";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { spaceSessionService } from "@src/services/space-session.service";
import type { SpaceListItem } from "@src/services/spaces/types";

export function buildSpaceId(): string {
  return crypto.randomUUID?.() ?? `space_${Date.now()}_${Math.random()}`;
}

export function safeSpaceSlug(name: string, fallback: string): string {
  return slugifySpaceName(name) || fallback;
}

export function toSpaceListItem(space: SpaceDocType): SpaceListItem {
  const isUnlocked = space.isPrivate ? spaceSessionService.isUnlocked(space.id) : true;
  const session = spaceSessionService.getState(space.id);
  const requiresPassword = space.isPrivate && !(space.passwordHash && space.passwordSalt);
  const recoveryQuestions = [space.recoveryQuestion1, space.recoveryQuestion2]
    .map((question) => (question || "").trim())
    .filter(Boolean);
  return {
    id: space.id,
    name: space.name,
    slug: space.slug,
    spaceGroupId: space.spaceGroupId || null,
    isPrivate: space.isPrivate,
    sortOrder: space.sortOrder,
    isArchived: space.isArchived,
    deletedAt: space.deletedAt || SPACE_NOT_BINNED,
    purgeAt: space.purgeAt || 0,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    access: {
      isUnlocked,
      requiresPassword,
      hasRecovery:
        recoveryQuestions.length === 2 &&
        Boolean(space.recoveryHash1) &&
        Boolean(space.recoverySalt1) &&
        Boolean(space.recoveryHash2) &&
        Boolean(space.recoverySalt2),
      recoveryQuestions,
      autoLockMs: space.autoLockMs || DEFAULT_PRIVATE_AUTO_LOCK_MS,
      remainingMs: session.remainingMs,
      lastActivityAt: session.lastActivityAt,
    },
  };
}

export function sortSpaceList(items: SpaceListItem[]): SpaceListItem[] {
  return items.sort((left, right) => {
    if (left.isPrivate !== right.isPrivate) return left.isPrivate ? 1 : -1;
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    return left.createdAt - right.createdAt;
  });
}
