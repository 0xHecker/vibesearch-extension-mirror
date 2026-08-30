import { expect, test } from "bun:test";
import {
  isBlockedArchiveResourceHost,
  isSafeArchiveResourceUrl,
  isServerCapturableArchiveUrl,
} from "@src/services/archive-resource-url";

test("resource URL guard blocks private cross-origin targets and credentials", () => {
  const source = "https://example.com/article";

  expect(isSafeArchiveResourceUrl("https://cdn.example.net/image.png", source)).toBe(true);
  expect(isSafeArchiveResourceUrl("http://127.0.0.1/private", source)).toBe(false);
  expect(isSafeArchiveResourceUrl("https://user:pass@example.net/private", source)).toBe(false);
  expect(isSafeArchiveResourceUrl("https://example.net:8443/file", source)).toBe(false);
  expect(isSafeArchiveResourceUrl("http://localhost:3000/style.css", "http://localhost:3000/page")).toBe(true);
});

test("resource host guard covers IPv4, IPv6, mapped, and wildcard-local forms", () => {
  for (const host of [
    "0.0.0.0",
    "10.2.3.4",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "foo.localhost",
    "metadata.google.internal",
    "127.0.0.1.nip.io",
  ]) {
    expect(isBlockedArchiveResourceHost(host)).toBe(true);
  }

  expect(isBlockedArchiveResourceHost("cdn.example.com")).toBe(false);
  expect(isBlockedArchiveResourceHost("2606:4700:4700::1111")).toBe(false);
});

test("server-capture guard mirrors the API's public-target contract", () => {
  expect(isServerCapturableArchiveUrl("https://example.com/article")).toBe(true);
  expect(isServerCapturableArchiveUrl("http://example.com:80/article")).toBe(true);
  expect(isServerCapturableArchiveUrl("https://example.com:443/article")).toBe(true);

  // Every rejection below is a target the API answers with an unusable-stub 400.
  expect(isServerCapturableArchiveUrl("http://localhost:5173/dashboard")).toBe(false);
  expect(isServerCapturableArchiveUrl("http://localhost/dashboard")).toBe(false);
  expect(isServerCapturableArchiveUrl("http://192.168.1.20/admin")).toBe(false);
  expect(isServerCapturableArchiveUrl("http://[::1]/admin")).toBe(false);
  expect(isServerCapturableArchiveUrl("https://intranet.local/wiki")).toBe(false);
  expect(isServerCapturableArchiveUrl("https://example.com:8443/report")).toBe(false);
  expect(isServerCapturableArchiveUrl("https://user:pass@example.com/report")).toBe(false);
  expect(isServerCapturableArchiveUrl("file:///Users/me/page.html")).toBe(false);
  expect(isServerCapturableArchiveUrl("not a url")).toBe(false);
  // Beyond this length the edge forwards no source URL at all.
  expect(isServerCapturableArchiveUrl(`https://example.com/?q=${"a".repeat(8_200)}`)).toBe(false);
});
