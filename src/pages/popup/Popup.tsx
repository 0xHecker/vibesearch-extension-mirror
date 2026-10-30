import * as React from "react";
import LocalSavePanel from "@src/pages/local/LocalSavePanel";
import { readExtensionPolicy, type ExtensionPolicy } from "@src/services/extension-policy";
import { LOCAL_LIBRARY_PATH } from "@src/services/local-companion-protocol";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@src/components/ui/button";
import { Input } from "@src/components/ui/input";
import { Checkbox } from "@src/components/ui/checkbox";
import { ArrowRight, Archive, Bookmark, Globe, Camera, Crop, FileText, Zap } from "lucide-react";
import { 
  SiInstagram, 
  SiX, 
  SiYoutube, 
  SiReddit, 
  SiGithub, 
  SiTiktok, 
  SiMedium, 
  SiSubstack 
} from "react-icons/si";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@src/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@src/components/ui/select";
import type { ItemDocType } from "@src/schemas/item_schema";
import { inferSource } from "@src/utils/infer-source";
import type { FolderDocType } from "@src/schemas/folder_schema";
import { DEFAULT_IMPORT_SETTINGS, type ImportSettings } from "@src/common/import-settings";

type TabSaveScope =
  | "current_window"
  | "except_current"
  | "left_of_current"
  | "right_of_current"
  | "all_windows";

type ImportDraftSummary = {
  id: string;
  mode: "save" | "shot";
  title: string;
  host: string;
  createdAt: number;
};

type ImportTargetItem = {
  id: string;
  title: string;
  updatedAt: number;
};

type ImportTargetFolder = {
  id: string;
  name: string;
  recentItems: ImportTargetItem[];
};

type ImportTargetSpace = {
  id: string;
  name: string;
  isPrivate: boolean;
  isUnlocked: boolean;
  folders: ImportTargetFolder[];
};

type ImportDraft = {
  id: string;
  mode: "save" | "shot";
  createdAt: number;
  updatedAt: number;
  primaryUrl: string;
  title: string;
  textContent: string;
  source: ItemDocType["source"];
  tags: string[];
  iconUrl?: string;
  displayImageUrl?: string;
  media?: ItemDocType["media"];
  shouldFetchMetadata?: boolean;
  isMetaFetched?: boolean;
  target: {
    spaceId: string;
    folderId?: string;
    parentId?: string | null;
    newFolderName?: string;
  };
};

type ImportGetDraftPayload = {
  draft: ImportDraft | null;
  settings: ImportSettings;
  targets: ImportTargetSpace[];
};

type RuntimeResponse<T> = {
  success?: boolean;
  payload?: T;
  error?: string;
};
type ProcessStatusState = "processing" | "success" | "error";
type ProcessStatusItem = {
  id: string;
  label: string;
  state: ProcessStatusState;
  detail: string;
  retryAction?: string;
  updatedAt: number;
};

const PROCESS_STATUS_SUCCESS_TTL_MS = 15 * 60 * 1000;
const PROCESS_STATUS_PROCESSING_TTL_MS = 45 * 60 * 1000;
const PROCESS_STATUS_PRUNE_INTERVAL_MS = 60 * 1000;

const SOURCE_OPTIONS: ItemDocType["source"][] = [
  "web",
  "twitter",
  "reddit",
  "note",
  "youtube",
  "instagram",
  "tiktok",
  "substack",
  "linkedin",
  "github",
  "article",
];

