import {
  DEFAULT_PRIVATE_AUTO_LOCK_MS,
  PRIVATE_PASSWORD_MIN_LENGTH,
  PRIVATE_SPACE_ID,
} from "@src/common/spaces";
import type { SpaceDocType } from "@src/schemas/space_schema";
import { notifyDatabaseChanged } from "@src/services/database/notifications";
import {
  DEFAULT_PASSWORD_ITERATIONS,
  hashPassword,
  hashRecoveryAnswer,
  verifyPassword,
  verifyRecoveryAnswer,
} from "@src/services/password-hash.service";
import { spaceSessionService } from "@src/services/space-session.service";
import { ensureDefaultSpaces } from "@src/services/spaces/defaults-and-repair";
import {
  getSpaceDatabase,
  readStoredString,
  writeStoredValue,
} from "@src/services/spaces/runtime";
import type {
  RecoveryQuestionInput,
  SpaceAccessState,
  SpaceOperationResult,
  SpacesControllerOptions,
} from "@src/services/spaces/types";

type AuthenticationFlow = "unlock" | "recover" | "change" | "set";

type AuthAttemptState = {
  windowStartedAt: number;
  failures: number;
  blockedUntil?: number;
};

type RecoveryCredentials = {
  hash1: string;
  salt1: string;
  iterations1: number;
  hash2: string;
  salt2: string;
  iterations2: number;
};

const AUTH_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const AUTH_ATTEMPT_MAX_FAILURES = 5;
const AUTH_ATTEMPT_BLOCK_MS = 2 * 60 * 1000;
const RECOVERY_PEPPER_STORAGE_KEY = "vibe.search.recoveryPepper.v1";

function authenticationKey(spaceId: string, flow: AuthenticationFlow): string {
  return `${flow}:${spaceId}`;
}

function normalizeRecoveryQuestions(input: RecoveryQuestionInput[]): RecoveryQuestionInput[] {
  return input
    .map((row) => ({
      question: row.question.trim().replace(/\s+/g, " ").slice(0, 160),
      answer: row.answer.trim(),
    }))
    .filter((row) => row.question.length > 0 && row.answer.length > 0)
    .slice(0, 2);
}

