import * as React from "react";
import {
  AlertTriangle,
  Bookmark,
  CloudUpload,
  Download,
  FileUp,
  FileOutput,
  Link2,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { Button } from "@src/components/ui/button";
import { ConfirmDialog } from "@src/components/ui/confirm-dialog";
import { cn } from "@src/lib/utils";
import { showErrorToast, showLoadingToast, showSuccessToast } from "@src/utils/toast-feedback";
import { SectionHeading, SettingGroup, SettingRow, SettingStatus } from "../SettingsPrimitives";
import {
  buildBackupDownload,
  createDriveBackup,
  deleteAllLocalData,
  downloadStagedBackup,
  exportToNotion,
  formatMigrationSummary,
  listDriveBackups,
  rebuildVectorIndex,
  restoreDriveBackup,
  restoreStagedBundle,
  stageBackupFile,
  type GoogleDriveBackup,
  type LocalExtensionMigrationSummary,
} from "../backup-ops";

export interface DataSectionProps {
  onImportBrowserBookmarks: () => void;
  onImportGitHubStars: () => void;
  onImportSharedLink: () => void;
  onDataChanged: () => void;
}

export function DataSection({
  onImportBrowserBookmarks,
  onImportGitHubStars,
  onImportSharedLink,
  onDataChanged,
}: DataSectionProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [isExporting, setIsExporting] = React.useState(false);
  const [stagedRestoreId, setStagedRestoreId] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<LocalExtensionMigrationSummary | null>(null);
  const [isStaging, setIsStaging] = React.useState(false);
  const [isImporting, setIsImporting] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [driveBackups, setDriveBackups] = React.useState<GoogleDriveBackup[]>([]);
  const [isLoadingDrive, setIsLoadingDrive] = React.useState(false);
  const [isBackingUpDrive, setIsBackingUpDrive] = React.useState(false);
  const [isExportingNotion, setIsExportingNotion] = React.useState(false);
  const [importingDriveId, setImportingDriveId] = React.useState<string | null>(null);
  const [driveChecked, setDriveChecked] = React.useState(false);
  const [needsRebuild, setNeedsRebuild] = React.useState(false);
  const [isRebuilding, setIsRebuilding] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const isBusy =
    isExporting ||
    isStaging ||
    isImporting ||
    isLoadingDrive ||
    isBackingUpDrive ||
    isExportingNotion ||
    !!importingDriveId;

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);
    const toastId = showLoadingToast("Building backup…");
    try {
      const staged = await buildBackupDownload();
      await downloadStagedBackup(staged);
      setSummary(staged.summary);
      showSuccessToast("Backup file downloaded.", { id: toastId });
      if (staged.warnings.length > 0) setError(staged.warnings.join("\n"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not export local data.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setIsExporting(false);
    }
  };

  const stageFile = async (file: File) => {
    setError(null);
    setStagedRestoreId(null);
    setSummary(null);
    setIsStaging(true);
    try {
      const staged = await stageBackupFile(file);
      setStagedRestoreId(staged.stageId);
      setSummary(staged.summary);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "That file is not a VibeSearch backup export."
      );
    } finally {
      setIsStaging(false);
    }
  };

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void stageFile(file);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void stageFile(file);
  };

  const handleRestore = async () => {
    if (!stagedRestoreId) return;
    setError(null);
    setIsImporting(true);
    const toastId = showLoadingToast("Restoring backup — keep this tab open…");
    try {
      const restored = await restoreStagedBundle(stagedRestoreId);
      setStagedRestoreId(null);
      setNeedsRebuild(restored.scheduledReembeddingItemCount > 0);
      showSuccessToast(
        `Restored ${restored.collections.items.toLocaleString()} items into ${restored.collections.spaces.toLocaleString()} spaces.`,
        { id: toastId }
      );
      onDataChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not restore the backup.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setIsImporting(false);
    }
  };

  const handleFindDrive = async () => {
    setError(null);
    setIsLoadingDrive(true);
    try {
      setDriveBackups(await listDriveBackups());
      setDriveChecked(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not list Google Drive backups.");
    } finally {
      setIsLoadingDrive(false);
    }
  };

  const handleBackupDrive = async () => {
    setError(null);
    setIsBackingUpDrive(true);
    const toastId = showLoadingToast("Backing up to Google Drive…");
    try {
      const result = await createDriveBackup();
      if (result.driveFileId) {
        const savedBackup: GoogleDriveBackup = {
          id: result.driveFileId,
          name: "vibesearch-export.json",
          modifiedTime: new Date(result.lastSyncedAt || Date.now()).toISOString(),
        };
        setDriveBackups((current) => [
          savedBackup,
          ...current.filter((backup) => backup.id !== savedBackup.id),
        ]);
      }
      setDriveChecked(true);
      showSuccessToast("Drive backup saved.", { id: toastId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not back up to Google Drive.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setIsBackingUpDrive(false);
    }
  };

  const handleRestoreDrive = async (fileId: string) => {
    setError(null);
    setImportingDriveId(fileId);
    const toastId = showLoadingToast("Merging Drive backup — keep this tab open…");
    try {
      const restored = await restoreDriveBackup(fileId);
      setNeedsRebuild(restored.itemCount > 0);
      showSuccessToast(
        `Merged ${restored.itemCount.toLocaleString()} items into ${restored.spaceCount.toLocaleString()} spaces.`,
        { id: toastId }
      );
      onDataChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not restore the Drive backup.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setImportingDriveId(null);
    }
  };

  const handleExportNotion = async () => {
    setError(null);
    setIsExportingNotion(true);
    const toastId = showLoadingToast("Exporting to Notion — keep this tab open…");
    try {
      const result = await exportToNotion();
      showSuccessToast(`Exported ${result.itemCount.toLocaleString()} items to Notion.`, { id: toastId });
      if (result.pageUrl) await chrome.tabs.create({ url: result.pageUrl });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not export to Notion.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setIsExportingNotion(false);
    }
  };

  const handleRebuild = async () => {
    setError(null);
    setIsRebuilding(true);
    const toastId = showLoadingToast("Rebuilding semantic index…");
    try {
      await rebuildVectorIndex();
      setNeedsRebuild(false);
      showSuccessToast("Semantic index rebuilt.", { id: toastId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Vector indexing failed.";
      setError(message);
      showErrorToast(message, { id: toastId });
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleDeleteAll = async () => {
    const toastId = showLoadingToast("Deleting all data…");
    try {
      await deleteAllLocalData();
      setStagedRestoreId(null);
      setSummary(null);
      setNeedsRebuild(false);
      showSuccessToast("All local data deleted.", { id: toastId });
      onDataChanged();
    } catch (cause) {
      showErrorToast(cause instanceof Error ? cause.message : "Could not delete data.", { id: toastId });
    }
  };

  return (
    <div>
      <SectionHeading
        title="Data"
        description="Import from other tools, create a full local backup, or use an explicitly requested private Google Drive backup."
      />

      <SettingGroup label="Import">
        <SettingRow
          title="Browser bookmarks"
          description="Import your browser bookmarks and keep every folder as a tab group."
        >
          <Button type="button" variant="outline" size="sm" onClick={onImportBrowserBookmarks}>
            <Bookmark className="size-4" />
            Import
          </Button>
        </SettingRow>

        <SettingRow
          title="GitHub stars"
          description="Bring in your starred repositories as a browsable, searchable collection."
        >
          <Button type="button" variant="outline" size="sm" onClick={onImportGitHubStars}>
            <Star className="size-4" />
            Import
          </Button>
        </SettingRow>

        <SettingRow
          title="Shared link"
          description="Open a snapshot someone shared with you and merge it into a space."
        >
          <Button type="button" variant="outline" size="sm" onClick={onImportSharedLink}>
            <Link2 className="size-4" />
            Open link
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup label="Backup & restore">
        <SettingRow
          title="Back up to Google Drive"
          description="Create or update a private portable VibeSearch backup in your connected Drive account."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleBackupDrive()}
            disabled={isBusy}
            static={isBackingUpDrive}
          >
            {isBackingUpDrive ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
            Back up now
          </Button>
        </SettingRow>

        <SettingRow
          title="Export to Notion"
          description="Create a private Notion page with every current item, its link, space/folder, tags, favorite state, and a readable content excerpt."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExportNotion()}
            disabled={isBusy}
            static={isExportingNotion}
          >
            {isExportingNotion ? <Loader2 className="size-4 animate-spin" /> : <FileOutput className="size-4" />}
            Export
          </Button>
        </SettingRow>

        <SettingRow
          title="Restore from a backup file"
          description="Drop a VibeSearch JSON export below. Records merge by ID; keyword search is ready first."
          align="start"
        >
          {stagedRestoreId && (
            <Button type="button" size="sm" onClick={() => void handleRestore()} disabled={isBusy} static={isImporting}>
              {isImporting ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
              Restore now
            </Button>
          )}
        </SettingRow>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleFileInput}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          disabled={isBusy}
          className={cn(
            "mb-1 flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/80 disabled:opacity-60",
            isDragging
              ? "border-border-accent bg-accent-faded/40 text-foreground-neutral"
              : "border-border-neutral/60 bg-background-page-secondary/50 text-foreground-secondary hover:border-border-neutral hover:bg-background-page-secondary"
          )}
        >
          {isStaging ? (
            <Loader2 className="size-5 animate-spin text-foreground-tertiary" />
          ) : (
            <UploadCloud className="size-5 text-foreground-tertiary" />
          )}
          <span>
            {isStaging ? "Reading file…" : "Drag & drop a backup, or click to choose a file."}
          </span>
        </button>
        {summary && (
          <SettingStatus tone={stagedRestoreId ? "info" : "success"}>
            {stagedRestoreId ? "Ready to restore: " : "Last export: "}
            <span className="tabular-nums">{formatMigrationSummary(summary)}</span>
            {summary.warningCount > 0 ? ` · ${summary.warningCount} warning(s)` : ""}
          </SettingStatus>
        )}

        <SettingRow
          title="Export a full backup"
          description="Spaces, folders, tabs, tags, history, flashcards, local media, and offline page archives."
        >
          <Button type="button" variant="outline" size="sm" onClick={() => void handleExport()} disabled={isBusy} static={isExporting}>
            {isExporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Export
          </Button>
        </SettingRow>

        <SettingRow
          title="Restore from Google Drive"
          description="Merge a portable backup created by VibeSearch. Links and remote media restore; OPFS-only media needs a local backup."
          align="start"
        >
          <Button type="button" variant="outline" size="sm" onClick={() => void handleFindDrive()} disabled={isBusy} static={isLoadingDrive}>
            {isLoadingDrive ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Find backups
          </Button>
        </SettingRow>
        {driveBackups.length > 0 ? (
          <ul className="mb-1 divide-y divide-border-neutral-faded rounded-lg border border-border-neutral-faded">
            {driveBackups.map((backup) => (
              <li key={backup.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground-neutral">{backup.name}</span>
                  {backup.modifiedTime && (
                    <span className="tabular-nums text-xs text-foreground-tertiary">
                      {new Date(backup.modifiedTime).toLocaleString()}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleRestoreDrive(backup.id)}
                  disabled={isBusy}
                  static={importingDriveId === backup.id}
                >
                  {importingDriveId === backup.id && <Loader2 className="size-3.5 animate-spin" />}
                  Merge
                </Button>
              </li>
            ))}
          </ul>
        ) : driveChecked && !isLoadingDrive ? (
          <SettingStatus tone="info">No VibeSearch backups found in Google Drive.</SettingStatus>
        ) : null}

        {needsRebuild && (
          <div className="mb-1 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-background-page-secondary px-3 py-2.5 text-[13px] text-foreground-secondary">
            <span>Keyword search is ready. Rebuild the semantic index when you can spare some CPU.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void handleRebuild()} disabled={isRebuilding} static>
              {isRebuilding && <Loader2 className="size-3.5 animate-spin" />}
              Rebuild index
            </Button>
          </div>
        )}
      </SettingGroup>

      <SettingGroup label="Danger zone">
        <SettingRow
          title="Delete all data"
          description="Permanently remove every space, tab group, tab, tag, local media file, and offline archive from this device. This cannot be undone."
        >
          <Button type="button" variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </SettingRow>
      </SettingGroup>

      {error && (
        <pre className="mt-3 flex gap-2 whitespace-pre-wrap rounded-md bg-background-warning px-3 py-2 font-sans text-[13px] leading-relaxed text-foreground-warning" role="alert">
          <AlertTriangle className="size-4 shrink-0" />
          {error}
        </pre>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete all your data?"
        description="Every space, tab group, tab, tag, local media file, and offline archive on this device is permanently removed. Export a backup first if you might want it back. This cannot be undone."
        confirmLabel="Delete everything"
        variant="danger"
        onConfirm={handleDeleteAll}
      />
    </div>
  );
}
