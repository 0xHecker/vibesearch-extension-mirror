# Chrome Web Store — Listing & Review Answers (draft)

Copy-paste source for the Web Store dashboard. Fill the `〈…〉` placeholders before submitting.

---

## Store listing

**Item name** (≤ 75 chars)
```
Vibesearch — semantic search for your tabs, bookmarks & screenshots
```

**Summary** (≤ 132 chars — matches the manifest description)
```
Local-first semantic + keyword search for your tabs, bookmarks, and screenshots. On-device AI and OCR, private by design.
```

**Category:** Productivity
**Language:** English

**Detailed description**
```
Vibesearch is your browser's memory, finally searchable — by meaning, not just exact words.

Save tabs, links, images, quotes, and whole pages, then find them again the way you think.
A hybrid engine blends on-device semantic (AI) search with keyword, fuzzy, and sounds-like
matching, so the right result surfaces even when you don't remember the exact title. The text
inside screenshots and images is read with on-device OCR, so it's searchable too.

It's local-first and private: the extension keeps a complete local library and runs search on
device. No account is required for the core app; connecting cloud sync sends saved library data
and offline previews to Vibesearch so they are available on your other devices.

WHAT YOU CAN DO
• Save anything — quick-save a tab, or right-click a link, image, video, quote, or whole page.
• Screenshots — capture the full page or a region; their text is OCR'd and searchable.
• Hybrid search — semantic + keyword + fuzzy + phonetic, fused into one ranked list.
• A powerful query language — filter by space, source, site, tag, folder, author, and date.
• Organize — nestable spaces, folders, and tab groups, with tags, favorites, and a recycle bin.
• Private spaces — password-protected, with recovery questions and auto-lock.
• Import — your browser bookmarks and your GitHub stars, with previews fetched automatically.
• Share — send a space, folder, or selection as a link (optional PIN, revocable).
• Back up & restore — to a JSON file or your own Google Drive.

PRIVACY
• Your search index and AI vectors stay on your device; synced library records and page previews
  are sent only after cloud sync is connected.
• Search runs locally — your queries are never transmitted.
• No ads, no third-party tracking, no account needed.
• When you save a link, its URL is sent to Vibesearch's metadata service to fetch a title and
  preview image. Saved images are stored in Vibesearch media storage so they're durable and
  shareable. Sharing, Google Drive backup, and GitHub import are opt-in.
See the full privacy policy: 〈hosted PRIVACY.md URL〉
```

**Privacy policy URL** (required): host `docs/PRIVACY.md` and paste the URL, e.g.
`https://github.com/0xHecker/vibesearch-extension/blob/main/docs/PRIVACY.md` (a GitHub Pages or
website URL is cleaner).

---

## Single purpose (required)

```
Vibesearch's single purpose is to let users save items from the web (tabs, bookmarks, links,
images, and screenshots) into a personal library and find them again using on-device semantic
and keyword search.
```

---

## Permission justifications (required for review)

Paste each next to its permission in the dashboard.

| Permission | Justification |
| --- | --- |
| `storage` | Persist the user's settings and lightweight app state locally. |
| `activeTab` | Read the current tab's URL/title and capture it when the user invokes save or screenshot. |
| `tabs` | Quick-save the current tab and open a folder's links together as a tab group. |
| `tabGroups` | Group the tabs opened from a saved folder into a named browser tab group (`chrome.tabGroups.update`). |
| `bookmarks` | User-initiated first import of bookmarks, followed by background reconciliation only for that imported collection when browser bookmarks change. |
| `scripting` | Inject the drag-to-select overlay used for region screenshots on the active tab. |
| `contextMenus` | Provide right-click "Save to Vibesearch" / "Extract text" / "Screenshot" actions. |
| `alarms` | Schedule background indexing, embedding, and periodic vector maintenance. |
| `offscreen` | Run the database, search index, and AI (embedding/OCR) pipelines in a persistent offscreen document; the service worker can't hold this state or file handles. |
| `identity` | Sign in to the user's Google account (only when they connect Google) to back up/restore to their own Drive. |
| **Host: Vibesearch services** (`metadata-worker.watermelons.workers.dev`, `share-worker.watermelons.workers.dev`, `share.vibesearch.app`, `bucket.vibesearch.app`, `preview-bucket.vibesearch.app`) | Fetch link previews, download the AI models, store saved media, and create/import shares. |
| **Host: Google** (`accounts.google.com`, `www.googleapis.com`, `sheets.googleapis.com`) | Optional backup/restore to the user's own Google Drive/Sheets. |
| **Host: GitHub** (`api.github.com`) | Optional, user-initiated import of the user's GitHub stars. |
| **Site access** (`http://*/*`, `https://*/*`) | The lightweight content script supports right-click/hover save. Full rendered DOM capture starts only after the user saves that page. The archive feature adds no new broad host permission or `pageCapture`. |

### Remote code (review will ask)

```
Vibesearch does NOT load or execute remote JavaScript. All code is bundled in the package.
The extension downloads WebAssembly AI model assets (embedding + OCR) and model weights from
Vibesearch's own host; these are data/WASM, executed under 'wasm-unsafe-eval' (and, for the
OCR runtime, inside a sandboxed page). No remote JS is fetched or eval'd.
```

> ⚠️ Before submitting, trim the **unused** legacy host entries (`huggingface.co`,
> `cas-bridge.xethub.hf.co`, `cdn.jsdelivr.net`, `meta.vibesearch.app`) — see
> [RELEASE.md](RELEASE.md). Reviewers reject permissions the extension doesn't use.

---

## Data usage disclosures (Privacy practices tab)

Answer the certification form as follows (verify against your final build):

- **Personally identifiable information:** No (no name/email/account collected).
- **Authentication information:** Yes — a GitHub token and Google sign-in, **stored locally on
  the device**, used only to talk to those services on the user's behalf.
- **Web history:** Collected in the sense that **saved** URLs are sent to metadata and sync
  services. Browsing history at large is not collected.
- **User-generated content:** Yes — synced saved items, rendered offline page snapshots, and
  uploaded images (to provide cross-device sync, storage, sharing, and backup).
- **Location / health / financial / personal communications:** No.

Required certifications (all true for Vibesearch):
- ☑ I do **not** sell or transfer user data to third parties (outside approved use cases).
- ☑ I do **not** use or transfer data for purposes unrelated to the item's single purpose.
- ☑ I do **not** use or transfer data to determine creditworthiness or for lending.

---

## Assets to upload (see [RELEASE.md](RELEASE.md) for specs)

- Store icon 128×128 (have: `favicon_squared-128.png`).
- 1–5 screenshots, 1280×800 (or 640×400).
- Optional: small promo tile 440×280.
