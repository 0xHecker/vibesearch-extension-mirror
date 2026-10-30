import { getDb, type MyDatabase } from "@src/services/DatabaseService";
import { ItemDocType } from "@src/schemas/item_schema";
import {
  cloneOpfsMediaEntriesForItem,
  readOpfsFileIdentity,
} from "@src/services/media-storage";
import { deleteUnreferencedOpfsItemDirectories } from "@src/services/opfs-media-lifecycle";
import type {
  QueryTextExpression,
  RankableItem,
} from "@src/search-core/contracts";
import { resolveEffectiveQueryChannels } from "@src/search-core/contracts";
import { legacyBrowserEnabled } from "@src/services/extension-policy";
import {
  deleteItem,
  deleteItemForever,
  restoreItemFromBin,
  type DeleteItemForeverPayload,
  type DeleteItemPayload,
  type ItemBinMutationResult,
  type RestoreItemFromBinPayload,
  type RestoreItemFromBinResult,
} from "@src/services/items/bin-lifecycle";
import {
  vectorStoreService,
  type VectorQueryLease,
} from "@src/services/vector-store.service";
import { localSearchIndexService } from "@src/services/local-search-index.service";
import { MAX_GRID_QUERY_LIMIT } from "@src/search-core/pagination";
import {
  RANK_REQUEST_SUPERSEDED,
  SupersededRankRequestError,
} from "@src/services/query-ranker.service";
import { notifyArchivedItemsPurged } from "@src/services/archive-lifecycle";
import {
  copyItemsToSpace,
  moveItemsToSpace,
  type CopyItemsToSpaceResult,
  type MoveItemsToSpaceResult,
} from "@src/services/items/space-transfer";
import {
  addItemMedia,
  removeItemMedia,
  replaceItemMedia,
  updateItemMedia,
  type AddItemMediaPayload,
  type ItemMediaMutationResult,
  type RemoveItemMediaPayload,
  type ReplaceItemMediaPayload,
  type UpdateItemMediaPayload,
} from "@src/services/items/media-mutations";
import {
  applyOpfsMediaPromotions,
  deleteUnreferencedOpfsMedia,
  listItemsWithOpfsMedia,
  reconcileOrphanedOpfsItemDirectories,
  type ApplyOpfsMediaPromotionsPayload,
  type ApplyOpfsMediaPromotionsResult,
  type DeleteUnreferencedOpfsMediaPayload,
  type DeleteUnreferencedOpfsMediaResult,
  type ListItemsWithOpfsMediaPayload,
  type ListItemsWithOpfsMediaResult,
  type ReconcileOrphanedOpfsPayload,
  type ReconcileOrphanedOpfsResult,
} from "@src/services/items/opfs-media";
import {
  getPendingMetadataUrls,
  saveFetchedMetadata,
  type PendingMetadataUrlsPayload,
  type PendingMetadataUrlsResult,
  type SaveFetchedMetadataPayload,
  type SaveFetchedMetadataResult,
} from "@src/services/items/metadata";
import {
  addItemToFolder,
  addManyItems,
  findLiveItemByUrls,
  getItemsByIds,
  moveItemsToFolder,
  refetchItemMetadata,
  reorderItems,
  updateItem,
  type AddItemToFolderPayload,
  type AddManyItemsPayload,
  type AddManyItemsResult,
  type FindLiveItemsByUrlPayload,
  type GetItemsByIdsPayload,
  type ItemUpdateCount,
  type LiveItemIdentity,
  type MoveItemsToFolderPayload,
  type ReorderItemsPayload,
  type UpdateItemPayload,
  type UpdateItemResult,
} from "@src/services/items/records";
import {
  resolveAllowedSpaceIds,
} from "@src/services/items/access";
import {
  ItemSearchRanker,
  type CandidateDocument,
  type QueryHashInput,
  type RankLocallyArgs,
  type RankLocallyResult,
  type VectorSelection,
} from "@src/services/items/search-ranker";
import { ItemSearchSession } from "@src/services/items/search-session";
import {
  VECTOR_QUERY_MIN_CHARS,
  type CandidateLite,
  type LocalQueryPayload,
  type LocalQueryResponse,
  type LocalQuerySortBy,
  type LocalQuerySortOrder,
  type SearchTelemetry,
  type VectorScoreResult,
} from "@src/services/items/search-model";
import {
  runLocalQueryWithVectorLease,
  type ItemLocalQueryRuntime,
} from "@src/services/items/local-query";

