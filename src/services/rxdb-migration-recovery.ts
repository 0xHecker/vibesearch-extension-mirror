import {
  getAllCollectionDocuments,
  getRxReplicationMetaInstanceSchema,
  hasEncryption,
  overwritable,
  type RxCollection,
  type RxStorageInstance,
} from "rxdb";
import {
  getOldCollectionMeta,
  RxMigrationState,
} from "rxdb/plugins/migration-schema";

export const MIGRATION_RECOVERY_MAX_BATCH_SIZE = 200;

export type MigrationRecoveryRetentionSample = {
  pendingRequestCount: number;
  activeRequestCount: number;
  retainedPrimaryCount: number;
  retainedLookupDocumentCount: number;
  resolvedRequestCount: number;
};

export type MigrationRecoveryOptions = {
  /** Test/diagnostic hook. It receives counts only and never document bodies. */
  onRetentionSample?: (sample: MigrationRecoveryRetentionSample) => void;
};

type HistoricalDocumentWinner = {
  sourceVersion: number;
  storageWriteTime: number;
  applicationWriteTime: number;
  deleted: boolean;
};

type HistoricalCollectionMeta = Awaited<
  ReturnType<typeof getAllCollectionDocuments>
>[number];

type HistoricalLookupRequest = {
  primary: string;
  sourceVersion: number;
  resolve: (isWinner: boolean) => void;
  reject: (error: unknown) => void;
};

const finiteTimestamp = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const historicalWinnerForDocument = (
  document: Record<string, any>,
  sourceVersion: number
): HistoricalDocumentWinner => ({
  sourceVersion,
  // RxDB preserves _meta.lwt across schema migrations, making it the most
  // reliable chronology when a released schema version was later reset.
  storageWriteTime: finiteTimestamp(document._meta?.lwt),
  applicationWriteTime: Math.max(
    finiteTimestamp(document.updatedAt),
    finiteTimestamp(document.deletedAt),
    finiteTimestamp(document.createdAt)
  ),
  deleted: document._deleted === true || finiteTimestamp(document.deletedAt) > 0,
});

export const shouldReplaceHistoricalWinner = (
  current: HistoricalDocumentWinner | undefined,
  candidate: HistoricalDocumentWinner
): boolean => {
  if (!current) return true;
  if (candidate.storageWriteTime !== current.storageWriteTime) {
    return candidate.storageWriteTime > current.storageWriteTime;
  }
  if (candidate.applicationWriteTime !== current.applicationWriteTime) {
    return candidate.applicationWriteTime > current.applicationWriteTime;
  }
  // Never resurrect a live row over an equally fresh tombstone.
  if (candidate.deleted !== current.deleted) return candidate.deleted;
  // Deterministic final tie for identical migrated revisions.
  return candidate.sourceVersion > current.sourceVersion;
};

export const boundedMigrationRecoveryBatchSize = (requestedBatchSize: number): number => {
  if (!Number.isFinite(requestedBatchSize)) return MIGRATION_RECOVERY_MAX_BATCH_SIZE;
  return Math.max(
    1,
    Math.min(Math.floor(requestedBatchSize), MIGRATION_RECOVERY_MAX_BATCH_SIZE)
  );
};

/**
 * Keeps lookup handles only for future schema versions. The store currently
 * being migrated is opened for one lookup batch and closed before strategies
 * resolve, so RxMigrationState can remove that store without another open
 * handle blocking it.
 */
class HistoricalLookupCatalog {
  private readonly persistentStorages = new Map<
    number,
    RxStorageInstance<any, any, any>
  >();

  constructor(
    private readonly collection: RxCollection,
    private readonly metas: HistoricalCollectionMeta[]
  ) {}

  versionsAtOrAfter(version: number): number[] {
    return this.metas
      .map((meta) => meta.data.schema.version)
      .filter((candidateVersion) => candidateVersion >= version);
  }

  async closeVersion(version: number): Promise<void> {
    const storage = this.persistentStorages.get(version);
    if (!storage) return;
    this.persistentStorages.delete(version);
    await storage.close();
  }

