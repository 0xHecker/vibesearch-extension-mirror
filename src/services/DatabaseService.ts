import { createRxDatabase, addRxPlugin, RxDatabase, RxCollection, RxStorage } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { wrappedValidateZSchemaStorage } from "rxdb/plugins/validate-z-schema";
import { RxDBLocalDocumentsPlugin } from "rxdb/plugins/local-documents";
import { RxDBQueryBuilderPlugin } from "rxdb/plugins/query-builder";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { withDexieRequiredIndexes } from "@src/services/rxdb-dexie-required-indexes";
import { migrateAllHistoricalCollectionVersions } from "@src/services/rxdb-migration-recovery";

if (import.meta.env.MODE === "development") {
  addRxPlugin(RxDBDevModePlugin);
}
addRxPlugin(RxDBLocalDocumentsPlugin);
addRxPlugin(RxDBQueryBuilderPlugin);
addRxPlugin(RxDBMigrationSchemaPlugin);

// Import schemas
import { itemMigrationStrategies, itemSchema, ItemDocType } from "@src/schemas/item_schema";
import { folderMigrationStrategies, folderSchema, FolderDocType } from "@src/schemas/folder_schema";
import { spaceMigrationStrategies, spaceSchema, SpaceDocType } from "@src/schemas/space_schema";
import { spaceGroupSchema, SpaceGroupDocType } from "@src/schemas/space_group_schema";
import { tagSchema, TagDocType } from "@src/schemas/tag_schema";
import { itemTagSchema, ItemTagDocType } from "@src/schemas/item_tag_schema";
import { searchHistorySchema, SearchHistoryDocType } from "@src/schemas/search_history_schema";
import { flashcardSchema, FlashcardDocType } from "@src/schemas/flashcard_schema";
import { deletedItemSchema, DeletedItemDocType } from "@src/schemas/deleted_item_schema";

// Define collection types
export type ItemCollection = RxCollection<ItemDocType>;
export type FolderCollection = RxCollection<FolderDocType>;
export type SpaceCollection = RxCollection<SpaceDocType>;
export type SpaceGroupCollection = RxCollection<SpaceGroupDocType>;
export type TagCollection = RxCollection<TagDocType>;
export type ItemTagCollection = RxCollection<ItemTagDocType>;
export type SearchHistoryCollection = RxCollection<SearchHistoryDocType>;
export type FlashcardCollection = RxCollection<FlashcardDocType>;
export type DeletedItemCollection = RxCollection<DeletedItemDocType>;

// Define database collections
export type MyDatabaseCollections = {
  items: ItemCollection;
  folders: FolderCollection;
  spaces: SpaceCollection;
  space_groups: SpaceGroupCollection;
  tags: TagCollection;
  item_tags: ItemTagCollection;
  search_history: SearchHistoryCollection;
  flashcards: FlashcardCollection;
  deleted_items: DeletedItemCollection;
};

export type MyDatabase = RxDatabase<MyDatabaseCollections>;

let dbPromise: Promise<MyDatabase> | null = null;

