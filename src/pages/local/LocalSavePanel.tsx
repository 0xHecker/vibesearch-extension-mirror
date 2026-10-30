import { useState } from "react";
import { describeLocalError, localClient, type LocalSaveOutcome } from "@src/services/local-companion-client";
import { LOCAL_LIBRARY_PATH } from "@src/services/local-companion-protocol";

export default function LocalSavePanel() {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LocalSaveOutcome | null>(null);
  const [error, setError] = useState("");
  const save = async (mode: "text" | "visible" | "region" = "text") => {
    setBusy(true); setError(""); setOutcome(null);
    try {
      // Keep the permission request in the click handler's user gesture.
      const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      if (!granted) { setError("Local companion permission was not enabled."); return; }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error("LOCAL_PAGE_UNAVAILABLE");
      setOutcome(await (mode === "text" ? localClient.saveTab(tab.id) : localClient.screenshot(tab.id, mode)));
    } catch (caught) { setError(describeLocalError(caught)); }
    finally { setBusy(false); }
  };
  return <section className="mb-3 rounded-xl border border-border-neutral-faded bg-background-neutral p-3 text-sm text-foreground-neutral" aria-label="Local companion">
    <p className="font-semibold">Local companion</p>
    <p className="mt-1 text-xs text-foreground-secondary">Save page text on this computer. No account is needed.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => void save("text")} className="rounded-lg bg-foreground-neutral px-3 py-2 text-xs text-background-neutral disabled:opacity-50">{busy ? "Saving locally..." : "Save page locally"}</button>
      <button type="button" disabled={busy} onClick={() => void save("visible")} className="rounded-lg border border-border-neutral-faded px-3 py-2 text-xs">Screenshot</button>
      <button type="button" disabled={busy} onClick={() => void save("region")} className="rounded-lg border border-border-neutral-faded px-3 py-2 text-xs">Select region</button>
      <button type="button" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(LOCAL_LIBRARY_PATH) })} className="rounded-lg border border-border-neutral-faded px-3 py-2 text-xs">Open local library</button>
    </div>
    <p role="status" aria-live="polite" className="mt-2 text-xs">
      {outcome?.state === "saved" && "Saved locally. Available in local search."}
      {outcome?.state === "pending" && "Pending companion. This capture is stored in the browser and will retry."}
      {outcome?.state === "blocked" && `This capture needs attention (${outcome.error}). It remains in the local queue.`}
      {error}
    </p>
    {outcome && <p className="mt-1 text-xs text-foreground-secondary">{outcome.gaps.join(" ")}</p>}
    {(outcome?.state === "pending" || outcome?.state === "blocked") && <p className="mt-2 text-xs">Open the local library for companion setup and pending saves.</p>}
  </section>;
}