  async findDocumentsById(
    version: number,
    activeVersion: number,
    ids: string[]
  ): Promise<Record<string, any>[]> {
    if (version === activeVersion) {
      const storage = await this.openStorage(version);
      try {
        return await storage.findDocumentsById(ids, true);
      } finally {
        await storage.close();
      }
    }

    let storage = this.persistentStorages.get(version);
    if (!storage) {
      storage = await this.openStorage(version);
      this.persistentStorages.set(version, storage);
    }
    return storage.findDocumentsById(ids, true);
  }

  async close(): Promise<void> {
    const storages = [...this.persistentStorages.values()];
    this.persistentStorages.clear();
    await Promise.all(storages.map((storage) => storage.close()));
  }

  private async openStorage(version: number): Promise<RxStorageInstance<any, any, any>> {
    const meta = this.metas.find((candidate) => candidate.data.schema.version === version);
    if (!meta) {
      throw new Error(
        `Missing historical ${this.collection.name} metadata for schema v${version}`
      );
    }

    return this.collection.database.storage.createStorageInstance({
      databaseName: this.collection.database.name,
      collectionName: this.collection.name,
      databaseInstanceToken: this.collection.database.token,
      multiInstance: this.collection.database.multiInstance,
      options: {},
      schema: meta.data.schema,
      password: this.collection.database.password,
      devMode: overwritable.isDevMode(),
    });
  }
}

/**
 * RxDB invokes migration strategies concurrently for one push batch. Coalesce
 * those calls into one bounded point lookup per store, then reduce each store's
 * result immediately to compact winner metadata. No full-library ID or winner
 * map survives a batch.
 */
class HistoricalWinnerBatchLookup {
  private readonly pending: HistoricalLookupRequest[] = [];
  private pumpPromise: Promise<void> | undefined;
  private fatalError: unknown;
  private activeRequestCount = 0;
  private retainedPrimaryCount = 0;
  private retainedLookupDocumentCount = 0;
  private resolvedRequestCount = 0;

  constructor(
    private readonly collection: RxCollection,
    private readonly catalog: HistoricalLookupCatalog,
    private readonly activeVersion: number,
    private readonly batchSize: number,
    private readonly onRetentionSample?: MigrationRecoveryOptions["onRetentionSample"]
  ) {}

  isHistoricalWinner(primary: string, sourceVersion: number): Promise<boolean> {
    if (this.fatalError) return Promise.reject(this.fatalError);

    const result = new Promise<boolean>((resolve, reject) => {
      this.pending.push({ primary, sourceVersion, resolve, reject });
      this.sample();
    });
    this.schedulePump();
    return result;
  }

  async close(): Promise<void> {
    await this.pumpPromise;
    if (this.pending.length > 0) {
      throw new Error("Historical winner lookup closed with pending requests");
    }
  }