const trimText = (value: string, max = 80) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trim()}...`;

const formatDraftTime = (value: number): string => {
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

const getSourceIcon = (source: ItemDocType["source"]) => {
  const iconProps = { className: "size-3.5 shrink-0" };
  switch (source) {
    case "instagram": return <SiInstagram {...iconProps} />;
    case "twitter": return <SiX {...iconProps} />;
    case "youtube": return <SiYoutube {...iconProps} />;
    case "reddit": return <SiReddit {...iconProps} />;
    case "github": return <SiGithub {...iconProps} />;
    case "tiktok": return <SiTiktok {...iconProps} />;
    case "article": return <SiMedium {...iconProps} />;
    case "substack": return <SiSubstack {...iconProps} />;
    default: return <Globe {...iconProps} />;
  }
};

const parseTagsInput = (value: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[\n,]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
};
const formatProcessTime = (value: number): string => {
  const date = new Date(value || Date.now());
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};
const normalizeProcessState = (value: unknown): ProcessStatusState => {
  if (value === "error") return "error";
  if (value === "success") return "success";
  return "processing";
};
const normalizeProcessStatusPayload = (payload: unknown): ProcessStatusItem | null => {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<ProcessStatusItem>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  return {
    id: row.id,
    label: typeof row.label === "string" && row.label.trim() ? row.label : "Background",
    state: normalizeProcessState(row.state),
    detail: typeof row.detail === "string" ? row.detail : "",
    retryAction: typeof row.retryAction === "string" ? row.retryAction : undefined,
    updatedAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
  };
};
const isProcessStatusFresh = (row: ProcessStatusItem, now = Date.now()): boolean => {
  if (row.state === "success") return now - row.updatedAt <= PROCESS_STATUS_SUCCESS_TTL_MS;
  if (row.state === "processing") return now - row.updatedAt <= PROCESS_STATUS_PROCESSING_TTL_MS;
  return true;
};
const upsertProcessStatusList = (list: ProcessStatusItem[], next: ProcessStatusItem, max = 8): ProcessStatusItem[] => {
  const map = new Map<string, ProcessStatusItem>(list.map((entry) => [entry.id, entry]));
  map.set(next.id, next);
  const now = Date.now();
  return [...map.values()]
    .filter((entry) => isProcessStatusFresh(entry, now))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, max);
};

const resolveDraftPreviewImages = (draft: ImportDraft | null): string[] => {
  if (!draft) return [];
  const candidates = [
    draft.displayImageUrl || "",
    ...(draft.media || [])
      .filter((entry) => entry.type === "image")
      .map((entry) => entry.s3Url || entry.originalUrl || ""),
  ];
  const unique = new Set<string>();
  const output: string[] = [];
  for (const src of candidates) {
    const normalized = (src || "").trim();
    if (!normalized) continue;
    if (unique.has(normalized)) continue;
    unique.add(normalized);
    output.push(normalized);
  }
  return output;
};

const mapChecked = (value: boolean | "indeterminate"): boolean => value === true;

const isSaveableBrowserTab = (tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { url: string } =>
  typeof tab.url === "string" &&
  tab.url.length > 0 &&
  !tab.url.startsWith("chrome://") &&
  !tab.url.startsWith("chrome-extension://");

const closeSavedBrowserTabs = async (tabs: chrome.tabs.Tab[]): Promise<number> => {
  const tabIds = tabs
    .filter(isSaveableBrowserTab)
    .map((tab) => tab.id)
    .filter((tabId): tabId is number => typeof tabId === "number");

  const results = await Promise.allSettled(tabIds.map((tabId) => chrome.tabs.remove(tabId)));
  return results.filter((result) => result.status === "fulfilled").length;
};

const useBackground = () => {
  const call = React.useCallback(async <T,>(type: string, payload?: unknown): Promise<T> => {
    const response = (await chrome.runtime.sendMessage({
      target: "background",
      type,
      payload,
    })) as RuntimeResponse<T>;

    if (!response?.success) {
      throw new Error(response?.error || `${type} failed`);
    }

    return response.payload as T;
  }, []);

  return { call };
};

const useProcessStatusFeed = (call: <T>(type: string, payload?: unknown) => Promise<T>) => {
  const [statuses, setStatuses] = React.useState<ProcessStatusItem[]>([]);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const rows = await call<ProcessStatusItem[]>("IMPORT_GET_PROCESS_STATUSES", { max: 8 });
        if (!active) return;
        const normalized = Array.isArray(rows)
          ? rows
              .map((row) => normalizeProcessStatusPayload(row))
              .filter((row): row is ProcessStatusItem => !!row)
              .filter((row) => isProcessStatusFresh(row))
              .slice(0, 8)
          : [];
        setStatuses(normalized);
      } catch {}
    })();

    const listener = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const row = message as { type?: string; payload?: unknown };
      if (row.type !== "PROCESS_STATUS") return;
      const normalized = normalizeProcessStatusPayload(row.payload);
      if (!normalized) return;
      setStatuses((current) => upsertProcessStatusList(current, normalized, 8));
    };
    chrome.runtime.onMessage.addListener(listener);
    const pruneTimer = window.setInterval(() => {
      setStatuses((current) => current.filter((row) => isProcessStatusFresh(row)));
    }, PROCESS_STATUS_PRUNE_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(pruneTimer);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [call]);

  return statuses;
};

const ProcessStatusPanel = ({ statuses }: { statuses: ProcessStatusItem[] }) => {
  return (
    <div className="rounded-xl bg-background-neutral-faded px-3 py-2.5 space-y-2">
      <div className="text-xs font-medium text-foreground-neutral">Processing (dev)</div>
      {statuses.length === 0 ? (
        <div className="text-[11px] text-foreground-tertiary">No recent background activity.</div>
      ) : (
        <div className="max-h-44 overflow-auto space-y-1">
          {statuses.map((status) => (
            <div key={status.id} className="rounded-md border border-border-neutral-faded px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-foreground-neutral truncate">{status.label}</span>
                <span
                  className={
                    status.state === "error"
                      ? "text-[10px] text-red-500"
                      : status.state === "success"
                        ? "text-[10px] text-green-500"
                        : "text-[10px] text-amber-500"
                  }
                >
                  {status.state}
                </span>
              </div>
              <div className="text-[11px] text-foreground-secondary break-words">{status.detail || "..."}</div>
              <div className="text-[10px] text-foreground-tertiary">{formatProcessTime(status.updatedAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const ImportEditor = ({ requestedDraftId }: { requestedDraftId: string | null }) => {
  const { call } = useBackground();
  const processStatuses = useProcessStatusFeed(call);

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<ImportDraftSummary[]>([]);
  const [selectedDraftId, setSelectedDraftId] = React.useState<string>(requestedDraftId || "");

  const [draft, setDraft] = React.useState<ImportDraft | null>(null);
  const [targets, setTargets] = React.useState<ImportTargetSpace[]>([]);

  const [title, setTitle] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [textContent, setTextContent] = React.useState("");
  const [source, setSource] = React.useState<ItemDocType["source"]>("web");
  const [tagsInput, setTagsInput] = React.useState("");
  const [spaceId, setSpaceId] = React.useState("");
  const [folderId, setFolderId] = React.useState("__new__");
  const [createFolderName, setCreateFolderName] = React.useState("");
  const [parentId, setParentId] = React.useState("");

  const selectedSpace = React.useMemo(
    () => targets.find((space) => space.id === spaceId) || null,
    [spaceId, targets]
  );

  const selectedFolder = React.useMemo(
    () => selectedSpace?.folders.find((folder) => folder.id === folderId) || null,
    [folderId, selectedSpace]
  );
  const previewImages = React.useMemo(() => resolveDraftPreviewImages(draft), [draft]);

  const loadDrafts = React.useCallback(async () => {
    const rows = await call<ImportDraftSummary[]>("IMPORT_LIST_DRAFTS");
    setDrafts(rows || []);
    return rows || [];
  }, [call]);

  const hydrateFromDraft = React.useCallback((nextDraft: ImportDraft | null, nextTargets: ImportTargetSpace[]) => {
    setDraft(nextDraft);
    setTargets(nextTargets);

    if (!nextDraft) {
      setTitle("");
      setUrl("");
      setTextContent("");
      setSource("web");
      setTagsInput("");
      setSpaceId("");
      setFolderId("__new__");
      setCreateFolderName("");
      setParentId("");
      return;
    }

    setTitle(nextDraft.title || "");
    setUrl(nextDraft.primaryUrl || "");
    setTextContent(nextDraft.textContent || "");
    setSource(nextDraft.source || "web");
    setTagsInput((nextDraft.tags || []).join(", "));

    const draftSpaceId = nextDraft.target.spaceId || nextTargets[0]?.id || "";
    const draftFolderId = nextDraft.target.folderId || "__new__";
    setSpaceId(draftSpaceId);
    setFolderId(draftFolderId);
    setCreateFolderName(nextDraft.target.newFolderName || "");
    setParentId((nextDraft.target.parentId || "") as string);
  }, []);

  const loadDraft = React.useCallback(
    async (targetDraftId?: string) => {
      setLoading(true);
      setStatus(null);
      try {
        const payload = await call<ImportGetDraftPayload>("IMPORT_GET_DRAFT", {
          draftId: targetDraftId,
        });
        hydrateFromDraft(payload.draft, payload.targets || []);
        if (payload.draft?.id) {
          setSelectedDraftId(payload.draft.id);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Failed to load import draft.");
      } finally {
        setLoading(false);
      }
    },
    [call, hydrateFromDraft]
  );

  React.useEffect(() => {
    void (async () => {
      await loadDrafts();
      await loadDraft(requestedDraftId || undefined);
    })();
  }, [loadDraft, loadDrafts, requestedDraftId]);

  React.useEffect(() => {
    if (!selectedSpace) return;
    if (folderId === "__new__") return;
    if (!selectedSpace.folders.some((folder) => folder.id === folderId)) {
      setFolderId("__new__");
      setParentId("");
    }
  }, [folderId, selectedSpace]);

  const openSearchPage = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/pages/search/index.html"),
    });
  };

  const submitDraft = async () => {
    if (!draft) return;
    if (!title.trim()) {
      setStatus("Title is required.");
      return;
    }
    if (!url.trim()) {
      setStatus("URL is required.");
      return;
    }
    if (!spaceId) {
      setStatus("Select a space.");
      return;
    }
    if (folderId === "__new__" && !createFolderName.trim()) {
      setStatus("Provide a folder name for the new folder.");
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      await call<ItemDocType>("IMPORT_SUBMIT_DRAFT", {
        draftId: draft.id,
        title,
        url,
        textContent,
        source,
        tags: parseTagsInput(tagsInput),
        spaceId,
        folderId,
        parentId: folderId !== "__new__" ? parentId || null : null,
        createFolderName: createFolderName.trim(),
        iconUrl: draft.iconUrl,
        displayImageUrl: draft.displayImageUrl,
      });

      const updatedList = await loadDrafts();
      const nextId = updatedList[0]?.id || "";
      if (!nextId) {
        setDraft(null);
        setStatus("Imported. No pending drafts.");
      } else {
        await loadDraft(nextId);
        setStatus("Imported draft successfully.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to import draft.");
    } finally {
      setSaving(false);
    }
  };

  const discardDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      await call("IMPORT_DELETE_DRAFT", { draftId: draft.id });
      const updatedList = await loadDrafts();
      const nextId = updatedList[0]?.id || "";
      if (!nextId) {
        setDraft(null);
        setStatus("Draft deleted.");
      } else {
        await loadDraft(nextId);
        setStatus("Draft deleted.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to delete draft.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-3 w-[460px]">
      <Card>
        <CardHeader>
          <CardTitle>Review Import Draft</CardTitle>
          <CardDescription>
            Edit metadata, tags, and destination before saving imported content.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="text-xs text-foreground-secondary">Loading draft...</div>
          ) : !draft ? (
            <div className="space-y-2">
              <div className="text-sm text-foreground-secondary">No pending import drafts.</div>
              <Button variant="secondary" onClick={openSearchPage}>
                Open Search
              </Button>
            </div>
          ) : (
            <>
              {drafts.length > 1 && (
                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">Draft queue</label>
                  <Select
                    value={selectedDraftId || draft.id}
                    onValueChange={(value) => {
                      setSelectedDraftId(value);
                      void loadDraft(value);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select draft" />
                    </SelectTrigger>
                    <SelectContent>
                      {drafts.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {trimText(`${row.mode === "shot" ? "Screenshot" : "Import"} · ${row.title} · ${row.host}`, 80)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-foreground-tertiary">Created {formatDraftTime(draft.createdAt)}</p>
                </div>
              )}

              {/* Preview card with thumbnail and source */}
              {(draft.displayImageUrl || draft.source !== "web") && (
                <div className="flex items-start gap-3 rounded-md border border-border-neutral-faded bg-background-neutral-faded p-2.5">
                  {draft.displayImageUrl && (
                    <img 
                      src={draft.displayImageUrl} 
                      alt="" 
                      className="size-16 shrink-0 rounded object-cover"
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      {getSourceIcon(draft.source)}
                      <span className="text-xs font-medium capitalize text-foreground-secondary">
                        {draft.source === "twitter" ? "X" : draft.source}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-foreground-neutral">
                      {draft.title || "Untitled"}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs text-foreground-secondary">Title</label>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-foreground-secondary">URL</label>
                <Input value={url} onChange={(event) => setUrl(event.target.value)} />
                {draft.mode === "save" && (
                  <p className="text-[11px] text-foreground-tertiary">
                    Changing URL may clear attached media on save if it no longer matches the original draft.
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs text-foreground-secondary">Source</label>
                <Select value={source} onValueChange={(value) => setSource(value as ItemDocType["source"])}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-foreground-secondary">Tags (comma/newline separated)</label>
                <textarea
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  className="w-full min-h-[56px] rounded-md border border-border-neutral-faded bg-background-neutral px-2 py-1 text-xs"
                  placeholder="research, screenshots, twitter"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-foreground-secondary">Notes / Metadata</label>
                <textarea
                  value={textContent}
                  onChange={(event) => setTextContent(event.target.value)}
                  className="w-full min-h-[120px] rounded-md border border-border-neutral-faded bg-background-neutral px-2 py-1 text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">Space</label>
                  <Select
                    value={spaceId}
                    onValueChange={(value) => {
                      setSpaceId(value);
                      setFolderId("__new__");
                      setParentId("");
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select space" />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((space) => (
                        <SelectItem key={space.id} value={space.id} disabled={!space.isUnlocked}>
                          {space.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">Folder</label>
                  <Select
                    value={folderId}
                    onValueChange={(value) => {
                      setFolderId(value);
                      setParentId("");
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select folder" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__new__">Create new folder</SelectItem>
                      {(selectedSpace?.folders || []).map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {folderId === "__new__" && (
                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">New folder name</label>
                  <Input
                    value={createFolderName}
                    onChange={(event) => setCreateFolderName(event.target.value)}
                    placeholder="Imports · example.com"
                  />
                </div>
              )}

              {folderId !== "__new__" && selectedFolder && (
                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">Attach under item (optional)</label>
                  <Select value={parentId || "__none__"} onValueChange={(value) => setParentId(value === "__none__" ? "" : value)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No parent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No parent</SelectItem>
                      {selectedFolder.recentItems.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {previewImages.length > 0 && (
                <div className="space-y-1">
                  <label className="text-xs text-foreground-secondary">
                    Preview {previewImages.length > 1 ? `(${previewImages.length} images)` : ""}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {previewImages.map((src, index) => (
                      <img
                        key={`${src}-${index}`}
                        src={src}
                        alt={`Import preview ${index + 1}`}
                        className="h-20 w-full rounded-md border border-border-neutral-faded object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {status && <div className="text-xs text-foreground-secondary">{status}</div>}
          <ProcessStatusPanel statuses={processStatuses} />
        </CardContent>

        <CardFooter className="gap-2">
          <Button variant="secondary" onClick={openSearchPage}>
            Open Search
          </Button>

          {draft && (
            <>
              <Button variant="outline" onClick={() => void discardDraft()} disabled={saving}>
                Discard
              </Button>
              <Button onClick={() => void submitDraft()} disabled={saving}>
                {saving ? "Saving..." : "Save Import"}
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  );
};

const SaveTabsPopup = () => {
  const { call } = useBackground();
  const processStatuses = useProcessStatusFeed(call);

  const [folderName, setFolderName] = React.useState("");
  const [scope, setScope] = React.useState<TabSaveScope>("current_window");
  const [isSaving, setIsSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [importSettings, setImportSettings] = React.useState<ImportSettings>(DEFAULT_IMPORT_SETTINGS);
  const [draftCount, setDraftCount] = React.useState(0);
  const [pastedUrl, setPastedUrl] = React.useState("");

  const openSearchPage = () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/pages/search/index.html"),
    });
  };

  const refreshImportMeta = React.useCallback(async () => {
    try {
      const [settings, drafts] = await Promise.all([
        call<ImportSettings>("IMPORT_GET_SETTINGS"),
        call<ImportDraftSummary[]>("IMPORT_LIST_DRAFTS"),
      ]);
      setImportSettings(settings);
      setDraftCount((drafts || []).length);
    } catch (error) {
      console.error("Failed to load import settings", error);
    }
  }, [call]);

  React.useEffect(() => {
    void refreshImportMeta();
  }, [refreshImportMeta]);

  const buildItemsFromTabs = (tabs: chrome.tabs.Tab[], folderId: string, spaceId: string) => {
    const now = Date.now();
    return tabs
      .filter(isSaveableBrowserTab)
      .map(
        (tab, index) =>
          ({
            id: uuidv4(),
            userId: "user1",
            title: tab.title || "No Title",
            textContent: "",
            url: tab.url!,
            iconUrl: tab.favIconUrl || "",
            source: inferSource(tab.url!),
            folderId,
            spaceId,
            isFavorite: false,
            parentId: null,
            isEmbedded: false,
            isMetaFetched: false,
            isDirty: true,
            serverVersion: 0,
            createdAt: now + index,
            updatedAt: now + index,
            vector_index: -1,
            deletedAt: 0,
          } as ItemDocType)
      );
  };

  const pickTabsByScope = async (): Promise<chrome.tabs.Tab[]> => {
    if (scope === "current_window") {
      return chrome.tabs.query({ currentWindow: true });
    }
    if (scope === "except_current") {
      return chrome.tabs.query({ currentWindow: true, active: false });
    }
    if (scope === "left_of_current" || scope === "right_of_current") {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const currentTab = tabs.find((tab) => tab.active);
      if (!currentTab) return [];
      return tabs.filter((tab) =>
        scope === "left_of_current" ? tab.index < currentTab.index : tab.index > currentTab.index
      );
    }
    return chrome.tabs.query({});
  };

  const createFolder = async (name: string): Promise<FolderDocType> => {
    const response = (await chrome.runtime.sendMessage({
      service: "folders",
      type: "create",
      target: "offscreen",
      payload: { name, userId: "user1" },
    })) as RuntimeResponse<FolderDocType>;

    if (!response?.success) {
      throw new Error(response?.error || "Failed to create folder");
    }

    return response.payload as FolderDocType;
  };

  const saveTabs = async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      const tabs = await pickTabsByScope();
      const name = folderName.trim() || `${tabs.length} tabs`;
      const folder = await createFolder(name);
      const items = buildItemsFromTabs(tabs, folder.id, folder.spaceId);
      if (items.length === 0) {
        setStatus("No tabs to save.");
        return;
      }

      const response = (await chrome.runtime.sendMessage({
        service: "items",
        type: "addMany",
        target: "offscreen",
        payload: { items },
      })) as RuntimeResponse<{ inserted: number }>;

      if (!response?.success) {
        throw new Error(response?.error || "Failed to save items");
      }

      const closedCount = importSettings.closeTabsAfterSave ? await closeSavedBrowserTabs(tabs) : 0;
      setStatus(
        importSettings.closeTabsAfterSave
          ? `Saved ${items.length} tabs to "${folder.name}" and closed ${closedCount}.`
          : `Saved ${items.length} tabs to "${folder.name}".`
      );
      setFolderName("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setIsSaving(false);
    }
  };

  const setReviewBeforeSave = async (next: boolean) => {
    const previous = importSettings.reviewBeforeSave;
    setImportSettings((current) => ({ ...current, reviewBeforeSave: next }));

    try {
      const saved = await call<ImportSettings>("IMPORT_SET_SETTINGS", {
        reviewBeforeSave: next,
      });
      setImportSettings(saved);
      setStatus(
        saved.reviewBeforeSave
          ? "Context import review is enabled."
          : "Context import review is disabled."
      );
    } catch (error) {
      setImportSettings((current) => ({ ...current, reviewBeforeSave: previous }));
      setStatus(error instanceof Error ? error.message : "Failed to update import setting.");
    }
  };

  const openImportEditor = async () => {
    try {
      await call("IMPORT_OPEN_EDITOR", {});
      window.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No pending drafts.");
    }
  };

  const quickSavePage = async () => {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "QUICK_SAVE_PAGE" });
    } catch {}
    window.close();
  };

  const quickScreenshot = async (mode: "visible" | "region") => {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "QUICK_SCREENSHOT", payload: { mode } });
    } catch {}
    window.close();
  };

  const quickExtract = async () => {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "QUICK_EXTRACT_PAGE" });
    } catch {}
    window.close();
  };

  const quickArchive = async () => {
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "QUICK_ARCHIVE_PAGE" });
    } catch {}
    window.close();
  };

  const savePastedUrl = async () => {
    const trimmed = pastedUrl.trim();
    if (!trimmed) return;
    try {
      await chrome.runtime.sendMessage({ target: "background", type: "SAVE_PASTED_URL", payload: { url: trimmed } });
    } catch {}
    window.close();
  };

  const quickActions: Array<{
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
  }> = [
    { label: "Quick save", icon: <Zap size={15} />, onClick: () => void quickSavePage() },
    { label: "Screenshot", icon: <Camera size={15} />, onClick: () => void quickScreenshot("visible") },
    { label: "Region", icon: <Crop size={15} />, onClick: () => void quickScreenshot("region") },
    { label: "Extract text", icon: <FileText size={15} />, onClick: () => void quickExtract() },
  ];

  return (
    <div className="w-[340px] bg-background-page p-3.5">
      <div className="mb-3 flex items-center justify-between px-0.5">
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-lg bg-foreground-neutral text-background-neutral">
            <Bookmark size={15} />
          </div>
          <span className="font-sans-bold text-sm tracking-[-0.01em] text-foreground-neutral">
            Vibe Search
          </span>
        </div>
        <button
          type="button"
          onClick={openSearchPage}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-foreground-secondary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral active:scale-[0.97]"
        >
          Open app
          <ArrowRight size={13} />
        </button>
      </div>

      <div className="rounded-2xl border border-border-neutral-faded bg-background-neutral p-4 shadow-[0_10px_40px_-14px_rgba(0,0,0,0.2)]">
        <h1 className="font-sans-bold text-lg tracking-[-0.01em] text-foreground-neutral">
          Save these tabs
        </h1>
        <p className="mt-0.5 text-sm leading-relaxed text-foreground-secondary">
          Group them into a folder you can search later.
        </p>

        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-tertiary">
              Folder name
            </label>
            <Input
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="e.g. Research – Local-first"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-tertiary">
              Which tabs
            </label>
            <Select value={scope} onValueChange={(value) => setScope(value as TabSaveScope)}>
              <SelectTrigger className="h-10 w-full rounded-lg border-border-neutral-faded bg-background-neutral-faded/60">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current_window">All tabs in window</SelectItem>
                <SelectItem value="except_current">All except current</SelectItem>
                <SelectItem value="left_of_current">Tabs to the left</SelectItem>
                <SelectItem value="right_of_current">Tabs to the right</SelectItem>
                <SelectItem value="all_windows">All tabs in all windows</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button
          className="mt-4 h-11 w-full rounded-lg text-sm active:scale-[0.98]"
          onClick={() => void saveTabs()}
          disabled={isSaving}
        >
          {isSaving ? "Saving…" : "Save tabs"}
        </Button>

        {status && <p className="mt-2 text-center text-xs text-foreground-secondary">{status}</p>}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-2 rounded-lg border border-border-neutral-faded bg-background-neutral px-3 py-2.5 text-xs font-medium text-foreground-secondary transition-colors hover:bg-background-neutral-faded hover:text-foreground-neutral active:scale-[0.98]"
          >
            <span className="text-foreground-tertiary">{action.icon}</span>
            {action.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => void quickArchive()}
        className="group mt-2 flex w-full items-center gap-3 rounded-lg border border-border-accent-faded bg-gradient-to-r from-accent-faded to-background-neutral px-3 py-2.5 text-left transition-all hover:border-border-accent hover:to-accent-faded active:scale-[0.98]"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-faded text-accent transition-transform group-hover:scale-105">
          <Archive size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-sans-bold tracking-[-0.01em] text-foreground-neutral">
            Archive this page
          </span>
          <span className="block text-[11px] text-foreground-secondary">
            Save a full, self-contained offline copy
          </span>
        </span>
        <ArrowRight
          size={15}
          className="shrink-0 text-foreground-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
        />
      </button>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="url"
          value={pastedUrl}
          onChange={(e) => setPastedUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void savePastedUrl();
          }}
          placeholder="Paste a link…"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border-neutral-faded bg-background-neutral px-3 text-xs text-foreground-neutral placeholder:text-foreground-tertiary focus:border-border-accent focus:outline-none focus:ring-1 focus:ring-border-accent"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-9 shrink-0 px-3 text-xs"
          onClick={() => void savePastedUrl()}
          disabled={!pastedUrl.trim()}
        >
          Save
        </Button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-background-neutral-faded px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground-neutral">Review before saving</p>
          <p className="text-[11px] text-foreground-secondary">
            {draftCount > 0
              ? `${draftCount} draft${draftCount === 1 ? "" : "s"} waiting`
              : "Edit metadata & tags on import"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {draftCount > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void openImportEditor()}
            >
              Review
            </Button>
          )}
          <Checkbox
            checked={importSettings.reviewBeforeSave}
            onCheckedChange={(checked) => void setReviewBeforeSave(mapChecked(checked))}
          />
        </div>
      </div>
    </div>
  );
};

const Popup = () => {
  const [policy, setPolicy] = React.useState<ExtensionPolicy | null>(null);
  React.useEffect(() => { void readExtensionPolicy().then(setPolicy); }, []);
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = params.get("mode");
  const draftId = params.get("draftId");

  if (!policy) {
    return <div className="w-[340px] bg-background-page p-4 text-sm text-foreground-secondary" role="status">Opening VibeSearch...</div>;
  }
  if (policy.mode === "local-only") {
    return <div className="w-[340px] bg-background-page p-4"><h1 className="mb-3 text-lg font-semibold text-foreground-neutral">VibeSearch</h1><LocalSavePanel /><p className="text-xs text-foreground-secondary">Local-only mode is selected. Your browser library and account are preserved. You can switch back in the local library.</p><button type="button" className="mt-3 text-sm underline" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(LOCAL_LIBRARY_PATH) })}>Search and manage local saves</button></div>;
  }
  if (mode === "import") {
    return <ImportEditor requestedDraftId={draftId} />;
  }

  return <><SaveTabsPopup /><div className="w-[340px] bg-background-page px-4 pb-3"><button type="button" className="text-xs text-foreground-secondary hover:text-foreground-neutral" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(LOCAL_LIBRARY_PATH) })}>Desktop companion</button></div></>;
};

export default Popup;
