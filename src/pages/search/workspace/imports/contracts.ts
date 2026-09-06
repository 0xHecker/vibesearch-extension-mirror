import type { JsonValue } from "@src/common/json-value";
import { z } from "zod";
import type {
  BrowserBookmarkImportResult,
  GitHubStarsImportResult,
} from "../query/model";

const browserBookmarkImportResultSchema: z.ZodType<BrowserBookmarkImportResult> =
  z.object({
    spaceGroupId: z.string(),
    spaceIds: z.array(z.string()),
    primarySpaceId: z.string().nullable(),
    folderCount: z.number().int().nonnegative(),
    bookmarkCount: z.number().int().nonnegative(),
    updatedFolderCount: z.number().int().nonnegative(),
    updatedBookmarkCount: z.number().int().nonnegative(),
    removedBookmarkCount: z.number().int().nonnegative(),
    metadataUrls: z.array(z.string()),
  });

const githubStarsImportResultSchema: z.ZodType<GitHubStarsImportResult> =
  z.object({
    spaceGroupId: z.string(),
    spaceIds: z.array(z.string()),
    importedCount: z.number().int().nonnegative(),
    updatedCount: z.number().int().nonnegative(),
    removedCount: z.number().int().nonnegative(),
  });

export function parseBrowserBookmarkImportResult(
  payload: JsonValue | undefined,
): BrowserBookmarkImportResult {
  return browserBookmarkImportResultSchema.parse(payload);
}

export function parseGitHubStarsImportResult(
  payload: JsonValue | undefined,
): GitHubStarsImportResult {
  return githubStarsImportResultSchema.parse(payload);
}