  private schedulePump(): void {
    if (this.pumpPromise) return;
    const pumpPromise = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.pumpPromise = undefined;
        if (this.pending.length > 0 && !this.fatalError) this.schedulePump();
      });
    // Strategy promises carry the same error into RxDB. Attach a handler now
    // so runtimes do not report the pump as unhandled before close() awaits it.
    void pumpPromise.catch(() => undefined);
    this.pumpPromise = pumpPromise;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const requests = this.pending.splice(0, this.batchSize);
      this.activeRequestCount = requests.length;
      this.sample();

      try {
        const winners = await this.lookupWinners(requests);
        for (const request of requests) {
          request.resolve(winners.get(request.primary) === request.sourceVersion);
        }
        this.resolvedRequestCount += requests.length;
      } catch (error) {
        this.fatalError = error;
        for (const request of requests) request.reject(error);
        for (const request of this.pending.splice(0)) request.reject(error);
        throw error;
      } finally {
        this.activeRequestCount = 0;
        this.retainedPrimaryCount = 0;
        this.retainedLookupDocumentCount = 0;
        this.sample();
      }
    }
  }

  private async lookupWinners(
    requests: HistoricalLookupRequest[]
  ): Promise<Map<string, number>> {
    const uniquePrimaries = [...new Set(requests.map((request) => request.primary))];
    this.retainedPrimaryCount = uniquePrimaries.length;
    this.sample();

    // Any target row, including a target tombstone or a winner recovered by a
    // previous version, is authoritative. A lower version was inserted only
    // after it had already beaten every still-future historical version.
    let lookupDocuments = await this.collection.storageInstance.originalStorageInstance
      .findDocumentsById(uniquePrimaries, true);
    this.retainedLookupDocumentCount = lookupDocuments.length;
    const authoritativePrimaries = new Set(
      lookupDocuments.map((document) =>
        this.collection.schema.getPrimaryOfDocumentData(document)
      )
    );
    lookupDocuments = [];

    const unresolvedPrimaries = uniquePrimaries.filter(
      (primary) => !authoritativePrimaries.has(primary)
    );
    const winners = new Map<string, HistoricalDocumentWinner>();
    this.retainedLookupDocumentCount = 0;
    this.retainedPrimaryCount =
      uniquePrimaries.length + authoritativePrimaries.size + unresolvedPrimaries.length;
    this.sample();

    for (const version of this.catalog.versionsAtOrAfter(this.activeVersion)) {
      if (unresolvedPrimaries.length === 0) break;
      lookupDocuments = await this.catalog.findDocumentsById(
        version,
        this.activeVersion,
        unresolvedPrimaries
      );
      this.retainedLookupDocumentCount = lookupDocuments.length;
      this.sample();

      for (const document of lookupDocuments) {
        const primary = this.collection.schema.getPrimaryOfDocumentData(document);
        const candidate = historicalWinnerForDocument(document, version);
        if (shouldReplaceHistoricalWinner(winners.get(primary), candidate)) {
          winners.set(primary, candidate);
        }
      }

      lookupDocuments = [];
      this.retainedLookupDocumentCount = 0;
      this.retainedPrimaryCount =
        uniquePrimaries.length +
        authoritativePrimaries.size +
        unresolvedPrimaries.length +
        winners.size;
      this.sample();
    }

    const winnerVersions = new Map<string, number>();
    for (const primary of uniquePrimaries) {
      if (authoritativePrimaries.has(primary)) continue;
      const winner = winners.get(primary);
      if (winner) winnerVersions.set(primary, winner.sourceVersion);
    }
    this.retainedPrimaryCount += winnerVersions.size;
    this.sample();
    return winnerVersions;
  }

  private sample(): void {
    this.onRetentionSample?.({
      pendingRequestCount: this.pending.length,
      activeRequestCount: this.activeRequestCount,
      retainedPrimaryCount: this.retainedPrimaryCount,
      retainedLookupDocumentCount: this.retainedLookupDocumentCount,
      resolvedRequestCount: this.resolvedRequestCount,
    });
  }
}

const recoveryRunCounters = new WeakMap<RxCollection, number>();

const nextRecoveryRun = (collection: RxCollection): number => {
  const next = (recoveryRunCounters.get(collection) ?? 0) + 1;
  recoveryRunCounters.set(collection, next);
  return next;
};

/**
 * RxDB intentionally keeps its replication checkpoint after an error. That
 * checkpoint can already point past a failed write batch, so reusing it may
 * skip the failed rows on retry. Clear only migration replication metadata;
 * successfully written target rows remain and win the replay's point lookup.
 */
const resetFailedMigrationCheckpoints = async (
  collection: RxCollection,
  oldMeta: HistoricalCollectionMeta
): Promise<void> => {
  const storageDefinitions = [
    {
      collectionName: collection.name,
      schema: oldMeta.data.schema,
    },
    ...oldMeta.data.connectedStorages.map((connectedStorage) => ({
      collectionName: connectedStorage.collectionName,
      schema: connectedStorage.schema,
    })),
  ];

  for (const definition of storageDefinitions) {
    const replicationMetaStorage = await collection.database.storage.createStorageInstance({
      databaseName: collection.database.name,
      collectionName: [
        "rx-migration-state-meta",
        definition.collectionName,
        definition.schema.version,
      ].join("-"),
      databaseInstanceToken: collection.database.token,
      multiInstance: collection.database.multiInstance,
      options: {},
      schema: getRxReplicationMetaInstanceSchema(
        definition.schema,
        hasEncryption(definition.schema)
      ),
      password: collection.database.password,
      devMode: overwritable.isDevMode(),
    });
    await replicationMetaStorage.remove();
  }
};

