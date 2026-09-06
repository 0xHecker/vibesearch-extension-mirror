import type { ItemDocType } from "@src/schemas/item_schema";

export type TagEntry = {
  id: string;
  name: string;
  color?: string | null;
};

export type TabEditorUpdate = Pick<ItemDocType, "id"> &
  Partial<
    Pick<
      ItemDocType,
      | "title"
      | "url"
      | "textContent"
      | "source"
      | "isFavorite"
      | "authorUsername"
      | "likes"
      | "upvotes"
    >
  >;

type SourceOption = {
  value: ItemDocType["source"];
  label: string;
};

export const SOURCE_OPTIONS = [
  { value: "web", label: "Web" },
  { value: "twitter", label: "Twitter / X" },
  { value: "reddit", label: "Reddit" },
  { value: "note", label: "Note" },
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "substack", label: "Substack" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "threads", label: "Threads" },
  { value: "mastodon", label: "Mastodon" },
  { value: "bluesky", label: "Bluesky" },
  { value: "github", label: "GitHub" },
  { value: "spotify", label: "Spotify" },
  { value: "ytmusic", label: "YouTube Music" },
  { value: "vimeo", label: "Vimeo" },
  { value: "soundcloud", label: "SoundCloud" },
  { value: "article", label: "Article" },
] satisfies readonly SourceOption[];

export const SOURCE_LABEL = {
  web: "Web",
  twitter: "Twitter / X",
  reddit: "Reddit",
  note: "Note",
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  substack: "Substack",
  linkedin: "LinkedIn",
  threads: "Threads",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  github: "GitHub",
  spotify: "Spotify",
  ytmusic: "YouTube Music",
  vimeo: "Vimeo",
  soundcloud: "SoundCloud",
  article: "Article",
} satisfies Record<ItemDocType["source"], string>;

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
