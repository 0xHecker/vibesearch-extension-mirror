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

type CreateSpaceDialogProps = {
  open: boolean;
  loading: boolean;
  name: string;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onNameChange: (name: string) => void;
  onReset: () => void;
  onSubmit: () => Promise<void>;
};

export function CreateSpaceDialog({
  open,
  loading,
  name,
  error,
  onOpenChange,
  onNameChange,
  onReset,
  onSubmit,
}: CreateSpaceDialogProps) {
  const handleOpenChange = (nextOpen: boolean): void => {
    if (loading) return;
    onOpenChange(nextOpen);
    if (!nextOpen) onReset();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a new space</DialogTitle>
          <DialogDescription>
            Spaces keep your folders separate without adding search clutter.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Space name"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void onSubmit();
            }}
          />
          {error && <p className="text-xs text-foreground-danger">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void onSubmit()}
            disabled={loading}
          >
            {loading ? "Creating..." : "Create space"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
