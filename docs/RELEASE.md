# Chrome Web Store — Release Checklist

Status for **v1.4.4 source**. ☑ = done in this repo · ☐ = owner action required.

Related: [chrome-web-store-listing.md](chrome-web-store-listing.md) (listing copy + permission
justifications) · [PRIVACY.md](PRIVACY.md) (privacy policy).

---

## 1. Done in this repo

- ☑ **Fixed the manifest `description`** — it was `"."` (a hard blocker); now a real 120-char
  description in `manifest.base.json`.
- ☑ **Production build verified** — `bun run build:chrome` succeeds and emits `dist_chrome/`
  with the correct manifest. No source maps, no dev icons (stripped in production).
- ☐ **Rebuild the upload zip** after the archive/cloud-sync changes. Existing versioned zip
  files predate the current source and must not be submitted as current artifacts.
- ☑ **Privacy policy drafted** — `docs/PRIVACY.md`.
- ☑ **Listing copy + permission justifications drafted** — `docs/chrome-web-store-listing.md`.

Rebuild + repackage any time with:

```sh
bun run build:chrome
( cd dist_chrome && zip -rqX ../vibesearch-chrome-v$(node -p "require('./package.json').version").zip . -x '.vite/*' '*.DS_Store' )
```

---

## 2. Recommended code change before submitting — trim unused hosts

Reviewers reject extensions that request host permissions they don't use. These four hosts are
**confirmed unused** (model now loads from `metadata-worker…workers.dev` / R2; ORT is bundled;
`meta.vibesearch.app` is retired — verified by grep, only present in comments):

- `huggingface.co`
- `cas-bridge.xethub.hf.co`
- `cdn.jsdelivr.net`
- `meta.vibesearch.app`

I did **not** apply this automatically because a wrong removal would break model downloads.
Apply it, then run the smoke test in §7.

**`manifest.base.json` → `content_security_policy.extension_pages` → `connect-src`:** remove
`https://huggingface.co https://cas-bridge.xethub.hf.co https://cdn.jsdelivr.net` and
`https://meta.vibesearch.app`. Result:

```
connect-src 'self' data: https://metadata-worker.watermelons.workers.dev https://share-worker.watermelons.workers.dev https://share.watermelons.workers.dev https://share.vibesearch.app https://bucket.vibesearch.app https://preview-bucket.vibesearch.app https://accounts.google.com https://www.googleapis.com https://api.github.com
```

**`manifest.host-permissions.json`:** remove these two lines:

```
"https://huggingface.co/*",
"https://meta.vibesearch.app/*",
```

- ☐ Apply the trim, `bun run build:chrome`, then **smoke test (§7)** — confirm semantic search
  still downloads the model and returns results. If anything breaks, revert (one line each).

---

## 3. Decision: keep the `key` (do NOT remove)

`manifest.base.json` contains a `"key"`. **Keep it.** It pins the extension's ID, and the
Google sign-in flow depends on that ID:

- `chrome.identity` falls back to `launchWebAuthFlow` with redirect
  `https://<EXTENSION_ID>.chromiumapp.org/google`.
- That redirect URI is registered against your Google OAuth client. Removing the `key` changes
  the extension ID and **breaks Google backup/restore**.

