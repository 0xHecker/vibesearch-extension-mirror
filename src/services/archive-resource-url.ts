const ipv4Blocked = (octets: number[]): boolean => {
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
};

const ipv6Segments = (rawHost: string): number[] | null => {
  let host = rawHost;
  if (host.includes(".")) {
    const colon = host.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = host.slice(colon + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    host = `${host.slice(0, colon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (
    missing < 0 ||
    (halves.length === 2 && missing < 1) ||
    parts.length !== 8 ||
    parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))
  ) {
    return null;
  }
  return parts.map((part) => Number.parseInt(part, 16));
};

const ipv6Blocked = (host: string): boolean => {
  const segments = ipv6Segments(host);
  if (!segments) return true;
  if (segments.every((part) => part === 0)) return true;
  if (segments.slice(0, 7).every((part) => part === 0) && segments[7] === 1) return true;

  const first = segments[0];
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;

  const compatible = segments.slice(0, 6).every((part) => part === 0);
  const mapped = segments.slice(0, 5).every((part) => part === 0) && segments[5] === 0xffff;
  if (compatible || mapped) {
    return ipv4Blocked([
      segments[6] >> 8,
      segments[6] & 0xff,
      segments[7] >> 8,
      segments[7] & 0xff,
    ]);
  }
  return false;
};

export const isBlockedArchiveResourceHost = (rawHost: string): boolean => {
  const host = rawHost.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (host === "metadata.google.internal") return true;
  if (["localtest.me", "lvh.me", "nip.io", "sslip.io"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) return ipv4Blocked(ipv4.slice(1).map(Number));
  return host.includes(":") ? ipv6Blocked(host) : false;
};

/**
 * The API edge forwards the archive source URL only up to this length; a longer
 * target arrives at the store with no source URL at all and is rejected as an
 * unusable stub.
 */
export const ARCHIVE_SOURCE_URL_MAX_LENGTH = 8_192;

/**
 * Mirror of the API's `assertPublicUrl` guard for archive *targets*.
 *
 * A page that only resolves inside this browser — localhost, a private or
 * link-local address, a custom port, or embedded credentials — can never be
 * fetched by the server-side capturer. Asking it to try burns Browser Run
 * attempts and comes back as an opaque stub rejection, so the outbox checks
 * this locally and hands those pages straight to the browser-session capture.
 */
export const isServerCapturableArchiveUrl = (rawUrl: string): boolean => {
  try {
    const target = new URL(rawUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (target.toString().length > ARCHIVE_SOURCE_URL_MAX_LENGTH) return false;
    if (target.username || target.password) return false;
    const standardPort = !target.port || (target.protocol === "http:" ? target.port === "80" : target.port === "443");
    if (!standardPort) return false;
    return !isBlockedArchiveResourceHost(target.hostname);
  } catch {
    return false;
  }
};

export const isSafeArchiveResourceUrl = (rawUrl: string, sourceUrl: string): boolean => {
  try {
    const target = new URL(rawUrl);
    const source = new URL(sourceUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (target.username || target.password) return false;
    const isSourceOrigin = target.origin === source.origin;
    const standardPort = !target.port || (target.protocol === "http:" ? target.port === "80" : target.port === "443");
    if (!standardPort && !isSourceOrigin) return false;
    if (isBlockedArchiveResourceHost(target.hostname) && !isSourceOrigin) return false;
    return true;
  } catch {
    return false;
  }
};
