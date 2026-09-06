import {
  jsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "@src/common/json-value";

export type MetadataPreferenceKey = "title" | "description" | "image";

export type DomainMetadataPreference = Partial<Record<MetadataPreferenceKey, string[]>>;
export type MetadataPreferences = Record<MetadataPreferenceKey, string[]>;

const stripWhitespace = (value: string): string => value.trim();

export const DEFAULT_METADATA_PREFERENCES: MetadataPreferences = {
  title: ["ogTitle", "twitterTitle", "title"],
  description: ["ogDescription", "twitterDescription", "description"],
  image: ["twitterImage", "ogImage", "image"],
};

const DOMAIN_METADATA_PREFERENCES = new Map<string, DomainMetadataPreference>([
  ["instagram.com", {
    title: ["twitterTitle", "ogTitle", "title"],
    description: ["twitterDescription", "ogDescription", "description"],
    image: ["twitterImage", "ogImage", "image"],
  }],
]);

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^www\./, "");

const getBaseDomain = (host: string): string => {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
};

export const getPreferencesForHost = (host: string): DomainMetadataPreference => {
  const normalized = normalizeHostname(host);
  return (
    DOMAIN_METADATA_PREFERENCES.get(normalized) ||
    DOMAIN_METADATA_PREFERENCES.get(getBaseDomain(normalized)) ||
    {}
  );
};

export const pickStringField = (
  entry: JsonObject,
  fields: string[]
): string | undefined => {
  for (const field of fields) {
    const value = jsonString(entry[field]);
    if (value !== undefined) {
      const trimmed = stripWhitespace(value);
      if (trimmed) return trimmed;
    }
  }
  return undefined;
};

const getImageUrl = (value: JsonValue | undefined): string | undefined => {
  const direct = jsonString(value);
  if (direct) return direct;
  const first = Array.isArray(value) ? value[0] : value;
  return jsonString(jsonObject(first)?.url);
};

export const pickImageField = (
  entry: JsonObject,
  fields: string[]
): string | undefined => {
  for (const field of fields) {
    const candidate = getImageUrl(entry[field]);
    if (candidate) return candidate;
  }
  return undefined;
};

export const registerDomainMetadataPreference = (
  domain: string,
  preference: DomainMetadataPreference
) => {
  DOMAIN_METADATA_PREFERENCES.set(normalizeHostname(domain), preference);
};
