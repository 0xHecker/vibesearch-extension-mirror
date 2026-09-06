import { parseJsonValue, type JsonValue } from "@src/common/json-value";
import type { MyDatabase } from "@src/services/DatabaseService";
import { cloudSyncService } from "@src/services/cloud-sync";
import { itemsController } from "@src/services/controllers/items.controller";
import {
  isEmbeddingStateOnlyItemChange,
  isFolderCollapseOnlyChange,
  isMetadataEnrichmentItemChange,
  isSpaceGroupCollapseOnlyChange,
} from "@src/services/item-change-classification";
import {
  collectChangedItemIds,
  collectItemIdsFromTagLinks,
  didTagNameChange,
} from "./collection-change";
import { DatabaseChangePublisher } from "./database-change-publisher";
import type { ProcessingQueues } from "./processing-queues";

type CloudCollection = Parameters<typeof cloudSyncService.enqueueRxChange>[0];

function queueCloudChange(
  collection: CloudCollection,
  change: JsonValue,
): void {
  void cloudSyncService.enqueueRxChange(collection, change).catch((error) => {
    console.error(
      `[Offscreen] Failed to queue ${collection} cloud change:`,
      error instanceof Error ? error.message : error,
    );
  });
}

/** Connect RxDB collection events to search, cloud, and UI projections. */
export function subscribeToDatabaseChanges(
  db: MyDatabase,
  changes: DatabaseChangePublisher,
  queues: ProcessingQueues,
): void {
  db.items.$.subscribe((changeEvent) => {
    const jsonChange = parseJsonValue(changeEvent);
    queueCloudChange("items", jsonChange);
    const changedIds = collectChangedItemIds(jsonChange);
    if (!isEmbeddingStateOnlyItemChange(changeEvent)) {
      itemsController.scheduleSearchIndexSync(changedIds);
      changes.schedule(
        "items",
        changedIds,
        isMetadataEnrichmentItemChange(changeEvent) ? "metadata" : "content",
      );
    }
    queues.embedding.scheduleIfNeeded();
    queues.ocr.scheduleIfNeeded();
  });

  db.folders.$.subscribe((changeEvent) => {
    const jsonChange = parseJsonValue(changeEvent);
    queueCloudChange("folders", jsonChange);
    if (!isFolderCollapseOnlyChange(changeEvent)) changes.schedule("folders");
  });

  db.spaces.$.subscribe((changeEvent) => {
    queueCloudChange("spaces", parseJsonValue(changeEvent));
    changes.schedule("spaces");
  });

  db.space_groups.$.subscribe((changeEvent) => {
    const jsonChange = parseJsonValue(changeEvent);
    queueCloudChange("spaceGroups", jsonChange);
    if (!isSpaceGroupCollapseOnlyChange(changeEvent)) {
      changes.schedule("space_groups");
    }
  });

  db.tags.$.subscribe((changeEvent) => {
    const jsonChange = parseJsonValue(changeEvent);
    queueCloudChange("tags", jsonChange);
    if (didTagNameChange(jsonChange)) {
      itemsController.markSearchIndexDirty();
      changes.schedule("items");
    } else {
      changes.schedule("tags");
    }
  });

  db.item_tags.$.subscribe((changeEvent) => {
    const jsonChange = parseJsonValue(changeEvent);
    queueCloudChange("itemTags", jsonChange);
    const changedItemIds = collectItemIdsFromTagLinks(jsonChange);
    if (changedItemIds.length > 0) {
      itemsController.scheduleSearchIndexSync(changedItemIds);
    } else {
      itemsController.markSearchIndexDirty();
    }
    changes.schedule("items", changedItemIds);
  });
}
