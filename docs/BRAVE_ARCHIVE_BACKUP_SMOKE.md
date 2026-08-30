# Brave production smoke test: offline archives and full local backup

Use this checklist against a production Chromium build. It covers the paths
that unit tests cannot prove: Brave's MV3 service-worker lifecycle, offscreen
OPFS/IndexedDB access, the real iframe sandbox, airplane-mode preview, browser
restart recovery, and download/restore UI.

## 1. Build and load the production extension

Stop any `bun run dev:chrome` watcher first; a development watcher writes to
the same `dist_chrome` directory.

```sh
cd /Users/mac/projects/vibe-search-extension
bun run build:chrome
```

In Brave:

1. Open `brave://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose
   `/Users/mac/projects/vibe-search-extension/dist_chrome`.
4. Confirm the card says **Vibesearch**, not **Vibesearch (Dev)**, version
   `1.4.4`, with extension id `heembgihcngbcadkkpcmkhhlldkidoph`.
5. Open **service worker → Inspect**. Open Vibesearch once so the offscreen
   document is created, then confirm neither console has an uncaught exception
   or CSP violation.

The checked-in CDP probes can exercise a freshly built unpacked extension in a
separate Brave profile without touching the normal browser profile:

```sh
PROFILE_DIR="$(mktemp -d /tmp/vibesearch-brave-production.XXXXXX)"
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --headless=new \
  --remote-debugging-port=9224 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --disable-default-apps \
  --disable-extensions-except=/Users/mac/projects/vibe-search-extension/dist_chrome \
  --load-extension=/Users/mac/projects/vibe-search-extension/dist_chrome \
  about:blank
```

Leave that command running and, in a second terminal, run:

```sh
cd /Users/mac/projects/vibe-search-extension
BRAVE_CDP_ENDPOINT=http://127.0.0.1:9224 \
BRAVE_EXTENSION_DIR=/Users/mac/projects/vibe-search-extension/dist_chrome \
  bun scripts/audit-brave-extension.mjs
BRAVE_CDP_ENDPOINT=http://127.0.0.1:9224 \
  bun scripts/audit-brave-archive-preview.mjs
```

The first probe verifies the production name/version, stable extension id,
service-worker wake after normal MV3 suspension, offscreen document, Search UI,
IndexedDB, OPFS, and a real version-2 build → OPFS handoff → validation →
restore cycle across all nine collections. The second uses the real
`ArchivePreviewSession` output in Brave and verifies that the read-only archived
document cannot follow a live link while its viewport still scrolls.

For the complete destructive audit, use only the disposable profile created
above. This restores one cached archive and one authoritative pending-outbox
archive, proves their exact bytes survive export and restore, runs Delete All,
and verifies all nine collections and binary manifests are empty afterward:

```sh
BRAVE_CDP_ENDPOINT=http://127.0.0.1:9224 \
BRAVE_EXTENSION_DIR=/Users/mac/projects/vibe-search-extension/dist_chrome \
BRAVE_AUDIT_ARCHIVE_FIXTURE=1 \
BRAVE_AUDIT_DELETE_ALL=1 \
  bun scripts/audit-brave-extension.mjs
