<div align="center">
  <img src="public/VibeSearch.svg" alt="Vibesearch" width="96" height="96" />

  # Vibesearch

  **Your browser's memory, finally searchable.**

  A local-first tab manager, bookmark manager, and search engine that actually
  finds things — by meaning, not just by exact words.

  [Features](#what-you-get) · [Getting started](#getting-started) · [Search like a pro](#search-like-a-pro) · [Shortcuts](#keyboard-shortcuts) · [Settings](#settings) · [Architecture docs](docs/architecture/README.md)
</div>

---

## Why Vibesearch

You save things all day — tabs, links, screenshots, repos, half-read articles — and never
find them again. Bookmarks are a folder graveyard; history is a firehose; neither
understands what you meant.

Vibesearch keeps everything you save in one fast, private library you can search the way you
think:

- **By meaning** — describe it and find it, even if the page never used those words.
- **By exact words too** — semantic, keyword, fuzzy, and *sounds-like* matching, fused on every query.
- **Inside images (Chrome/Brave)** — on-device OCR makes the text in screenshots and images searchable.
- **Bring it all in** — import your browser bookmarks and GitHub stars in seconds.
- **Private spaces** — password-protect anything sensitive.
- **Back up, sync & restore** — to a JSON file or Google Drive.
- **Local and yours** — your library and search stay in your browser. No account needed.

---

## What you get

- **Save anything** — quick-save a tab, or right-click a link, image, video, quote, or whole page.
- **Screenshots** — grab the full view or a region; Chrome/Brave also index their text with OCR.
- **Hybrid search** — semantic + keyword + fuzzy + phonetic, fused into one ranked list.
- **Query language** — filter by space, source, site, tag, folder, author, date, and more.
- **Private spaces** — password-protected, with recovery questions and auto-lock.
- **Scopes** — search everywhere, one space, or just your private spaces.
- **Spaces & folders** — nestable spaces, space groups, folders, and tab groups.
- **Tags & organize mode** — colors, favorites, and drag-and-drop reordering.
- **Import** — browser bookmarks and GitHub stars, with previews fetched automatically.
- **Share** — send a space, folder, or selection as a link (optional PIN, revocable).
- **Back up** — export to JSON or Google Drive.
- **Recycle bin** — 30-day undo for deletes.
- **Cross-browser** — genuine Chrome/Brave and Firefox MV3 packages. Firefox keeps semantic search
  local but does not currently ship OCR because Gecko MV3 has no equivalent to Chrome's sandboxed
  extension pages.

---

## Getting started

### Install (from a build)

1. Build the extension (see [Development](#development)) or grab a packaged build.
2. For Chrome/Brave, open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select `dist_chrome`.
3. For Firefox 142+, open `about:debugging#/runtime/this-firefox`, click
   **Load Temporary Add-on**, and select `dist_firefox/manifest.json`.

Pin the Vibesearch icon to your toolbar and you're set.

### The 60-second tour

1. **Save your current tab** with `Ctrl/Cmd + Shift + S`. That's your first item.
2. **Open Vibesearch** (click the toolbar icon, or turn on "open on new tab" in Settings) to
   see your library.
3. **Search** — just start typing. Try a phrase that describes what you saved rather than its
   exact title; semantic search will find it.
4. **Organize** when you feel like it: drag items into folders, create a space for a project,
   add a tag or two.

That's the whole loop: **save → search → (optionally) organize.** Vibesearch does the indexing,
embedding and metadata fetching quietly in the background. Chrome/Brave also run OCR there.

### Make the most of it

- **Import what you already have.** Settings → Data → *Import browser bookmarks* / *Import GitHub
  stars*. Your existing collection becomes instantly searchable.
- **Let it enrich.** After a bulk import, give it a little time — Vibesearch fetches previews and
  builds embeddings in the background. A status indicator shows progress.
- **Lean on meaning.** Don't try to remember exact titles. Describe the thing. That's the point.
- **Use scopes and filters** once your library grows (see below). `source:youtube` `tag:recipes`
  `added:last7d` narrows thousands of items to the handful you want.
- **Make a private space** for anything sensitive, and a couple of **space groups** to keep your
  sidebar tidy.

---

## Search like a pro

Search is just a text box, but it understands a compact query language. Type a filter and
Vibesearch turns it into a chip; everything else is treated as your search text. Autocomplete
suggests fields and values as you type.

### The essentials

| You type | What it does |
| --- | --- |
| `cooling data centers` | Hybrid search across your whole library |
| `source:youtube` | Only items from YouTube |
| `site:arxiv.org` | Only items from a domain (`domain:` works too) |
| `tag:recipes` | Only items with the `recipes` tag |
| `folder:"Reading list"` | Only items in that folder (quote names with spaces) |
| `is:favorite` | Only favorites |
| `has:image` | Only items with an image (`video`, `media`, `embed` too) |
| `author:simonw` | Only items by that author |
| `added:last7d` | Saved in the last 7 days |
| `-source:twitter` | **Exclude** a filter — prefix any filter with `-` |

### Combine freely

Filters stack (they AND together), and your free text supports booleans:

```
machine learning source:reddit added:last30d -tag:archived
("self hosting" OR homelab) has:image
neural networks AND (pytorch OR jax) NOT beginner
```

You can use `AND` / `OR` / `NOT`, parentheses, `|` / `||` and `&` / `&&`, `"quoted phrases"`,
and `-term` to exclude a word.

### Scopes, sorting, and modes

- **Scope** where you search: `scope:global` (everywhere), `scope:current` (this space),
  `scope:private`, `scope:public`. Shorthand: just type `/global`.
- **Sort**: `sort:relevance`, `sort:createdAt`, `sort:updatedAt`, `sort:title`, `sort:source`
  — add `asc` or `desc` (e.g. `sort:updatedAt desc`).
- **Mode** (override your default for one search): `mode:keyword`, `mode:vector` (semantic),
  `mode:fuzzy`, or blends like `mode:keyword+vector`.

<details>
<summary><strong>Full filter & operator reference</strong> (click to expand)</summary>

**Filters** (prefix any with `-` to negate; quote values with spaces)

| Field | Values / format | Example |
| --- | --- | --- |
| `space:` | a space name | `space:Work` |
| `source:` | `web`, `twitter`, `reddit`, `note`, `youtube`, `instagram`, `tiktok`, `substack`, `linkedin`, `github`, `article` | `source:github` |
| `site:` / `domain:` | a hostname | `site:news.ycombinator.com` |
| `tag:` | a tag name | `tag:"to read"` |
| `folder:` | a folder name | `folder:Inbox` |
| `author:` | an author/handle | `author:karpathy` |
| `is:` | `favorite` | `is:favorite` |
| `has:` | `image`, `video`, `media`, `embed` | `has:video` |

**Dates** — `date:` / `added:` / `created:` filter by when an item was saved; `updated:` by last change.

| Format | Example |
| --- | --- |
| Presets | `added:today`, `added:yesterday`, `added:last7d`, `added:last30d` |
| On a day | `added:on:2024-05-01` or `added:2024-05-01` |
| After / before | `added:after:2024-01-01`, `added:before:2024-12-31` |
| Comparators | `added:>=2024-06-01`, `added:<2024-07-01` |
| Range | `added:between:2024-01-01..2024-03-31` or `added:2024-01-01..2024-03-31` |

**Numbers** — `likes:` and `upvotes:` (handy for imported social content)

| Format | Example |
| --- | --- |
| Minimum | `likes:>=100` |
| Range | `upvotes:50..500` |
| Exact | `likes:42` |

**Directives**

| Directive | Values |
| --- | --- |
| `scope:` | `current`, `global`, `private`, `public` (shorthand `/global`, `/private`, …) |
| `sort:` | `relevance`, `createdAt`, `updatedAt`, `title`, `source` + optional `asc`/`desc` |
| `mode:` | `keyword`, `vector`, `fuzzy`, and `+` blends like `keyword+vector` |
| `minscore:` / `score:` | a relevance floor `0`–`1` (drop weak matches) |
| `limit:` / `page:` | result count and page |

</details>

---

## Keyboard shortcuts

| Action | Shortcut | Where |
| --- | --- | --- |
| Quick-save the current tab | `Ctrl/Cmd + Shift + S` | Anywhere (browser-level) |
| Screenshot the current tab | `Ctrl/Cmd + Shift + Y` | Anywhere (browser-level) |
| Open the popup | `Ctrl/Cmd + Shift + E` | Anywhere (browser-level) |
| Focus the search bar | `/` | In Vibesearch |
| Open settings | `Ctrl/Cmd + ,` | In Vibesearch |
| Toggle organize mode (drag to reorder & move) | `O` | In Vibesearch |

> Browser-level shortcuts can be rebound at `chrome://extensions/shortcuts`.

---

## Settings

Open settings with `Ctrl/Cmd + ,` inside Vibesearch. It's organized into:

- **Data** — import bookmarks & GitHub stars, import a shared link, export/import a JSON backup,
  back up to Google Drive, or delete everything.
- **Connectors** — add a GitHub token (to import your stars) and connect/disconnect a Google
  account. Credentials are stored locally on your device.
- **Shared tabs** — manage links you've shared: copy, rotate, revoke, and see view counts.
- **Tags** — rename, recolor, favorite, and clean up tags.
- **Search** — set your default **mode** (Hybrid / Keyword / Semantic / Fuzzy, with fine-tune
  toggles) and default **scope** (Everywhere / This space / Private / Public). You can always
  override either per-search from the chips on the search bar.
- **Search history** — clear recent queries, or open the recycle bin.
- **Misc** — choose the clipboard format for copied links (Plain / Markdown / JSON / HTML) and
  toggle "open Vibesearch on new tab".
- **Shortcuts** — the reference above, plus a link to customize browser shortcuts.

---

## Your data & privacy

Vibesearch is **local-first**. Here's exactly what lives where, in plain terms:

- **Your library** — items, folders, spaces, tags, the search index, and all embedding vectors —
  is stored **in your browser** (IndexedDB + the browser's private file system). It never goes to
  a Vibesearch server.
- **Search is fully local.** Your query is embedded on your own machine and matched against your
  local index. What you search for doesn't leave your computer.
- **The AI models** (embeddings on every supported browser, plus OCR on Chrome/Brave) are downloaded
  **once** from Vibesearch's CDN, cached, and run entirely **on-device** after that.
- **When you save a link**, its URL is sent to Vibesearch's metadata service to fetch the page's
  title, description, and preview image — the same way a link unfurls in a chat app.
- **Saved images and screenshots** are uploaded to Vibesearch's media storage so they survive cache
  clears and can be shared or backed up.
- **Sharing, Google Drive backup, and GitHub import are opt-in** — they only happen when you ask.

No account is required for the core app.

---

## Development

> Use dev mode when you want development-only tooling such as React Grab.

Install dependencies:

```sh
bun install
```

Start the Chrome dev build watcher:

```sh
bun run dev:chrome
```

If you are using npm instead:

```sh
npm run dev:chrome
```

This script builds the extension with both:

- `NODE_ENV=development`
- `vite --mode development`

Both are important. React Grab is only loaded when Vite mode is `development`, and the Chrome
config uses `NODE_ENV=development` to emit the dev extension manifest.

After the build finishes, load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `dist_chrome` folder from this repo.

The loaded extension should be named `Vibesearch (Dev)`. If you already had it loaded, click the
reload button on the extension card after each rebuild.

### Production builds

```sh
bun run build:chrome    # -> dist_chrome
bun run build:firefox   # -> dist_firefox
```

### Tests

```sh
bun test
```

### React Grab check

Open the popup, search page, or options page, then check the page console:

```js
window.__REACT_GRAB_DEV_READY__
```

It should be `true` in dev mode. If it is not, make sure you ran `bun run dev:chrome` or
`npm run dev:chrome`, not `build` or `build:chrome`.

### Project layout

```
src/
  workers/background.ts      MV3 service worker — orchestration, context menus, alarms, RPC router
  pages/
    search/                  the main app (library + search UI)
    popup/                   toolbar popup
    offscreen/               offscreen document — owns the DB, vector store, embedding/OCR pipelines
    ocr-sandbox/             sandboxed page that runs the OCR model
  services/                  controllers, vector store, search index, import, sync, OCR, ...
  search-core/               pure search logic (query language, embedding text, ranking)
  schemas/                   RxDB collection schemas
```

For how it all fits together, see the **[architecture documentation](docs/architecture/README.md)**.

---

## License

**PolyForm Noncommercial License 1.0.0.** Vibesearch is free to use, modify, and share —
anywhere — for any **noncommercial** purpose. Commercial use, and selling the software or works
based on it, are not permitted. Personal, hobby, research, educational, charitable, and
government use are all fine. See [`LICENSE`](LICENSE) for the full terms.

Contributions are welcome at
[github.com/0xHecker/vibesearch-extension](https://github.com/0xHecker/vibesearch-extension).
