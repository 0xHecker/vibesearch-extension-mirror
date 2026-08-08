import { DEFAULT_PRIVATE_AUTO_LOCK_MS } from "@src/common/spaces";

type SpaceSessionEntry = {
  unlockedAt: number;
  lastActivityAt: number;
  autoLockMs: number;
};

type SpaceSessionState = {
  isUnlocked: boolean;
  unlockedAt?: number;
  lastActivityAt?: number;
  autoLockMs?: number;
  remainingMs?: number;
};

class SpaceSessionService {
  private sessions = new Map<string, SpaceSessionEntry>();

  private expireIdleSessions(now = Date.now()): void {
    for (const [spaceId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt > session.autoLockMs) {
        this.sessions.delete(spaceId);
      }
    }
  }

  unlockSpace(spaceId: string, autoLockMs = DEFAULT_PRIVATE_AUTO_LOCK_MS): void {
    const now = Date.now();
    this.sessions.set(spaceId, {
      unlockedAt: now,
      lastActivityAt: now,
      autoLockMs,
    });
  }

  lockSpace(spaceId: string): void {
    this.sessions.delete(spaceId);
  }

  lockAll(): void {
    this.sessions.clear();
  }

  touchSpace(spaceId: string): boolean {
    this.expireIdleSessions();
    const entry = this.sessions.get(spaceId);
    if (!entry) return false;
    entry.lastActivityAt = Date.now();
    this.sessions.set(spaceId, entry);
    return true;
  }

  isUnlocked(spaceId: string): boolean {
    this.expireIdleSessions();
    return this.sessions.has(spaceId);
  }

  getState(spaceId: string): SpaceSessionState {
    this.expireIdleSessions();
    const entry = this.sessions.get(spaceId);
    if (!entry) {
      return { isUnlocked: false };
    }
    const remainingMs = Math.max(0, entry.autoLockMs - (Date.now() - entry.lastActivityAt));
    return {
      isUnlocked: true,
      unlockedAt: entry.unlockedAt,
      lastActivityAt: entry.lastActivityAt,
      autoLockMs: entry.autoLockMs,
      remainingMs,
    };
  }
}

export const spaceSessionService = new SpaceSessionService();
