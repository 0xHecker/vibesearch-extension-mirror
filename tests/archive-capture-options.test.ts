import { expect, test } from "bun:test";
import {
  ARCHIVE_EXCLUDED_ELEMENT_SELECTOR,
  ARCHIVE_FILENAME_REPLACED_CHARACTERS,
} from "@src/services/archive-capture-options";
import {
  PAGE_ARCHIVE_MAX_HTML_BYTES,
  PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES,
} from "@src/services/archive-capture-protocol";

test("every SingleFile filename replacement entry is a valid character class", () => {
  for (const entry of ARCHIVE_FILENAME_REPLACED_CHARACTERS) {
    expect(() => new RegExp(`[${entry}]+`, "g")).not.toThrow();
  }
  expect(ARCHIVE_FILENAME_REPLACED_CHARACTERS).toContain("\\\\");
});

test("SingleFile excludes every Vibesearch overlay from the HTML archive", () => {
  expect(ARCHIVE_EXCLUDED_ELEMENT_SELECTOR).toContain("#__vibesearch_toast_root__");
  expect(ARCHIVE_EXCLUDED_ELEMENT_SELECTOR).toContain("#__vibesearch_picker_root__");
  expect(ARCHIVE_EXCLUDED_ELEMENT_SELECTOR).toContain("#__vibesearch_screenshot_selector__");
});

test("HTML capture accepts a real self-contained page up to 40 MiB", () => {
  expect(PAGE_ARCHIVE_MAX_HTML_BYTES).toBe(40 * 1024 * 1024);
  expect(PAGE_ARCHIVE_MAX_RESOURCE_TOTAL_BYTES).toBeGreaterThanOrEqual(30 * 1024 * 1024);
});
