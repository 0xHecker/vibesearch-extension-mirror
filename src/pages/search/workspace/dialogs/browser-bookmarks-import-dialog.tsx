import { Button } from "@src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@src/components/ui/dialog";

type BrowserBookmarksImportDialogProps = {
  open: boolean;
  importing: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onClearError: () => void;
  onImport: () => Promise<void>;
};

export function BrowserBookmarksImportDialog({
  open,
  importing,
  error,
  onOpenChange,
  onClearError,
  onImport,
}: BrowserBookmarksImportDialogProps) {
  const handleOpenChange = (nextOpen: boolean): void => {
    if (importing) return;
    onOpenChange(nextOpen);
    if (!nextOpen) onClearError();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-balance">
            Import browser bookmarks
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Top-level bookmark folders become separate spaces under{" "}
            <strong>Browser Bookmarks</strong>. Large folders split at 500
            bookmarks so browsing stays responsive.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1 text-sm text-foreground-secondary">
          <p>
            Re-running the import updates the same browser bookmarks instead of
            creating duplicates.
          </p>
          <p>
            Metadata is queued in the background after import; semantic
            embeddings wait until fetched metadata changes searchable text.
          </p>
          {error && <p className="text-xs text-foreground-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
            className="h-10"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onImport()}
            disabled={importing}
            className="h-10"
            static={importing}
          >
            {importing ? "Importing..." : "Import bookmarks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
