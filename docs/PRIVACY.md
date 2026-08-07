# Vibesearch — Privacy Policy

_Last updated: 2026-07-10 · Applies to: Vibesearch browser extension (Chrome & Firefox)_

> This document describes how the Vibesearch browser extension handles your data. It is written
> to be accurate to what the software actually does. It is not legal advice — review and adapt it
> (and the contact details below) before publishing.

## Summary

Vibesearch is **local-first**: the extension keeps its own local library, search index, and AI
vectors, and core search works without an account. When cloud sync is connected, library changes
and offline page previews are sent to the Vibesearch API so they can appear on your other devices.
URLs also leave the browser for link previews, and saved media may be uploaded for durability.
Sharing, Google backup, and GitHub import are user-initiated features. Vibesearch shows **no ads**
and uses **no third-party analytics or behavioral tracking**.

## What stays on your device

Stored locally in your browser (IndexedDB and the Origin Private File System):

- Your saved items, folders, spaces, space groups, and tags. These are also sent to the
  Vibesearch API after cloud sync is connected.
- The search index and all embedding vectors.
- Your settings and preferences.
- Your search history (which you can clear at any time).
- Credentials you enter (a GitHub token; cached Google sign-in) are stored locally on your
  device only.

**Extension search runs entirely on your device.** Your query is converted to an embedding
locally and matched against your local index. The extension does not transmit search queries.

## What is sent off your device, and why

| Data | Sent to | Why | When |
| --- | --- | --- | --- |
| The URL of a page/link you save | Vibesearch metadata service (`metadata-worker.watermelons.workers.dev`) | To fetch the page's title, description, and preview image (a "link unfurl") | When you save a link, or import bookmarks/stars |
| Saved items, folders, spaces, tags, relationships, and deletion records | Vibesearch API (`vibesearch-api.watermelons.workers.dev`) | To sync the library across Vibesearch clients and keep a durable cloud copy | After cloud sync is connected; queued local changes resume automatically on startup, reconnect, and scheduled sync |
| The rendered HTML snapshot of a saved web page | Vibesearch API and Cloudflare R2 | To sanitize and store an offline page preview for web and mobile | For a saved page after cloud sync is connected; capture may include visible rendered page content, so do not save a sensitive page unless you want that snapshot synced |
| Images & screenshots you save | Vibesearch media storage (`bucket.vibesearch.app`, Cloudflare R2) | So saved media survives local cache clears and can be shared/backed up | After you save an image or screenshot |
| Model download requests (no personal data) | Vibesearch model host (`metadata-worker.watermelons.workers.dev`) | To download the embedding model, plus the OCR model on Chrome/Brave, then cache them locally | First run / when models update |
| A snapshot of the space/folder/items you choose to share | Vibesearch share service (`share-worker.watermelons.workers.dev` / `share.vibesearch.app`) | To create a shareable link | Only when you create a share |
| A backup snapshot of your library | **Your own Google account** (Google Drive & Sheets) | To back up and restore your library | Only if you connect Google and run a backup |
| Read request for your starred repositories | GitHub (`api.github.com`) using your token | To import your GitHub stars | Only when you import GitHub stars |

Notes:

- **OCR runs on your device in Chrome/Brave.** Text is extracted from images locally; the extracted
  text is not sent as a separate OCR request. It becomes part of the item and is included in cloud
  sync, sharing, or backup when those features are used. The Firefox package currently omits OCR
  because Gecko MV3 does not support the sandboxed extension page required by the bundled model.
- **Offline previews are inert after upload.** The API strips scripts, forms, frames, event
  handlers, and unresolved network resources before storing the snapshot. The browser still
  sends the rendered page HTML to the API, which can include content visible in a signed-in page.
- **Sharing is opt-in and revocable.** A shared link is a "capability URL": anyone with the link
  (and PIN, if you set one) can view the shared snapshot until you revoke it. Don't share links
  publicly if the content is sensitive. The share service stores the snapshot you shared and
  basic view counts for that link.
- **Google backups go to your own Drive.** Vibesearch requests only the `drive.file` scope (it
  can see and manage only the files it creates) and `spreadsheets`. Disconnecting clears the
  cached sign-in on your device.

## What Vibesearch does NOT do

- No ads.
- No third-party advertising or analytics SDKs, and no behavioral tracking.
- No selling or renting of personal data.
- No account, email, or sign-up required to use the core app.

## Permissions, in plain language

- **storage** — save your settings locally.
- **tabs / activeTab** — read the current tab's URL and title when you save or screenshot it.
- **scripting** — draw the region-selection overlay for screenshots and start a user-triggered,
  bounded snapshot of the rendered page for its offline preview.
- **bookmarks** — read your bookmarks for an import you explicitly start; after that first import,
  read the tree again when your browser bookmarks change so the imported collection stays current.
- **tabs / tabGroups** — open a folder's links together as a browser tab group.
- **contextMenus** — add the right-click "Save to Vibesearch" actions.
- **alarms** — schedule background indexing and maintenance.
- **offscreen (Chrome/Brave only)** — host the database and search pipelines outside the MV3
  service worker. Firefox uses its DOM-backed MV3 background page instead and does not request
  this Chrome-only permission.
- **identity** — sign in to Google (only if you connect Google for backup).
- **site access (`http://*/*`, `https://*/*`)** — run the lightweight save-target content script
  on web pages so right-click/hover save works. Full DOM snapshotting starts only after a save
  action. The archive path adds no new broad host permission or `pageCapture`, and has no
  privileged background resource proxy.
- **host permissions** — limited to Vibesearch services, Google APIs (for backup), and GitHub's
  API (for stars import).

## Your choices & data deletion

- **Delete individual items** — they go to a recycle bin and are permanently removed after 30
  days (or immediately if you empty the bin).
- **Delete everything** — Settings → Data → delete all data wipes your local library.
- **Clear search history** — Settings → Search history.
- **Revoke a share** — Settings → Shared tabs.
- **Disconnect Google / remove your GitHub token** — Settings → Connectors.
- Uninstalling the extension removes its local data from your browser, but does not itself send a
  cloud-deletion request. Use Vibesearch deletion controls before uninstalling, or contact us to
  request deletion of synced items, page snapshots, uploaded media, and shares.

## Children

Vibesearch is a general-purpose productivity tool and is not directed to children under 13.

## Changes

We may update this policy as the extension evolves. Material changes will be reflected by the
"Last updated" date above.

## Contact

Questions or data requests: open an issue at
<https://github.com/0xHecker/vibesearch-extension/issues> _(replace with a contact email before
publishing — the Chrome Web Store requires a working contact method)._