export type ItemsControllerOptions = {
  getDb?: typeof getDb;
  readOpfsFileIdentity?: typeof readOpfsFileIdentity;
  cloneOpfsMediaEntriesForItem?: typeof cloneOpfsMediaEntriesForItem;
  deleteUnreferencedOpfsItemDirectories?: typeof deleteUnreferencedOpfsItemDirectories;
  notifyArchivedItemsPurged?: typeof notifyArchivedItemsPurged;
};

export class ItemsController {
  constructor(private readonly options: ItemsControllerOptions = {}) {}

  private getDatabase(): ReturnType<typeof getDb> {
    return (this.options.getDb ?? getDb)();
  }

  private readonly searchSession = new ItemSearchSession();
  private readonly searchRanker = new ItemSearchRanker();
  private rankTelemetry: SearchTelemetry = {
    supersededCount: 0,
    fallbackCount: 0,
  };
  private currentVectorStore = vectorStoreService;

  private get vectorStore(): typeof vectorStoreService {
    return this.currentVectorStore;
  }

  private set vectorStore(service: typeof vectorStoreService) {
    this.currentVectorStore = service;
  }

  private get searchContextsByClient() {
    return this.searchSession.searchContextsByClient;
  }

  private get activeVectorSearchAbortController(): AbortController | null {
    return this.searchSession.activeVectorSearchAbortController;
  }

  private beginSearchGeneration(clientId?: string): number {
    return this.searchSession.begin(clientId);
  }

  private assertSearchGeneration(generation: number): void {
    this.searchSession.assertCurrent(generation);
  }

  private getSearchSignal(generation: number): AbortSignal {
    return this.searchSession.signal(generation);
  }

  private getSearchClientId(generation: number): string {
    return this.searchSession.clientId(generation);
  }

  private startLexicalSearchPhase(generation: number): AbortController {
    return this.searchSession.startLexical(generation);
  }

  private finishLexicalSearchPhase(
    generation: number,
    controller: AbortController,
  ): void {
    this.searchSession.finishLexical(generation, controller);
  }

  private startVectorSearchPhase(generation: number): AbortController {
    return this.searchSession.startVector(generation);
  }

  private finishVectorSearchPhase(
    generation: number,
    controller: AbortController,
  ): void {
    this.searchSession.finishVector(generation, controller);
  }

  private finishSearchGeneration(generation: number): void {
    this.searchSession.finish(generation);
  }

  markSearchIndexDirty() {
    localSearchIndexService.markDirty();
  }

  scheduleSearchIndexSync(changedItemIds?: string[]) {
    localSearchIndexService.scheduleItemSync(changedItemIds);
  }

  private tokenizeQuery(query: string): string[] {
    return this.searchRanker.tokenizeQuery(query);
  }

  private resolveVectorQueryText(payload: LocalQueryPayload): string {
    return this.searchRanker.resolveVectorQueryText(payload);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout?: () => void,
  ): Promise<T> {
    return this.searchSession.withTimeout(promise, timeoutMs, message, onTimeout);
  }

  private buildQueryHash(payload: QueryHashInput): string {
    return this.searchRanker.buildQueryHash(payload);
  }

  private toRankableItem(
    item: CandidateLite,
    textContent: string,
    ocrText: string,
  ): RankableItem {
    return this.searchRanker.toRankableItem(item, textContent, ocrText);
  }

  private toCandidateLite(document: CandidateDocument): CandidateLite {
    return this.searchRanker.toCandidateLite(document);
  }

  private collectPositiveExpressionTerms(node: QueryTextExpression): string[] {
    return this.searchRanker.collectPositiveExpressionTerms(node);
  }

  private selectVectorResults(
    results: VectorScoreResult[],
    minScore?: number,
  ): VectorSelection {
    return this.searchRanker.selectVectorResults(results, minScore);
  }

  private rankLocally(args: RankLocallyArgs): RankLocallyResult {
    return this.searchRanker.rankLocally(args);
  }

  private compareByField(
    left: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    right: Pick<RankableItem, "id" | "title" | "source" | "createdAt" | "updatedAt">,
    sortBy: Exclude<LocalQuerySortBy, "relevance">,
    sortOrder: LocalQuerySortOrder,
  ): number {
    return this.searchRanker.compareByField(left, right, sortBy, sortOrder);
  }

  async saveFetchedMetadata(
    payload: SaveFetchedMetadataPayload,
  ): Promise<SaveFetchedMetadataResult> {
    return saveFetchedMetadata(await this.getDatabase(), payload);
  }

  async getPendingMetadataUrls(
    payload: PendingMetadataUrlsPayload = {},
  ): Promise<PendingMetadataUrlsResult> {
    return getPendingMetadataUrls(await this.getDatabase(), payload);
  }