function randomPepper(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function recoveryCredentials(space: SpaceDocType): RecoveryCredentials | null {
  if (
    !space.recoveryHash1 ||
    !space.recoverySalt1 ||
    !space.recoveryHash2 ||
    !space.recoverySalt2
  ) {
    return null;
  }
  return {
    hash1: space.recoveryHash1,
    salt1: space.recoverySalt1,
    iterations1: space.recoveryIterations1 || DEFAULT_PASSWORD_ITERATIONS,
    hash2: space.recoveryHash2,
    salt2: space.recoverySalt2,
    iterations2: space.recoveryIterations2 || DEFAULT_PASSWORD_ITERATIONS,
  };
}

async function verifyPrivatePassword(space: SpaceDocType, password: string): Promise<boolean> {
  if (!space.passwordHash || !space.passwordSalt) return false;
  return verifyPassword(password, {
    salt: space.passwordSalt,
    hash: space.passwordHash,
    iterations: space.passwordIterations || DEFAULT_PASSWORD_ITERATIONS,
  });
}

export class SpaceAuthentication {
  private readonly authAttempts = new Map<string, AuthAttemptState>();

  constructor(private readonly options: SpacesControllerOptions) {}

  private assertNotRateLimited(key: string): void {
    const now = Date.now();
    const state = this.authAttempts.get(key);
    if (!state) return;
    if (state.blockedUntil && state.blockedUntil > now) {
      throw new Error("TOO_MANY_ATTEMPTS_RETRY_LATER");
    }
    if (state.blockedUntil && state.blockedUntil <= now) this.authAttempts.delete(key);
  }

  private recordFailure(key: string): void {
    const now = Date.now();
    const existing = this.authAttempts.get(key);
    if (!existing || now - existing.windowStartedAt > AUTH_ATTEMPT_WINDOW_MS) {
      this.authAttempts.set(key, { windowStartedAt: now, failures: 1 });
      return;
    }
    const failures = existing.failures + 1;
    this.authAttempts.set(key, {
      windowStartedAt: existing.windowStartedAt,
      failures,
      blockedUntil: failures >= AUTH_ATTEMPT_MAX_FAILURES
        ? now + AUTH_ATTEMPT_BLOCK_MS
        : existing.blockedUntil,
    });
  }

  private async getRecoveryPepper(): Promise<string> {
    const existing = await readStoredString(this.options, RECOVERY_PEPPER_STORAGE_KEY);
    if (existing) return existing;
    const created = randomPepper();
    await writeStoredValue(this.options, RECOVERY_PEPPER_STORAGE_KEY, created);
    return created;
  }

  async setPassword(payload: {
    spaceId?: string;
    password: string;
    currentPassword?: string;
    recoveryQuestions?: RecoveryQuestionInput[];
  }): Promise<{ success: boolean }> {
    const db = await getSpaceDatabase(this.options);
    await ensureDefaultSpaces(this.options, db);
    if (payload.password.length < PRIVATE_PASSWORD_MIN_LENGTH) {
      throw new Error("PASSWORD_TOO_SHORT");
    }
    const document = await db.spaces.findOne(payload.spaceId || PRIVATE_SPACE_ID).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (!space.isPrivate) throw new Error("SPACE_NOT_PRIVATE");

    if (space.passwordHash && space.passwordSalt) {
      const key = authenticationKey(space.id, "set");
      this.assertNotRateLimited(key);
      if (!payload.currentPassword?.trim()) throw new Error("PASSWORD_ALREADY_CONFIGURED");
      if (!await verifyPrivatePassword(space, payload.currentPassword)) {
        this.recordFailure(key);
        throw new Error("INVALID_PASSWORD");
      }
      this.authAttempts.delete(key);
    }

    const questions = normalizeRecoveryQuestions(payload.recoveryQuestions || []);
    if (questions.length !== 2) throw new Error("TWO_RECOVERY_QUESTIONS_REQUIRED");
    const [firstQuestion, secondQuestion] = questions;
    const password = await hashPassword(payload.password);
    const pepper = await this.getRecoveryPepper();
    const [firstRecovery, secondRecovery] = await Promise.all([
      hashRecoveryAnswer(firstQuestion.answer, { pepper }),
      hashRecoveryAnswer(secondQuestion.answer, { pepper }),
    ]);
    await document.patch({
      passwordSalt: password.salt,
      passwordHash: password.hash,
      passwordIterations: password.iterations,
      passwordVersion: 1,
      recoveryQuestion1: firstQuestion.question,
      recoveryQuestion2: secondQuestion.question,
      recoverySalt1: firstRecovery.salt,
      recoveryHash1: firstRecovery.hash,
      recoveryIterations1: firstRecovery.iterations,
      recoverySalt2: secondRecovery.salt,
      recoveryHash2: secondRecovery.hash,
      recoveryIterations2: secondRecovery.iterations,
      updatedAt: Date.now(),
    });
    spaceSessionService.unlockSpace(space.id, space.autoLockMs || DEFAULT_PRIVATE_AUTO_LOCK_MS);
    notifyDatabaseChanged("spaces");
    return { success: true };
  }

  async unlock(payload: {
    spaceId?: string;
    password: string;
  }): Promise<{ success: boolean }> {
    const db = await getSpaceDatabase(this.options);
    await ensureDefaultSpaces(this.options, db);
    const document = await db.spaces.findOne(payload.spaceId || PRIVATE_SPACE_ID).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (!space.isPrivate) return { success: true };
    if (!space.passwordHash || !space.passwordSalt) throw new Error("PASSWORD_NOT_CONFIGURED");

    const key = authenticationKey(space.id, "unlock");
    this.assertNotRateLimited(key);
    if (!await verifyPrivatePassword(space, payload.password || "")) {
      this.recordFailure(key);
      throw new Error("INVALID_PASSWORD");
    }
    this.authAttempts.delete(key);
    spaceSessionService.unlockSpace(space.id, space.autoLockMs || DEFAULT_PRIVATE_AUTO_LOCK_MS);
    notifyDatabaseChanged("spaces");
    return { success: true };
  }

  async changePassword(payload: {
    spaceId?: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ success: boolean }> {
    const db = await getSpaceDatabase(this.options);
    await ensureDefaultSpaces(this.options, db);
    const document = await db.spaces.findOne(payload.spaceId || PRIVATE_SPACE_ID).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (!space.isPrivate) throw new Error("SPACE_NOT_PRIVATE");
    if (payload.newPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
      throw new Error("PASSWORD_TOO_SHORT");
    }

    const key = authenticationKey(space.id, "change");
    this.assertNotRateLimited(key);
    if (!await verifyPrivatePassword(space, payload.currentPassword || "")) {
      this.recordFailure(key);
      throw new Error("INVALID_PASSWORD");
    }
    this.authAttempts.delete(key);
    const password = await hashPassword(payload.newPassword);
    await document.patch({
      passwordSalt: password.salt,
      passwordHash: password.hash,
      passwordIterations: password.iterations,
      passwordVersion: 1,
      updatedAt: Date.now(),
    });
    spaceSessionService.unlockSpace(space.id, space.autoLockMs || DEFAULT_PRIVATE_AUTO_LOCK_MS);
    notifyDatabaseChanged("spaces");
    return { success: true };
  }

  async recoverPassword(payload: {
    spaceId?: string;
    answer1: string;
    answer2: string;
    newPassword: string;
  }): Promise<{ success: boolean }> {
    const db = await getSpaceDatabase(this.options);
    await ensureDefaultSpaces(this.options, db);
    const document = await db.spaces.findOne(payload.spaceId || PRIVATE_SPACE_ID).exec();
    if (!document) throw new Error("SPACE_NOT_FOUND");
    const space = document.toMutableJSON();
    if (!space.isPrivate) throw new Error("SPACE_NOT_PRIVATE");
    if (payload.newPassword.length < PRIVATE_PASSWORD_MIN_LENGTH) {
      throw new Error("PASSWORD_TOO_SHORT");
    }
    const credentials = recoveryCredentials(space);
    if (!credentials) throw new Error("RECOVERY_NOT_CONFIGURED");

    const key = authenticationKey(space.id, "recover");
    this.assertNotRateLimited(key);
    const pepper = await this.getRecoveryPepper();
    const verifyPair = (answerPepper?: string): Promise<[boolean, boolean]> => Promise.all([
      verifyRecoveryAnswer(
        payload.answer1 || "",
        {
          salt: credentials.salt1,
          hash: credentials.hash1,
          iterations: credentials.iterations1,
        },
        { pepper: answerPepper },
      ),
      verifyRecoveryAnswer(
        payload.answer2 || "",
        {
          salt: credentials.salt2,
          hash: credentials.hash2,
          iterations: credentials.iterations2,
        },
        { pepper: answerPepper },
      ),
    ]);

    let [firstMatches, secondMatches] = await verifyPair(pepper);
    let usedLegacyPepper = false;
    if (!firstMatches || !secondMatches) {
      const legacyMatches = await verifyPair();
      if (legacyMatches[0] && legacyMatches[1]) {
        [firstMatches, secondMatches] = legacyMatches;
        usedLegacyPepper = true;
      }
    }
    if (!firstMatches || !secondMatches) {
      this.recordFailure(key);
      throw new Error("RECOVERY_ANSWERS_INVALID");
    }
    this.authAttempts.delete(key);

    const password = await hashPassword(payload.newPassword);
    const migratedRecovery = usedLegacyPepper
      ? await Promise.all([
          hashRecoveryAnswer(payload.answer1 || "", { pepper }),
          hashRecoveryAnswer(payload.answer2 || "", { pepper }),
        ])
      : null;
    await document.patch({
      passwordSalt: password.salt,
      passwordHash: password.hash,
      passwordIterations: password.iterations,
      passwordVersion: 1,
      recoverySalt1: migratedRecovery?.[0].salt ?? credentials.salt1,
      recoveryHash1: migratedRecovery?.[0].hash ?? credentials.hash1,
      recoveryIterations1: migratedRecovery?.[0].iterations ?? credentials.iterations1,
      recoverySalt2: migratedRecovery?.[1].salt ?? credentials.salt2,
      recoveryHash2: migratedRecovery?.[1].hash ?? credentials.hash2,
      recoveryIterations2: migratedRecovery?.[1].iterations ?? credentials.iterations2,
      updatedAt: Date.now(),
    });
    spaceSessionService.unlockSpace(space.id, space.autoLockMs || DEFAULT_PRIVATE_AUTO_LOCK_MS);
    notifyDatabaseChanged("spaces");
    return { success: true };
  }

  lock(payload: { spaceId?: string }): SpaceOperationResult {
    spaceSessionService.lockSpace(payload.spaceId || PRIVATE_SPACE_ID);
    notifyDatabaseChanged("spaces");
    return { success: true };
  }

  touch(payload: { spaceId: string }): SpaceOperationResult {
    return { success: Boolean(payload.spaceId) && spaceSessionService.touchSpace(payload.spaceId) };
  }

  async getAccessState(payload?: { spaceId?: string }): Promise<SpaceAccessState> {
    const db = await getSpaceDatabase(this.options);
    await ensureDefaultSpaces(this.options, db);
    const ids = payload?.spaceId
      ? [payload.spaceId]
      : (await db.spaces.find({ selector: { isArchived: { $eq: false } } }).exec())
          .map((document) => document.primary);
    const access: SpaceAccessState["access"] = {};
    for (const spaceId of ids) {
      const state = spaceSessionService.getState(spaceId);
      access[spaceId] = {
        isUnlocked: state.isUnlocked,
        remainingMs: state.remainingMs,
        lastActivityAt: state.lastActivityAt,
      };
    }
    return { access };
  }
}
