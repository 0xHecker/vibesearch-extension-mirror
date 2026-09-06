import { scheduleForProcessing } from "@src/services/metadata-pipeline";
import { isMetadataFetchableUrl } from "@src/utils/metadata-url";
import { sendProcessStatus } from "@src/workers/background/process-status";
import { sendForwardedToOffscreen } from "@src/workers/background/runtime";

type PendingMetadataUrls = {
  urls?: string[];
};

export const retryPendingLocalMetadataUrls = async (): Promise<number> => {
  const result = await sendForwardedToOffscreen<PendingMetadataUrls>({
    service: "items",
    type: "getPendingMetadataUrls",
    payload: { limit: 500 },
  });
  const urls = (result.urls ?? []).filter((url) => isMetadataFetchableUrl(url));
  if (urls.length === 0) return 0;

  sendProcessStatus(
    "metadata-queue",
    "Metadata",
    "processing",
    `Retrying metadata for ${urls.length.toLocaleString()} pending links...`,
  );
  scheduleForProcessing(urls, false);
  return urls.length;
};