  private resolveAllowedSpaceIds(
    db: MyDatabase,
    payload: LocalQueryPayload,
  ): Promise<string[]> {
    return resolveAllowedSpaceIds(db, payload.accessContext);
  }

  async moveToSpace(payload: {
    itemIds: string[];
    targetSpaceId: string;
  }): Promise<MoveItemsToSpaceResult> {
    const db = await this.getDatabase();
    return moveItemsToSpace(db, payload);
  }

  async copyToSpace(payload: {
    itemIds: string[];
    targetSpaceId: string;
  }): Promise<CopyItemsToSpaceResult> {
    const db = await this.getDatabase();
    return copyItemsToSpace(db, payload, {
      cloneOpfsMediaEntriesForItem: this.options.cloneOpfsMediaEntriesForItem,
    });
  }

  async queryLocal(payload: LocalQueryPayload): Promise<LocalQueryResponse> {
    // Search requests race while the user types. Stop an older cooperative
    // lexical/vector scan immediately instead of letting it retain index pages,
    // vectors, and CPU in the offscreen document until completion.
    const searchGeneration = this.beginSearchGeneration(payload.searchClientId);
    const searchSignal = this.getSearchSignal(searchGeneration);

    let vectorQueryLease: VectorQueryLease | null = null;
    try {
      const requestedChannels = resolveEffectiveQueryChannels({
        requested: {
          keyword: payload.useKeyword !== false,
          fuzzy: payload.useFuzzy === true,
          vector: payload.useVector === true,
        },
        query: this.resolveVectorQueryText(payload),
        vectorMinChars: VECTOR_QUERY_MIN_CHARS,
        vectorAvailable: await legacyBrowserEnabled(),
      });
      if (requestedChannels.vector) {
        vectorQueryLease = await this.vectorStore.acquireQueryLease(searchSignal);
        this.assertSearchGeneration(searchGeneration);
      }
      try {
        return await this.queryLocalWithVectorLease(
          payload,
          searchGeneration,
          searchSignal,
          vectorQueryLease
        );
      } catch (error) {
        if (
          error instanceof SupersededRankRequestError ||
          error instanceof Error &&
          (error.message === RANK_REQUEST_SUPERSEDED || error.name === RANK_REQUEST_SUPERSEDED)
        ) {
          // A newer keystroke won the race. Benign concurrency outcome, not a
          // failure: resolve in-band so the router does not log an error and
          // the UI keeps its currently rendered results.
          this.rankTelemetry.supersededCount += 1;
          return {
            items: [],
            total: 0,
            totalIsExact: true,
            vectorHits: 0,
            lexicalHits: 0,
            sortBy: payload.sort?.by || "relevance",
            sortOrder: payload.sort?.order || "desc",
            page: Math.max(1, payload.pagination?.page || 1),
            limit: Math.max(
              1,
              Math.min(payload.pagination?.limit || payload.topK || 100, MAX_GRID_QUERY_LIMIT)
            ),
            hasMore: false,
            nextCursor: null,
            superseded: true,
          };
        }
        throw error;
      }
    } finally {
      vectorQueryLease?.release();
      this.finishSearchGeneration(searchGeneration);
    }
  }

  private localQueryRuntime(): ItemLocalQueryRuntime {
    return {
      getDatabase: () => this.getDatabase(),
      tokenizeQuery: (query) => this.tokenizeQuery(query),
      resolveVectorQueryText: (payload) => this.resolveVectorQueryText(payload),
      collectPositiveExpressionTerms: (expression) =>
        this.collectPositiveExpressionTerms(expression),
      resolveAllowedSpaceIds: (db, payload) =>
        this.resolveAllowedSpaceIds(db, payload),
      assertSearchGeneration: (generation) =>
        this.assertSearchGeneration(generation),
      buildQueryHash: (payload) => this.buildQueryHash(payload),
      startLexicalSearchPhase: (generation) =>
        this.startLexicalSearchPhase(generation),
      finishLexicalSearchPhase: (generation, controller) =>
        this.finishLexicalSearchPhase(generation, controller),
      withTimeout: (promise, timeoutMs, message, onTimeout) =>
        this.withTimeout(promise, timeoutMs, message, onTimeout),
      getSearchClientId: (generation) => this.getSearchClientId(generation),
      toCandidateLite: (document) => this.toCandidateLite(document),
      startVectorSearchPhase: (generation) =>
        this.startVectorSearchPhase(generation),
      finishVectorSearchPhase: (generation, controller) =>
        this.finishVectorSearchPhase(generation, controller),
      selectVectorResults: (results, minScore) =>
        this.selectVectorResults(results, minScore),
      compareByField: (left, right, sortBy, sortOrder) =>
        this.compareByField(left, right, sortBy, sortOrder),
      toRankableItem: (item, textContent, ocrText) =>
        this.toRankableItem(item, textContent, ocrText),
      rankLocally: (args) => this.rankLocally(args),
      rankTelemetry: this.rankTelemetry,
    };
  }

