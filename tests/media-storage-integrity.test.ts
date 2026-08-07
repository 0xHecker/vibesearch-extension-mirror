import { describe, expect, test } from "bun:test";
import type { ItemDocType } from "../src/schemas/item_schema";
import {
  cloneOpfsMediaEntriesForItem,
  getBlobIdentity,
  mapWithConcurrencyStable,
  ObjectUrlOwner,
  withOpfsMutationLock,
  BoundedOpfsCleanupBatch,
} from "../src/services/media-storage";

describe("OPFS media integrity", () => {
  test("copies each distinct local file once into the destination item directory", async () => {
    const sourcePath = "media/source/local.png";
    const sourceFile = new File(["local bytes"], "local.png", {
      type: "image/png",
      lastModified: 123,
    });
    const reads: string[] = [];
    const writes: string[] = [];
    const media = [
      { type: "image", originalUrl: "local.png", storageType: "opfs", opfsPath: sourcePath },
      { type: "image", originalUrl: "same.png", storageType: "opfs", opfsPath: sourcePath },
      { type: "image", originalUrl: "https://example.com/remote.png", storageType: "hotlink" },
    ] as NonNullable<ItemDocType["media"]>;

    const result = await cloneOpfsMediaEntriesForItem(media, "clone", {
      readOpfsFile: async (opfsPath) => {
        reads.push(opfsPath);
        return sourceFile;
      },
      saveMediaToOpfs: async (itemId, file) => {
        writes.push(`${itemId}:${file.name}`);
        return { opfsPath: `media/${itemId}/independent.png`, size: file.size };
      },
    });

    expect(reads).toEqual([sourcePath]);
    expect(writes).toEqual(["clone:local.png"]);
    expect(result.media?.map((entry) => entry.opfsPath || null)).toEqual([
      "media/clone/independent.png",
      "media/clone/independent.png",
      null,
    ]);
    expect(result.pathMap.get(sourcePath)).toBe("media/clone/independent.png");
    expect(media[0].opfsPath).toBe(sourcePath);
  });

  test("fails a copy instead of leaving a clone aliased to a missing source file", async () => {
    await expect(
      cloneOpfsMediaEntriesForItem(
        [
          {
            type: "image",
            originalUrl: "missing.png",
            storageType: "opfs",
            opfsPath: "media/source/missing.png",
          },
        ],
        "clone",
        { readOpfsFile: async () => null }
      )
    ).rejects.toThrow("OPFS_MEDIA_COPY_SOURCE_MISSING");
  });

  test("caps parallel work while preserving source order", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const values = [0, 1, 2, 3, 4, 5];

    const result = await mapWithConcurrencyStable(values, 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (5 - value) * 2));
      completed.push(value);
      active -= 1;
      return `result-${value}`;
    });

    expect(peak).toBe(2);
    expect(completed).not.toEqual(values);
    expect(result).toEqual(values.map((value) => `result-${value}`));
  });

  test("builds a bounded identity that distinguishes same-size replacements", async () => {
    const first = new File(["aaaa"], "same.bin", { lastModified: 7 });
    const replacement = new File(["bbbb"], "same.bin", { lastModified: 7 });

    const [firstIdentity, replacementIdentity] = await Promise.all([
      getBlobIdentity(first),
      getBlobIdentity(replacement),
    ]);

    expect(firstIdentity).toMatchObject({ size: 4, lastModified: 7 });
    expect(replacementIdentity).toMatchObject({ size: 4, lastModified: 7 });
    expect(firstIdentity.sampleSha256).not.toBe(replacementIdentity.sampleSha256);
  });

  test("revokes blob URLs that arrive after their UI owner was cancelled", () => {
    const revoked: string[] = [];
    const owner = new ObjectUrlOwner((url) => revoked.push(url));
    expect(owner.own("blob:already-owned")).toBe("blob:already-owned");

    owner.dispose();
    expect(owner.own("blob:late-resolution")).toBeNull();
    expect(owner.own("https://example.com/not-a-blob.png")).toBeNull();
    expect(revoked).toEqual(["blob:already-owned", "blob:late-resolution"]);
  });

  test("serializes restore-style overwrites against promotion commits", async () => {
    let releaseFirst = () => {};
    let firstStarted = () => {};
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = false;

    const first = withOpfsMutationLock(async () => {
      firstStarted();
      await gate;
    });
    await started;
    const second = withOpfsMutationLock(async () => {
      secondRan = true;
    });
    await Promise.resolve();
    expect(secondRan).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
  });

  test("batches a promotion run into one bounded reference-scan call", async () => {
    const batch = new BoundedOpfsCleanupBatch(700);
    const sourceIdentity = {
      size: 1,
      lastModified: 2,
      sampleSha256: "identity",
    };
    // Simulate more cleanup candidates than one run may retain. The overflow
    // remains on disk instead of growing memory or triggering another scan.
    for (let index = 0; index < 1_000; index += 1) {
      batch.add({
        opfsPath: `media/item-${index}/file.png`,
        sourceIdentity,
      });
    }

    let scanCalls = 0;
    let scannedCandidateCount = 0;
    await batch.flush(async (files) => {
      scanCalls += 1;
      scannedCandidateCount = files.length;
    });
    await batch.flush(async () => {
      scanCalls += 1;
    });

    expect(scanCalls).toBe(1);
    expect(scannedCandidateCount).toBe(700);
    expect(batch.overflowed).toBe(true);
  });
});
