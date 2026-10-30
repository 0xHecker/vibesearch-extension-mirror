/**
 * connectors/types.ts — shared shapes for social connectors.
 *
 * Each connector pulls a user's *saved / bookmarked* items from a platform using
 * the user's own logged-in browser session (cookies), normalizes them to
 * `CapturedItem`s, and forwards them to the cloud. Connectors are toggled on/off
 * in settings; a heartbeat auto-toggles a connector off when its session dies.
 */
import type { CapturedItem } from "./cloud-push";

export type ConnectorPlatform = "x" | "reddit" | "instagram";

/** A logged-in account detected from the browser session (supports several). */
export interface ConnectorAccount {
  platform: ConnectorPlatform;
  /** Stable per-platform account id (e.g. X `twid`, IG `ds_user_id`, reddit name). */
  accountId: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

/** A saved-items folder/collection on the platform (X bookmark folders, IG collections). */
export interface SavedFolder {
  id: string;
  name: string;
}

export interface FetchSavedResult {
  items: CapturedItem[];
  /** Newest platform id seen this run — stored as the incremental cursor. */
  newestId?: string;
  /** Opaque page cursor used to resume a bounded backlog on the next run. */
  nextCursor?: string;
  /** True only when the known item or the end of the remote collection was reached. */
  complete: boolean;
  folders?: SavedFolder[];
}

/** Uniform interface every connector implements so the registry can drive them. */
export interface ConnectorModule {
  platform: ConnectorPlatform;
  label: string;
  /** Hosts this connector needs (for host-permission checks / messaging). */
  origins: string[];
  /** Read the currently logged-in account from the browser session, or null. */
  detectAccount(): Promise<ConnectorAccount | null>;
  /** Heartbeat: is the session still valid + can we call the API? */
  checkAlive(accountId?: string): Promise<boolean>;
  /** Fetch saved/bookmarked items (incremental via `sinceId`), with folders. */
  fetchSaved(opts: {
    sinceId?: string;
    cursor?: string;
    maxPages?: number;
    onProgress?: (detail: string) => void;
    shouldCancel?: () => boolean;
  }): Promise<FetchSavedResult>;
}

/** Persisted state for one connected account (the switch + cursor + status). */
export interface ConnectorState {
  platform: ConnectorPlatform;
  accountId: string;
  handle: string;
  displayName?: string;
  /** The switch: on = auto-sync + heartbeat; flipped off automatically on session loss. */
  connected: boolean;
  autoSync: boolean;
  cloudUserId?: string;
  cloudCheckpoints?: Record<string, ConnectorCloudCheckpoint>;
  sinceId?: string;
  /** Opaque remote page cursor for a backlog that spans bounded sync runs. */
  continuationCursor?: string;
  /** New high-water mark held until the backlog reaches its safe commit point. */
  pendingNewestId?: string;
  lastSyncAt?: number;
  lastHeartbeatAt?: number;
  lastError?: string;
  itemCount: number;
}

export type ConnectorCloudCheckpoint = Pick<ConnectorState,
  "sinceId" | "continuationCursor" | "pendingNewestId" | "lastSyncAt" | "itemCount"
>;

export const connectorKey = (platform: ConnectorPlatform, accountId: string): string =>
  `${platform}:${accountId}`;
