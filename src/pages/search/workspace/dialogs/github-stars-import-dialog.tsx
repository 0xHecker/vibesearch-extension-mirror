import { Button } from "@src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@src/components/ui/dialog";
import { Input } from "@src/components/ui/input";

type GitHubStarsImportDialogProps = {
  open: boolean;
  importing: boolean;
  token: string;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onTokenChange: (token: string) => void;
  onReset: () => void;
  onImport: () => Promise<void>;
};

export function GitHubStarsImportDialog({
  open,
  importing,
  token,
  error,
  onOpenChange,
  onTokenChange,
  onReset,
  onImport,
}: GitHubStarsImportDialogProps) {
  const handleOpenChange = (nextOpen: boolean): void => {
    if (importing) return;
    onOpenChange(nextOpen);
    if (!nextOpen) onReset();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-balance">
            Import GitHub stars
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Uses GitHub&apos;s supported starred-repositories API. Your token is
            used for this sync only and is not stored.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder="GitHub token with Starring: read"
            disabled={importing}
          />
          {error && <p className="text-xs text-foreground-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onImport()}
            disabled={importing || !token.trim()}
            static={importing}
          >
            {importing ? "Syncing..." : "Import stars"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
