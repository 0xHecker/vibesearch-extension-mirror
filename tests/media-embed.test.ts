import { describe, expect, test } from "bun:test";
import { getExternalEmbedSandbox, getPreferredYouTubeVideoId } from "../src/utils/media-embed";

describe("getExternalEmbedSandbox", () => {
  test("retains same-origin permission only for remote web embeds", () => {
    expect(getExternalEmbedSandbox("https://www.youtube.com/embed/video", { allowPopups: true })).toBe(
      "allow-scripts allow-same-origin allow-popups"
    );
  });

  test("never grants same-origin permission to non-web sources", () => {
    for (const source of [
      "chrome-extension://extension-id/src/pages/search/index.html",
      "blob:chrome-extension://extension-id/asset",
      "data:text/html,hello",
      "/relative-preview",
      "not a url",
    ]) {
      expect(getExternalEmbedSandbox(source, { allowForms: true, allowPresentation: true })).toBe(
        "allow-scripts allow-forms allow-presentation"
      );
    }
  });
});

describe("getPreferredYouTubeVideoId", () => {
  test("prefers a right-clicked YouTube link over the current watch page", () => {
    expect(
      getPreferredYouTubeVideoId(
        "https://www.youtube.com/watch?v=clicked12345",
        "https://www.youtube.com/watch?v=current12345"
      )
    ).toBe("clicked12345");
  });

  test("falls back to the current page when there is no clicked YouTube link", () => {
    expect(getPreferredYouTubeVideoId(null, "https://www.youtube.com/watch?v=current12345")).toBe(
      "current12345"
    );
  });
});
