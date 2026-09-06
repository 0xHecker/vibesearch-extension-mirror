import { describe, expect, it } from "bun:test";
import { toItemBody } from "../src/services/connectors/cloud-push";

describe("connector cloud item contract", () => {
  it("maps normalized social media and metadata onto the shared wire shape", () => {
    const body = toItemBody({
      externalId: "ig:999",
      url: "https://www.instagram.com/p/ABC123/",
      title: "a nice photo",
      textContent: "a nice photo",
      source: "instagram",
      type: "social",
      authorUsername: "dave",
      media: [{ type: "image", url: "https://cdn.example.com/photo.jpg" }],
      postedAt: 1_751_328_000_000,
      metadata: {
        schemaVersion: 1,
        social: { platform: "instagram", postedAt: 1_751_328_000_000 },
        provenance: { method: "extension", externalId: "ig:999", capturedAt: 2_000 },
        sourceRecords: [],
      },
      fields: { connector: "instagram-saved" },
    });

    expect(body).toMatchObject({
      source: "instagram",
      type: "social",
      media: [{
        type: "image",
        originalUrl: "https://cdn.example.com/photo.jpg",
        storageType: "hotlink",
      }],
      fields: {
        connector: "instagram-saved",
        externalId: "ig:999",
        postedAt: 1_751_328_000_000,
      },
      metadata: {
        schemaVersion: 1,
        social: { platform: "instagram", postedAt: 1_751_328_000_000 },
      },
    });
    expect(body).not.toHaveProperty("createdAt");
  });
});
