export const PUBLIC_SPACE_ID = "space_public_default";
export const PRIVATE_SPACE_ID = "space_private_default";

export const PUBLIC_SPACE_NAME = "Public";
export const PRIVATE_SPACE_NAME = "Private";

export const DEFAULT_PRIVATE_AUTO_LOCK_MS = 5 * 60 * 1000;
export const PRIVATE_PASSWORD_MIN_LENGTH = 8;

export const BIN_RETENTION_DAYS = 30;
export const BIN_RETENTION_MS = BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const SPACE_NOT_BINNED = 0;

export const computeBinPurgeAt = (now: number): number =>
  Number.isFinite(now) && now > 0 ? now + BIN_RETENTION_MS : 0;

export const hasValidSpacePurgeDeadline = (space: { deletedAt: number; purgeAt: number }): boolean =>
  space.deletedAt > 0 && space.purgeAt > space.deletedAt;

export const isSpacePurgeable = (space: { deletedAt: number; purgeAt: number }, now: number): boolean =>
  hasValidSpacePurgeDeadline(space) && space.purgeAt <= now;

// Shared selector for "live, in-active-nav" space reads. `deletedAt: 0` means
// not in bin; `isArchived: false` keeps the legacy archived flag active.
export const LIVE_SPACE_SELECTOR = {
  isArchived: { $eq: false },
  deletedAt: { $eq: SPACE_NOT_BINNED },
} as const;

export const normalizeSpaceName = (value: string): string => {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
};

export const slugifySpaceName = (value: string): string => {
  return normalizeSpaceName(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};
