import { PRIVATE_SPACE_ID, PUBLIC_SPACE_ID } from "@src/common/spaces";
import type { MyDatabase } from "@src/services/DatabaseService";
import { spaceSessionService } from "@src/services/space-session.service";

export type ItemSearchAccessContext = {
  activeSpaceId?: string;
  searchScope?: "current" | "global" | "private" | "public";
};

export async function resolveAllowedSpaceIds(
  db: MyDatabase,
  accessContext?: ItemSearchAccessContext,
): Promise<string[]> {
  const activeSpaceId = accessContext?.activeSpaceId || PUBLIC_SPACE_ID;
  const requestedScope = accessContext?.searchScope || "current";
  const privateUnlocked = spaceSessionService.isUnlocked(PRIVATE_SPACE_ID);
  const documents = await db.spaces.find({
    selector: { isArchived: { $eq: false }, deletedAt: { $eq: 0 } },
  }).exec();
  const spaces = documents.map((document) => document.toMutableJSON());
  const allSpaceIds = spaces.map((space) => space.id);
  const publicSpaceIds = spaces
    .filter((space) => !space.isPrivate)
    .map((space) => space.id);
  const safeActiveSpaceId = spaces.some((space) => space.id === activeSpaceId)
    ? activeSpaceId
    : PUBLIC_SPACE_ID;
  const publicFallback = publicSpaceIds.length > 0 ? publicSpaceIds : [PUBLIC_SPACE_ID];
  const globalFallback = allSpaceIds.length > 0 ? allSpaceIds : publicFallback;

  if (requestedScope === "global") {
    return privateUnlocked ? globalFallback : publicFallback;
  }
  if (requestedScope === "public") return publicFallback;
  if (requestedScope === "private") {
    return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
  }
  if (safeActiveSpaceId === PRIVATE_SPACE_ID) {
    return privateUnlocked ? [PRIVATE_SPACE_ID] : [];
  }
  return [safeActiveSpaceId];
}

export function normalizeHttpUrl(input: string): string | null {
  const candidate = input.trim();
  if (!candidate) return null;

  const parse = (value: string): string | null => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  return parse(candidate) || parse(`https://${candidate}`);
}

export function parseHttpHostname(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return null;
  }
}
