import { DatabaseChangePublisher } from "./runtime/database-change-publisher";
import { initializeOffscreen } from "./runtime/initialize-offscreen";
import { createProcessingQueues } from "./runtime/processing-queues";
import { listenForProcessingTriggers } from "./runtime/processing-trigger-listener";
import { registerOffscreenServices } from "./runtime/service-registry";

console.log("[Offscreen] Document script loaded.");

const databaseChanges = new DatabaseChangePublisher();
const processingQueues = createProcessingQueues();

registerOffscreenServices(databaseChanges);
listenForProcessingTriggers(processingQueues);
void initializeOffscreen(databaseChanges, processingQueues);