```

Do not set `BRAVE_AUDIT_DELETE_ALL=1` against a normal Brave profile: the probe
intentionally invokes the extension's irreversible Delete All operation.

## 2. Archive capture, offline View, and recovery

Use a normal web article with images and at least one link. Do not use a browser
internal page, PDF viewer, or another extension page.

1. Connect Vibesearch cloud, save the article, and leave its tab on the same
   URL until **Offline preview** reports that the local capture completed.
2. Immediately disconnect the computer from the network and click the item's
   **View archived copy** action. The side sheet must render the saved page from
   local storage without an auth or network request.
3. Scroll the archived page. Tab to or click a link inside the saved document:
   the iframe must stay on its Blob URL. Only **Open live page** in the sheet
   header may open the network URL.
4. Close the sheet while it is loading, reopen it, switch rapidly between two
   items, and close it again. There must be no stale document flash, console
   exception, or ever-growing set of retained Blob URLs.
5. Reconnect, click **Refresh copy**, then disconnect again. Reopening View must
   still work. If the refresh request fails, the readable cached copy must win.
6. Quit Brave completely and reopen it while offline. View must still render
   the same archived copy.
7. Save a second article, quit Brave while its archive is waiting to upload,
   then reopen online. The outbox must resume and eventually empty; the archive
   must remain available offline after acknowledgement.
8. Start a third save and use its Undo action during capture. Then permanently
   delete another archived item from Bin. Neither item may remain in the
   archive outbox or cache, and no late HTTP upload may begin after deletion.

Useful service-worker console check:

```js
await chrome.storage.local.get([
  "vibesearch:archiveOutbox:v1",
  "vibesearch:archiveCache:v1",
  "vibesearch:localDataResetInProgress:v1",
  "vibesearch:localDataResetEpoch:v1",
])
```

## 3. Full JSON export and restore

Prepare a small, recognizable fixture before exporting:

- two spaces and nested folders;
- several normal links plus one deleted/Bin item;
- tags, a favorite, search history, and a flashcard if available;
- one screenshot or imported image stored in OPFS;
- one locally readable offline page archive;
- optionally, one archive upload still pending while the network is off.

Then:

1. Open **Settings → Data → Export a full backup → Export**.
2. Confirm the downloaded JSON is format
   `vibesearch-local-extension-migration`, version `2`, and contains all nine
   collection arrays, `opfsFiles`, `archiveFiles`, and `warnings`.
3. Confirm the counts shown after export match the fixture. A pending local
   archive upload must appear in `archiveFiles`; it must not be silently lost
   merely because cloud upload has not finished.
4. Search the JSON for private-space password hashes, recovery answers/hashes,
   and folder encryption keys. None may be present. The warning list must
   explain any credential redaction.
5. Use **Delete all data**, read the destructive confirmation, and confirm it.
   Reload Vibesearch: spaces, folders, items, tags, media, cached archives,
   pending archive jobs, staged payloads, and vector files must be gone.
6. Choose the exported JSON under **Restore from a backup file**. Verify the
   staged summary before clicking **Restore now**.
7. After restore, compare every fixture count and relationship. Keyword search
   should work immediately; run **Rebuild index** and verify semantic search.
8. Keep the computer offline and open the restored archived item. It must render
   from the JSON-restored archive bytes without cloud auth.
9. Restore the same file a second time. Records must merge by id instead of
   duplicating the library.
10. Try an empty JSON file, unrelated JSON, a truncated backup, and a file over
    the 96 MiB limit. Each must fail before changing database rows. A failure
    rejected by the reset barrier must not leave a large `local-import-*.json`
    file in the staging directory.

To inspect top-level OPFS directories from an extension DevTools console:

```js
const root = await navigator.storage.getDirectory();
Array.fromAsync(root.entries(), ([name, handle]) => ({ name, kind: handle.kind }));
```

## 4. Chromium/Brave lifecycle checks

1. In `brave://extensions`, click the service worker's **Inspect** link, note
   the current worker, close DevTools, wait for suspension, and invoke Save or
   View again. Work must resume without reloading the extension.
2. Run the quick-save and screenshot keyboard commands. Confirm the screenshot
   is searchable by OCR after processing.
3. Toggle OS/network offline state during capture, upload, first cloud-only
   View, JSON staging, and restore. Every operation must either finish or show a
   bounded retryable error; none may lose an already accepted local archive.
4. Reopen both service-worker and offscreen consoles. There must be no remote
   code, `unsafe-eval` extension-page violation, blocked RxDB development
   tracking iframe, uncaught OPFS error, or unhandled promise rejection.