  private queryLocalWithVectorLease(
    payload: LocalQueryPayload,
    searchGeneration: number,
    searchSignal: AbortSignal,
    vectorQueryLease: VectorQueryLease | null,
  ): Promise<LocalQueryResponse> {
    return runLocalQueryWithVectorLease(
      this.localQueryRuntime(),
      payload,
      searchGeneration,
      searchSignal,
      vectorQueryLease,
    );
  }

  async getByIds(payload: GetItemsByIdsPayload): Promise<ItemDocType[]> {
    return getItemsByIds(await this.getDatabase(), payload);
  }

  async findLiveByUrls(
    payload: FindLiveItemsByUrlPayload,
  ): Promise<LiveItemIdentity | null> {
    return findLiveItemByUrls(await this.getDatabase(), payload);
  }

  async addToFolder(payload: AddItemToFolderPayload): Promise<ItemDocType> {
    return addItemToFolder(await this.getDatabase(), payload);
  }

  async addMany(payload: AddManyItemsPayload): Promise<AddManyItemsResult> {
    return addManyItems(await this.getDatabase(), payload);
  }

  async refetchMetadata(itemIds: string[]): Promise<void> {
    return refetchItemMetadata(await this.getDatabase(), itemIds);
  }

  async moveToFolder(
    payload: MoveItemsToFolderPayload,
  ): Promise<ItemUpdateCount> {
    return moveItemsToFolder(await this.getDatabase(), payload);
  }

  async reorder(payload: ReorderItemsPayload): Promise<ItemUpdateCount> {
    return reorderItems(await this.getDatabase(), payload);
  }

  async delete(payload: DeleteItemPayload): Promise<ItemBinMutationResult> {
    return deleteItem(await this.getDatabase(), payload);
  }

  async restoreFromBin(
    payload: RestoreItemFromBinPayload,
  ): Promise<RestoreItemFromBinResult> {
    return restoreItemFromBin(await this.getDatabase(), payload);
  }

  async deleteForever(
    payload: DeleteItemForeverPayload,
  ): Promise<ItemBinMutationResult> {
    return deleteItemForever(await this.getDatabase(), payload, {
      deleteUnreferencedOpfsItemDirectories:
        this.options.deleteUnreferencedOpfsItemDirectories,
      notifyArchivedItemsPurged: this.options.notifyArchivedItemsPurged,
    });
  }

  async updateMedia(
    payload: UpdateItemMediaPayload,
  ): Promise<ItemMediaMutationResult> {
    return updateItemMedia(await this.getDatabase(), payload);
  }

  async removeMedia(
    payload: RemoveItemMediaPayload,
  ): Promise<ItemMediaMutationResult> {
    return removeItemMedia(await this.getDatabase(), payload);
  }

  async addMedia(payload: AddItemMediaPayload): Promise<ItemMediaMutationResult> {
    return addItemMedia(await this.getDatabase(), payload);
  }

  async replaceMedia(
    payload: ReplaceItemMediaPayload,
  ): Promise<ItemMediaMutationResult> {
    return replaceItemMedia(await this.getDatabase(), payload);
  }

  async listItemsWithOpfsMedia(
    payload: ListItemsWithOpfsMediaPayload = {},
  ): Promise<ListItemsWithOpfsMediaResult> {
    return listItemsWithOpfsMedia(await this.getDatabase(), payload);
  }

  async applyOpfsMediaPromotions(
    payload: ApplyOpfsMediaPromotionsPayload,
  ): Promise<ApplyOpfsMediaPromotionsResult> {
    return applyOpfsMediaPromotions(await this.getDatabase(), payload, {
      readOpfsFileIdentity: this.options.readOpfsFileIdentity,
    });
  }

  async deleteUnreferencedOpfsMedia(
    payload: DeleteUnreferencedOpfsMediaPayload,
  ): Promise<DeleteUnreferencedOpfsMediaResult> {
    return deleteUnreferencedOpfsMedia(await this.getDatabase(), payload);
  }

  async reconcileOrphanedOpfsItemDirectories(
    payload: ReconcileOrphanedOpfsPayload = {},
  ): Promise<ReconcileOrphanedOpfsResult> {
    return reconcileOrphanedOpfsItemDirectories(await this.getDatabase(), payload);
  }

  async update(payload: UpdateItemPayload): Promise<UpdateItemResult> {
    return updateItem(await this.getDatabase(), payload);
  }
}

export const itemsController = new ItemsController();
