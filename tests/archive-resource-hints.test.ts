import { expect, test } from "bun:test";
import { mergeCapturedCssWithOriginal } from "@src/services/archive-resource-hints";

test("captured CSS data resources override the original network fallback", () => {
  const original = "background-image:url('/protected.png');color:red";
  const captured = "background-image:url(data:image/png;base64,AAAA);color:red";

  const merged = mergeCapturedCssWithOriginal(original, captured, "declaration");

  expect(merged.indexOf(original)).toBe(0);
  expect(merged.indexOf(captured)).toBeGreaterThan(merged.indexOf(original));
  expect(merged).toContain(";background-image:url(data:image/png;base64,AAAA)");
});

test("stylesheet capture retains original rules before embedded replacements", () => {
  const original = ".hero{background:url('/protected.png')}";
  const captured = ".hero{background:url('data:image/png;base64,AAAA')}";

  expect(mergeCapturedCssWithOriginal(original, captured, "stylesheet")).toBe(
    `${original}\n${captured}`,
  );
});

test("failed, empty, and unchanged CSS captures do not duplicate rules", () => {
  const original = "background:url('/image.png')";

  expect(mergeCapturedCssWithOriginal(original, "background:url(data:,)", "declaration")).toBe(original);
  expect(mergeCapturedCssWithOriginal(original, "background:none", "declaration")).toBe(original);
  expect(mergeCapturedCssWithOriginal(original, original, "declaration")).toBe(original);
  expect(mergeCapturedCssWithOriginal(original, "", "declaration")).toBe(original);
});