- ☐ Confirm the ID produced by this `key` matches the ID registered in your Google OAuth client
  (and the one you'll publish under).

---

## 4. Google OAuth setup (only needed for the Drive backup feature)

The backup feature requests only `drive.file`: it can create, find, update, and restore the
Vibesearch JSON files it created, but it cannot browse arbitrary Drive contents.

- ☑ The public Chrome Extension client is present in `manifest.chrome.json` with `drive.file`.
- ☑ The fallback web client and stable unpacked Chrome callback are configured in Google Cloud.
- ☐ Before publishing under a different Chrome Web Store id, register that exact id/client and
  its `https://<EXTENSION_ID>.chromiumapp.org/google` fallback callback.
- ☐ **Firefox release blocker:** register and smoke-test the exact Firefox loopback callback
  derived by `google-auth.firefox.ts`. The current Google web client rejects that callback with
  `redirect_uri_mismatch`; do not advertise Firefox Drive backup until it is accepted end to end.

---

## 5. Secrets / environment

- ☑ Local build works (`.env.production.local` provides `VITE_IMPORT_MEDIA_UPLOAD_TOKEN`).
- ☐ CI (`.github/workflows/ci.yml`) needs repo secret **`VITE_IMPORT_MEDIA_UPLOAD_TOKEN`** (same
  value as the metadata worker's `IMPORT_MEDIA_TOKEN`).
- ⚠️ This token is a `VITE_` var, so it is **embedded in the shipped bundle**. Make sure it's an
  upload-only token with no broader privileges, and rotate it if it ever leaks.

### Notion OAuth/export

- ☑ Public OAuth connection `VibeSearch` uses callback
  `https://vibesearch-api.watermelons.workers.dev/oauth/notion/callback`.
- ☑ The connection is installable in any workspace and requests content read/update/insert only;
  it does not request comments or user profile/email access.
- ☑ `NOTION_CLIENT_ID` is a Worker variable and `NOTION_CLIENT_SECRET` is a Cloudflare secret.
- ☑ The deployed OAuth broker allow-lists the stable unpacked and published Chrome callbacks.
- ☐ Before shipping under another extension ID, add its exact
  `https://<EXTENSION_ID>.chromiumapp.org/notion` callback to the broker allow-list.

---

## 6. Store assets the owner must create

- ☐ **Developer account** — register/verify a Chrome Web Store developer account (one-time $5).
- ☐ **Privacy policy URL** — host `docs/PRIVACY.md` and add a real **contact email** (CWS
  requires a working contact). Paste the URL into the listing + the Account page.
- ☐ **Screenshots** — 1–5 images at **1280×800** (or 640×400): library/search view, a query with
  filter chips, a private space, settings. (Most impactful asset for installs.)
- ☑ **Store icon** — `favicon_squared-128.png` (128×128).
- ☐ Optional: small promo tile **440×280**.

---

## 7. Smoke test the production build before submitting

Load the **production** build (not the dev build) and verify end-to-end:

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `dist_chrome` (or unzip
   the freshly rebuilt zip). Confirm the name is **"Vibesearch"** (not "Vibesearch (Dev)")
   and the description shows correctly.
2. Save a tab (`Ctrl/Cmd+Shift+S`); confirm it appears with a fetched title/preview.
3. Open Vibesearch, run a **semantic** query → confirms the **embedding model downloads and
   search returns results** (this validates the §2 host trim).
4. Take a region screenshot (`Ctrl/Cmd+Shift+Y`) → after a moment, confirm its text is
   searchable (validates OCR).
5. Import a few bookmarks; (optional) connect Google and run a backup.
6. Open the service worker console and the offscreen console → confirm **no CSP violations** and
   no failed network requests to removed hosts.
7. Save a dynamic page, wait for cloud sync, then open its offline preview in web and mobile.
   Repeat while offline, restart Chrome, reconnect, and verify the OPFS job resumes. Click Undo
   during capture and verify neither the item nor an archive remains.

---

## 8. Submit

- ☐ Upload the freshly rebuilt versioned Chrome zip in the Web Store Developer Dashboard.
- ☐ Fill the listing from [chrome-web-store-listing.md](chrome-web-store-listing.md).
- ☐ Complete the **Privacy practices** tab (data disclosures + certifications in that doc).
- ☐ Paste **permission justifications** (incl. the "no remote code" statement).
- ☐ Add the privacy policy URL + contact email.
- ☐ Submit for review.

---

## 9. Notes / nice-to-haves (not blockers)

- **Bundle size:** ~72 MB unzipped. The bulk is two ONNX Runtime WASM files
  (`…asyncify.wasm` 23.5 MB + `…jsep.wasm` 26.2 MB) plus `worker-entry` (11 MB) and `ocrSandbox`
  (10 MB). Within CWS limits, but if you want to slim it, check whether **both** ORT WASM
  variants are actually loaded at runtime — the embedding worker pins the `asyncify` build, so
  the `jsep` build may be droppable if OCR doesn't need it. Verify before removing.
- The Firefox build (`bun run build:firefox` → `dist_firefox`, zipped by CI) is a separate Gecko
  MV3 package with a DOM background page and `browser_specific_settings.gecko.id`; this checklist
  is Chrome-only. Its local semantic search remains enabled, while OCR is deliberately excluded
  until Gecko MV3 supports the required sandboxed extension page. Validate it with Mozilla's
  `web-ext lint` before publishing to AMO.
- CI already builds + zips + attaches both to a GitHub release on push to `main`; you can grab
  the Chrome zip from there instead of building locally once the secret in §5 is set.

---

## 10. Third-party licensing decision (release blocker)

The live-page archive feature bundles `single-file-core@1.5.84`, published as
`AGPL-3.0-or-later`. The repository itself currently declares
`PolyForm-Noncommercial-1.0.0`. `THIRD_PARTY_NOTICES.md` and the upstream license text are shipped,
but notices alone do not decide whether the combined distribution is license-compatible.

- ☑ Ship the exact upstream license text and source/project link.
- ☐ Before publishing, have the owner choose and document a compliant route: distribute under
  terms compatible with the AGPL obligations, obtain a separate SingleFile license, or replace
  the dependency with a compatibly licensed implementation. This is a licensing review item,
  not a technical test result.
