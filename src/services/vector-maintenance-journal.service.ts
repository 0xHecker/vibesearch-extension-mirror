import { getDb } from "./DatabaseService";

const JOURNAL_ID = "vector-maintenance-journal";

export type VectorMaintenancePhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "swapped"
  | "db_committed";

export type VectorMaintenanceJournal = {
  version: 1;
  operationId: string | null;
  phase: VectorMaintenancePhase;
  startedAt: number | null;
  updatedAt: number;
  detail: string;
};

const defaultJournal = (): VectorMaintenanceJournal => ({
  version: 1,
  operationId: null,
  phase: "idle",
  startedAt: null,
  updatedAt: Date.now(),
  detail: "",
});

class VectorMaintenanceJournalService {
  private normalize(raw: unknown): VectorMaintenanceJournal {
    const base = defaultJournal();
    if (!raw || typeof raw !== "object") return base;
    const source = raw as Record<string, unknown>;
    const phase = source.phase;
    const normalizedPhase: VectorMaintenancePhase =
      phase === "preparing" ||
      phase === "prepared" ||
      phase === "swapped" ||
      phase === "db_committed" ||
      phase === "idle"
        ? phase
        : "idle";

    return {
      version: 1,
      operationId: typeof source.operationId === "string" ? source.operationId : null,
      phase: normalizedPhase,
      startedAt: typeof source.startedAt === "number" ? source.startedAt : null,
      updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : Date.now(),
      detail: typeof source.detail === "string" ? source.detail : "",
    };
  }

  public async read(): Promise<VectorMaintenanceJournal> {
    const db = await getDb();
    const doc = await db.getLocal<VectorMaintenanceJournal>(JOURNAL_ID);
    if (!doc) return defaultJournal();

    return this.normalize({
      version: doc.get("version"),
      operationId: doc.get("operationId"),
      phase: doc.get("phase"),
      startedAt: doc.get("startedAt"),
      updatedAt: doc.get("updatedAt"),
      detail: doc.get("detail"),
    });
  }

  public async setPhase(
    phase: VectorMaintenancePhase,
    options?: {
      operationId?: string | null;
      startedAt?: number | null;
      detail?: string;
    }
  ): Promise<VectorMaintenanceJournal> {
    const current = await this.read();
    const next: VectorMaintenanceJournal = {
      ...current,
      phase,
      operationId:
        options?.operationId !== undefined
          ? options.operationId
          : phase === "idle"
            ? null
            : current.operationId,
      startedAt:
        options?.startedAt !== undefined
          ? options.startedAt
          : phase === "idle"
            ? null
            : current.startedAt,
      detail: options?.detail ?? current.detail,
      updatedAt: Date.now(),
      version: 1,
    };
    const db = await getDb();
    await db.upsertLocal(JOURNAL_ID, next);
    return next;
  }

  public async begin(operationId: string, detail: string): Promise<VectorMaintenanceJournal> {
    return this.setPhase("preparing", {
      operationId,
      startedAt: Date.now(),
      detail,
    });
  }

  public async clear(detail = "idle"): Promise<VectorMaintenanceJournal> {
    return this.setPhase("idle", {
      operationId: null,
      startedAt: null,
      detail,
    });
  }

  public async remove(): Promise<void> {
    const db = await getDb();
    const doc = await db.getLocal<VectorMaintenanceJournal>(JOURNAL_ID);
    await doc?.remove();
  }
}

export const vectorMaintenanceJournalService = new VectorMaintenanceJournalService();
