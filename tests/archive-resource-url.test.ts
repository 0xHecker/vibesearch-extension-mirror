import { expect, test } from "bun:test";
import {
  isBlockedArchiveResourceHost,
  isSafeArchiveResourceUrl,
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
