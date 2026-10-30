import type { ScreenshotRegionSelection } from "@src/workers/background/import-types";

export async function cropLocalSnapshot(blob: Blob, region: ScreenshotRegionSelection): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") throw new Error("LOCAL_REGION_UNAVAILABLE");
  if (region.viewportWidth <= 0 || region.viewportHeight <= 0 || region.width <= 0 || region.height <= 0) throw new Error("INVALID_LOCAL_REGION");
  const bitmap = await createImageBitmap(blob);
  try {
    const scaleX = bitmap.width / region.viewportWidth;
    const scaleY = bitmap.height / region.viewportHeight;
    const x = Math.max(0, Math.round(region.x * scaleX)); const y = Math.max(0, Math.round(region.y * scaleY));
    const width = Math.min(bitmap.width - x, Math.round(region.width * scaleX)); const height = Math.min(bitmap.height - y, Math.round(region.height * scaleY));
    if (width <= 0 || height <= 0) throw new Error("INVALID_LOCAL_REGION");
    const canvas = new OffscreenCanvas(width, height); const context = canvas.getContext("2d");
    if (!context) throw new Error("LOCAL_REGION_UNAVAILABLE");
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally { bitmap.close(); }
}
