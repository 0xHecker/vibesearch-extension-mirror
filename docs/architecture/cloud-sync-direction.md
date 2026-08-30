# Cloud sync direction

Saving is one way out of the extension: local changes are pushed to the cloud so
the web and mobile apps can read them. Nothing the web app writes is allowed to
change a local library.

## Bringing in another browser's saves

A device can opt in (Settings → Vibesearch → "Bring in items from my other
devices", off by default) to also read the account's change log. Two rules keep
that safe, and both are enforced in code:

**Only extension-authored rows.** `normalizeCloudDoc` stamps every pushed
document with `syncOrigin: "extension"`, and `planCloudPullMerge` accepts only
documents carrying that stamp. Rows created in the web app — or by any client
that does not stamp itself — are fetched and discarded. The stamp is stripped
again before the local insert, so no local schema knows about it, and the server
needs no schema change: it stores documents as opaque JSON.

Documents pushed by extension builds older than this stamp are treated as
foreign until they are pushed again. Conservative on purpose.

**Additive only.** A pull may add rows this device has never seen; it may never
modify or remove one:

1. A remote deletion never deletes locally.
2. An id already present locally is left untouched.
3. An item whose URL already exists in the same space is skipped, not duplicated.
4. Anything left is inserted, parents before children.

Because nothing local is ever rewritten, there is no conflict resolution, no
merge UI, and nothing to undo.

## Mechanics

`GET /v1/sync/pull?since=<checkpoint>&clientId=<device>` returns a bounded page
plus a checkpoint, and replays a bootstrap snapshot when a cursor was compacted.
The checkpoint advances only after a page is applied, so an interrupted run
re-reads that page instead of skipping it. Up to 4 pages of 250 changes per run.

Incoming documents are trimmed at runtime to the local schema's `properties`, so
a new server-side field cannot break a sync; a row missing a required field is
skipped rather than repaired with invented values.

## Per-item state

The push queue is the only source of truth for "is this backed up": queued means
waiting, absent means the server acknowledged it, and no session means not backed
up. Card hover shows that state, and a selection can be pushed on demand from the
bulk bar.