/**
 * RxDB normally migrates one previous collection version. A historical
 * version downgrade left more than one old store behind, so keep migrating
 * until every stranded version has been merged into the current collection.
 *
 * Reconciliation is bounded by MIGRATION_RECOVERY_MAX_BATCH_SIZE regardless
 * of library size. The current target is checked by ID for each batch, and
 * historical versions are reduced one at a time to winner metadata.
 */
export const migrateAllHistoricalCollectionVersions = async (
  collection: RxCollection,
  batchSize = MIGRATION_RECOVERY_MAX_BATCH_SIZE,
  options: MigrationRecoveryOptions = {}
): Promise<number[]> => {
  const migratedVersions: number[] = [];
  const finalVersion = collection.schema.version;
  const finalStrategy = collection.migrationStrategies[finalVersion];

  if (!finalStrategy && finalVersion > 0) {
    throw new Error(
      `Missing final migration strategy for ${collection.name} v${finalVersion}`
    );
  }

  // The common path after a successful recovery has no old collection at all.
  // Check metadata before opening historical stores or reading current rows so
  // normal startup remains O(1) in library size.
  let oldMeta = await getOldCollectionMeta({
    collection,
    database: collection.database,
  } as RxMigrationState);
  if (!oldMeta) return migratedVersions;

  const effectiveBatchSize = boundedMigrationRecoveryBatchSize(batchSize);
  const historicalMetas = (await getAllCollectionDocuments(
    collection.database.internalStore
  ))
    .filter((meta) => meta.data.name === collection.name)
    .filter((meta) => meta.data.schema.version < finalVersion)
    .sort((left, right) => left.data.schema.version - right.data.schema.version);
  const catalog = new HistoricalLookupCatalog(collection, historicalMetas);
  const recoveryRun = nextRecoveryRun(collection);

  try {
    for (let attempt = 0; attempt < finalVersion; attempt += 1) {
      if (!oldMeta) break;

      const oldVersion: number = oldMeta.data.schema.version;
      const strategies = collection.migrationStrategies;
      await catalog.closeVersion(oldVersion);
      const lookup = new HistoricalWinnerBatchLookup(
        collection,
        catalog,
        oldVersion,
        effectiveBatchSize,
        options.onRetentionSample
      );

      strategies[finalVersion] = async (oldDocument, targetCollection) => {
        const migratedDocument = await finalStrategy(oldDocument, targetCollection);
        if (migratedDocument === null) return null;

        const primary = collection.schema.getPrimaryOfDocumentData(migratedDocument);
        return (await lookup.isHistoricalWinner(primary, oldVersion))
          ? migratedDocument
          : null;
      };

      let migrationFailed = false;
      let migrationError: unknown;
      let lookupCloseFailed = false;
      let lookupCloseError: unknown;
      try {
        const migration = new RxMigrationState(
          collection,
          strategies,
          [
            collection.name,
            "recovery",
            collection.database.token,
            `run${recoveryRun}`,
            `v${oldVersion}-to-v${finalVersion}`,
          ].join("-")
        );
        await migration.migratePromise(effectiveBatchSize);
      } catch (error) {
        migrationFailed = true;
        migrationError = error;
      } finally {
        strategies[finalVersion] = finalStrategy;
        // A rejected strategy can make RxDB's Promise.all fail before sibling
        // lookups settle. Drain those bounded siblings before closing catalog
        // handles so a retry never races an abandoned lookup.
        try {
          await lookup.close();
        } catch (error) {
          lookupCloseFailed = true;
          lookupCloseError = error;
        }
      }

      if (migrationFailed || lookupCloseFailed) {
        const primaryError = migrationFailed ? migrationError : lookupCloseError;
        try {
          await resetFailedMigrationCheckpoints(collection, oldMeta);
        } catch (resetError) {
          throw new AggregateError(
            [primaryError, resetError],
            `Failed ${collection.name} migration and checkpoint reset`
          );
        }
        throw primaryError;
      }

      const remainingOldMeta = await getOldCollectionMeta({
        collection,
        database: collection.database,
      } as RxMigrationState);
      if (remainingOldMeta?.data.schema.version === oldVersion) {
        throw new Error(
          `Historical ${collection.name} v${oldVersion} migration made no progress`
        );
      }

      migratedVersions.push(oldVersion);
      oldMeta = remainingOldMeta;
    }
  } finally {
    await catalog.close();
  }

  return migratedVersions;
};