const createDatabase = async () => {
  let storage: RxStorage<any, any> = withDexieRequiredIndexes(getRxStorageDexie());
  if (import.meta.env.MODE === "development") {
    storage = wrappedValidateZSchemaStorage({ storage });
  }

  const db = await createRxDatabase<MyDatabaseCollections>({
    name: "vibesearchdb",
    storage,
    localDocuments: true,
    // The only count() in the app — the 500-tab folder cap in
    // items.addToFolder — uses a multi-field selector (folderId + deletedAt +
    // _deleted) that can't fully match a single index, so RxDB rejects it as a
    // "slow count" (QU14). The data is bounded (<=500 per folder) and this runs
    // only when saving a tab, so a slow count is perfectly fine here.
    allowSlowCount: true,
  });

  await db.addCollections({
    items: {
      schema: itemSchema,
      migrationStrategies: itemMigrationStrategies,
      autoMigrate: false,
    },
    folders: {
      schema: folderSchema,
      migrationStrategies: folderMigrationStrategies,
      autoMigrate: false,
    },
    spaces: {
      schema: spaceSchema,
      migrationStrategies: spaceMigrationStrategies,
      autoMigrate: false,
    },
    space_groups: {
      schema: spaceGroupSchema,
      // v0 → v1: introduce parentGroupId for nested space groups. Existing
      // groups become top-level (null parent).
      migrationStrategies: {
        1: (oldDoc: SpaceGroupDocType) => {
          oldDoc.parentGroupId = null;
          return oldDoc;
        },
      },
    },
    tags: {
      schema: tagSchema,
      migrationStrategies: {
        // v0 → v1: introduce color + favorite for the Tags manager.
        1: (oldDoc: any) => {
          oldDoc.color = null;
          oldDoc.isFavorite = false;
          return oldDoc;
        },
      },
    },
    item_tags: {
      schema: itemTagSchema,
    },
    search_history: {
      schema: searchHistorySchema,
    },
    flashcards: {
      schema: flashcardSchema,
    },
    deleted_items: {
      schema: deletedItemSchema,
    },
  });

  // One released build reset these schema versions. Migrate every stranded
  // store ourselves because RxDB's automatic path handles only one old store.
  await migrateAllHistoricalCollectionVersions(db.items);
  await migrateAllHistoricalCollectionVersions(db.folders);
  await migrateAllHistoricalCollectionVersions(db.spaces);

  return db;
};

export const getDb = (): Promise<MyDatabase> => {
  if (!dbPromise) {
    dbPromise = createDatabase();
  }
  return dbPromise;
};

// export const addDummyData = async () => {
//   const db = await getDb();
//   const quotes = [
//     "The only way to do great work is to love what you do.",
//     "Innovation distinguishes between a leader and a follower.",
//     "Strive not to be a success, but rather to be of value.",
//     "The mind is everything. What you think you become.",
//     "Your time is limited, don't waste it living someone else's life.",
//     "The best way to predict the future is to create it.",
//     "Success is not final, failure is not fatal: it is the courage to continue that counts.",
//     "Believe you can and you're halfway there.",
//     "The only impossible journey is the one you never begin.",
//     "Act as if what you do makes a difference. It does.",
//     "Success usually comes to those who are too busy to be looking for it.",
//     "Don't watch the clock; do what it does. Keep going.",
//     "The future belongs to those who believe in the beauty of their dreams.",
//     "The secret of getting ahead is getting started.",
//     "I find that the harder I work, the more luck I seem to have.",
//     "It's not whether you get knocked down, it's whether you get up.",
//     "The successful warrior is the average man, with laser-like focus.",
//     "Don't be afraid to give up the good to go for the great.",
//     "I have not failed. I've just found 10,000 ways that won't work.",
//     "If you are not willing to risk the usual, you will have to settle for the ordinary.",
//     "The ones who are crazy enough to think they can change the world are the ones who do.",
//     "Do one thing every day that scares you.",
//     "All progress takes place outside the comfort zone.",
//     "The only limit to our realization of tomorrow will be our doubts of today.",
//     "What you get by achieving your goals is not as important as what you become by achieving your goals.",
//     "If you want to lift yourself up, lift up someone else.",
//     "You miss 100% of the shots you don't take.",
//     "The most difficult thing is the decision to act, the rest is merely tenacity.",
//     "I am a great believer in luck, and I find the harder I work the more I have of it.",
//     "To be successful, you must accept all challenges that come your way. You can't just accept the ones you like.",
//   ];
//
//   const dummyItems = quotes.map((quote, i) => ({
//     id: `dummy-quote-${i}`,
//     userId: "user1",
//     title: `Quote ${i}`,
//     textContent: quote,
//     url: `https://example.com/quote-${i}`,
//     source: "note" as const,
//     folderId: "folder1",
//     isFavorite: false,
//     parentId: null,
//     isEmbedded: false,
//     isMetaFetched: false,
//     isDirty: false,
//     serverVersion: 0,
//     createdAt: Date.now(),
//     updatedAt: Date.now(),
//     vector_index: -1,
//     deletedAt: 0,
//   }));
//
//   console.log("Inserting dummy items...");
//   try {
//     await db.items.bulkInsert(dummyItems);
//   } catch (e) {
//     console.error("Failed to insert dummy items:", e);
//   }
//   console.log("Finished inserting dummy items.");
// };
