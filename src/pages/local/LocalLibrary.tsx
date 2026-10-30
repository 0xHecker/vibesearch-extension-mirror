import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { describeLocalError, localClient, type LocalViewStatus } from "@src/services/local-companion-client";
import { readExtensionPolicy, writeExtensionPolicy, type ExtensionPolicy } from "@src/services/extension-policy";
import type { LocalCapture, LocalReadResult, LocalSearchResult } from "@src/services/local-companion-protocol";

const browserSchema = z.enum(["chrome", "edge", "chromium", "brave", "firefox"]);
const manifestIdentitySchema = z.object({ browser_specific_settings: z.object({ gecko: z.object({ id: z.string() }) }).optional() });
const button = "rounded-lg border border-border-neutral-faded px-4 py-2 disabled:opacity-50";
function downloadJson(capture: LocalCapture) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "vibesearch-local-capture", version: 1, capture }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `vibesearch-capture-${capture.id}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function LocalLibrary() {
  const [status, setStatus] = useState<LocalViewStatus | null>(null);
  const [policy, setPolicy] = useState<ExtensionPolicy | null>(null);
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [result, setResult] = useState<LocalSearchResult | null>(null);
  const [reader, setReader] = useState<LocalReadResult | null>(null);
  const [snapshot, setSnapshot] = useState<LocalCapture | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browser, setBrowser] = useState<z.infer<typeof browserSchema>>(navigator.userAgent.includes("Firefox") ? "firefox" : "chrome");
  useEffect(() => {
    let active = true;
    void readExtensionPolicy().then(settings => { if (active) setPolicy(settings); });
    void localClient.status().then(state => { if (active) setStatus(state); }).catch(caught => { if (active) setError(describeLocalError(caught)); });
    return () => { active = false; };
  }, []);
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (caught) { setError(describeLocalError(caught)); } finally { setBusy(false); } }
  async function refresh(retry = false) { await run(async () => { setStatus(await (retry ? localClient.retry() : localClient.status())); }); }
  async function enable() { await run(async () => { if (!await chrome.permissions.request({ permissions: ["nativeMessaging"] })) { setError("Local companion permission was not enabled."); return; } setStatus(await localClient.status()); }); }
  async function search(event: FormEvent) { event.preventDefault(); const text = query.trim(); await run(async () => { setResult(await localClient.search(text)); setSearchedQuery(text); }); }
  async function more() { if (!result?.nextCursor) return; const cursor = result.nextCursor; await run(async () => { const page = await localClient.search(searchedQuery, cursor); setResult(current => current ? { ...page, hits: [...current.hits, ...page.hits] } : page); }); }
  async function open(itemId: string, partId?: string) { await run(async () => { setReader(await localClient.read(itemId, { partId })); }); }
  async function readMore() { if (!reader || reader.nextCursor === null || !reader.partId || !reader.sourceHash) return; const current = reader; await run(async () => { const next = await localClient.read(current.itemId, { partId: current.partId ?? undefined, sourceHash: current.sourceHash ?? undefined, start: current.nextCursor ?? 0 }); setReader({ ...next, text: current.text + next.text }); }); }
  async function downloadOriginal(itemId: string, mediaId: string, queued = false) {
    await run(async () => {
      const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0; let hash = ""; let mime = ""; let fileName = "";
      do {
        const page = await (queued ? localClient.queuedOriginal(itemId, mediaId, offset) : localClient.original(itemId, mediaId, offset));
        if (page.offset !== offset || page.mediaId !== mediaId || (hash && page.contentHash !== hash)) throw new Error("ORIGINAL_CHANGED");
        if (page.byteSize > 128 * 1024 * 1024) throw new Error("ORIGINAL_DOWNLOAD_TOO_LARGE");
        hash = page.contentHash; mime = page.mimeType; fileName = page.fileName;
        chunks.push(Uint8Array.from(atob(page.data), char => char.charCodeAt(0)));
        if (page.nextOffset === null) break;
        if (page.nextOffset <= offset) throw new Error("INVALID_ORIGINAL_OFFSET");
        offset = page.nextOffset;
      } while (true);
      const blob = new Blob(chunks, { type: mime });
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== hash) throw new Error("ORIGINAL_CHANGED");
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function setMode(mode: ExtensionPolicy["mode"]) { await run(async () => { const next: ExtensionPolicy = { version: 1, mode, legacyCloudEnabled: mode === "legacy-browser" }; await writeExtensionPolicy(next); setPolicy(next); if (mode === "legacy-browser") await chrome.tabs.create({ url: chrome.runtime.getURL("src/pages/search/index.html") }); }); }
  const available = status?.companion.state === "available";
  const manifestIdentity = manifestIdentitySchema.safeParse(chrome.runtime.getManifest());
  const extensionId = browser === "firefox" && manifestIdentity.success ? manifestIdentity.data.browser_specific_settings?.gecko.id ?? "vibesearch@vibesearch.app" : chrome.runtime.id;
  return <main className="mx-auto max-w-3xl px-5 py-10 text-foreground-neutral">
    <h1 className="text-3xl font-semibold">Your local library</h1>
    <p className="mt-3 text-foreground-secondary">Saved pages live on this computer. Search and reading work without an account or a model.</p>
    <section className="mt-6 rounded-xl border border-border-neutral-faded p-5" aria-label="Library mode">
      <p className="font-semibold">{!policy ? "Checking library mode..." : policy.mode === "legacy-browser" ? "Browser library enabled" : "Local-only mode enabled"}</p>
      <p className="mt-2 text-sm">The browser library keeps your existing saves, search, screenshots and account sync. Local-only mode sends new captures to the desktop companion and pauses browser cloud and model processing. Switching modes preserves both libraries.</p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" className={button} disabled={busy || policy?.mode === "local-only"} onClick={() => void setMode("local-only")}>Use local mode</button>
        <button type="button" className={button} disabled={busy} onClick={() => void setMode("legacy-browser")}>Use browser library</button>
      </div>
      <p className="mt-2 text-xs text-foreground-secondary">Browser mode works without the desktop app. Cloud sync uses your existing sign-in; no account is required for local-only mode.</p>
      <LegacyImportControls busy={busy} run={run} />
    </section>
    <section className="mt-6 rounded-xl border border-border-neutral-faded p-5" aria-label="Companion status">
      <p role="status">{!status ? "Checking companion..." : available ? `Companion ready. ${status.companion.state === "available" ? status.companion.details.items : 0} saved items.` : status.companion.state === "disabled" ? "Enable the local companion permission." : describeLocalError(new Error(status.companion.state === "unavailable" ? status.companion.error : "COMPANION_UNAVAILABLE"))}</p>
      <div className="mt-3 flex gap-3">{status?.companion.state === "disabled" && <button type="button" disabled={busy} onClick={() => void enable()} className={button}>Enable companion</button>}<button type="button" disabled={busy} onClick={() => void refresh()} className={button}>Check connection</button>{status?.pending.some(job => job.state === "pending") && <button type="button" disabled={busy} onClick={() => void refresh(true)} className={button}>Retry pending saves</button>}</div>
      {!available && <div className="mt-4 text-sm text-foreground-secondary"><p>Install and open the VibeSearch desktop app. In Settings, choose Connect browser, select this browser, and paste the extension ID below. Follow the app's registration step, then enable the permission and check the connection here.</p><label htmlFor="local-browser" className="mt-3 block">Browser</label><select id="local-browser" value={browser} onChange={event => setBrowser(browserSchema.parse(event.target.value))} className="mt-1 rounded border px-3 py-2">{browserSchema.options.map(name => <option key={name}>{name}</option>)}</select><p className="mt-2 break-all">Extension ID: <code>{extensionId}</code></p></div>}
    </section>
    <form onSubmit={event => void search(event)} className="mt-7 flex gap-3"><label htmlFor="local-query" className="sr-only">Search saved text</label><input id="local-query" value={query} maxLength={1024} onChange={event => setQuery(event.target.value)} placeholder="Search saved text" className="min-w-0 flex-1 rounded-lg border bg-background-neutral px-4 py-3" /><button type="submit" disabled={busy || !available || !query.trim()} className={button}>Search</button></form>
    <p role="alert" className="mt-3 text-sm">{error}</p>
    {result && <section className="mt-5" aria-label="Local search results"><p className="text-sm">{result.hits.length} results shown{result.nextCursor ? "; more available" : "; end of results"}</p><ul className="mt-3 space-y-4">{result.hits.map(hit => <li key={hit.itemId} className="rounded-xl border p-4"><button className="text-left font-semibold underline" disabled={busy} onClick={() => void open(hit.itemId)}>{hit.title || hit.url || "Saved page"}</button><p className="mt-2 whitespace-pre-wrap text-sm">{hit.snippet}</p>{hit.url && <a href={hit.url} target="_blank" rel="noreferrer" className="text-xs underline">Open original website</a>}{Boolean(hit.gaps.length) && <p className="mt-3 text-xs">Capture gaps: {hit.gaps.join(" ")}</p>}</li>)}</ul>{result.nextCursor && <button className={`${button} mt-4`} disabled={busy} onClick={() => void more()}>Show more results</button>}</section>}
    {reader && <section className="mt-7 rounded-xl border p-5" aria-label="Saved source reader"><div className="flex justify-between"><h2 className="text-lg font-semibold">{reader.title}</h2><button onClick={() => setReader(null)}>Close</button></div>{reader.parts.length > 1 && <select className="mt-3 rounded border p-2" value={reader.partId ?? ""} disabled={busy} onChange={event => void open(reader.itemId, event.target.value)}>{reader.parts.map(part => <option key={part.partId} value={part.partId}>{part.label} ({part.kind})</option>)}</select>}<p className="mt-2 text-xs">Coverage: {reader.coverage}. {reader.gaps.join(" ")}</p><div className="mt-3 flex flex-wrap gap-2">{reader.originals.map(original => <button key={original.mediaId} className={button} disabled={busy || !original.local} onClick={() => void downloadOriginal(reader.itemId, original.mediaId)}>{original.local ? "Download original: " : "Remote original: "}{original.fileName}</button>)}</div><pre className="mt-4 whitespace-pre-wrap font-sans text-sm">{reader.text || "No source text is available."}</pre>{reader.nextCursor !== null && <button className={`${button} mt-4`} disabled={busy} onClick={() => void readMore()}>Read next section</button>}{reader.partsTruncated && <p className="mt-2 text-xs">More source parts are available in the desktop app.</p>}</section>}
    {Boolean(status?.pending.length) && <section className="mt-8" aria-label="Pending local saves"><h2 className="text-lg font-semibold">{status?.pending.length} captures in the browser queue</h2><p className="mt-2 text-sm">Retries use the original snapshot and ID. Inspect or export a capture before dismissing it to free queue capacity.</p><ul className="mt-3 space-y-3">{status?.pending.map(job => <li key={job.id} className="rounded-lg border p-3"><p className="font-medium">{job.title || job.url}</p><p className="mt-1 text-sm">{job.state === "blocked" ? `Needs attention: ${job.lastError}. No automatic retry.` : "Waiting for the companion."}</p><div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(async () => setSnapshot(await localClient.inspect(job.id)))}>Inspect</button><button className={button} disabled={busy} onClick={() => void run(async () => downloadJson(await localClient.inspect(job.id)))}>Export snapshot</button>{job.originalCount > 0 && <button className={button} disabled={busy} onClick={() => void downloadOriginal(job.id, "screenshot", true)}>Export original image</button>}<button className={button} disabled={busy} onClick={() => void run(async () => setStatus(await localClient.repair(job.id)))}>Retry this capture</button><button className={button} disabled={busy} onClick={() => setConfirmDismiss(job.id)}>Dismiss...</button></div>{confirmDismiss === job.id && <div className="mt-3"><p>Remove this preserved capture from the browser queue? Export it first if you need to keep it.</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => { setStatus(await localClient.dismiss(job.id)); setConfirmDismiss(null); })}>Confirm dismissal</button><button className={`${button} ml-2`} onClick={() => setConfirmDismiss(null)}>Keep capture</button></div>}</li>)}</ul></section>}
    {snapshot && <section className="mt-6 rounded border p-4" aria-label="Queued capture"><button onClick={() => setSnapshot(null)}>Close snapshot</button><h2 className="mt-2 font-semibold">{snapshot.title}</h2><p className="text-xs">ID: {snapshot.id}. {snapshot.gaps.join(" ")}</p><pre className="mt-3 whitespace-pre-wrap font-sans text-sm">{snapshot.text}</pre></section>}
  </main>;
}
function LegacyImportControls({ busy, run }: { busy: boolean; run: (action: () => Promise<void>) => Promise<void> }) {
  const [progress, setProgress] = useState("");
  return <div className="mt-4"><p className="text-sm">Import unlocked, non-deleted items and their local originals into the desktop library. Original browser records remain intact. Private or locked content stays in the old library.</p><button className={`${button} mt-2`} disabled={busy} onClick={() => void run(async () => { const result = await localClient.importLegacy(); setProgress(`${result.imported} imported; ${result.skipped} private or locked skipped. ${result.done ? "Import complete." : "Saved checkpoint. Choose Resume import to continue."}`); })}>{progress ? "Resume import" : "Import old browser library"}</button><p role="status" className="mt-2 text-sm">{progress}</p></div>;
}
