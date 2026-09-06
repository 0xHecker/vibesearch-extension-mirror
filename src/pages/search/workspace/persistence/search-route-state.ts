import { PUBLIC_SPACE_ID } from "@src/common/spaces";
import {
  SEARCH_DEBUG_QUERY_PARAM,
  SEARCH_DEBUG_STORAGE_KEY,
} from "../query/model";

export function readInitialSpaceGroupId(): string | null {
  return readSearchParameter("group");
}

export function readInitialSpaceId(): string {
  return readSearchParameter("space") ?? PUBLIC_SPACE_ID;
}

export function readInitialFolderId(): string {
  return readSearchParameter("folder") ?? "all";
}

export function readInitialDebugMode(isDevelopment: boolean): boolean {
  if (!isDevelopment) return false;
  try {
    const fromQuery =
      new URLSearchParams(window.location.search).get(
        SEARCH_DEBUG_QUERY_PARAM,
      ) === "1";
    const fromStorage = localStorage.getItem(SEARCH_DEBUG_STORAGE_KEY) === "1";
    return fromQuery || fromStorage;
  } catch {
    return false;
  }
}

function readSearchParameter(name: string): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get(name)?.trim();
    return value || null;
  } catch {
    return null;
  }
}
