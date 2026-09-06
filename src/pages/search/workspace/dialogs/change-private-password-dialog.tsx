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

type ChangePrivatePasswordDialogProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  currentPassword: string;
  nextPassword: string;
  confirmPassword: string;
  onOpenChange: (open: boolean) => void;
  onCurrentPasswordChange: (value: string) => void;
  onNextPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onReset: () => void;
  onSubmit: () => Promise<void>;
};

export function ChangePrivatePasswordDialog({
  open,
  loading,
  error,
  currentPassword,
  nextPassword,
  confirmPassword,
  onOpenChange,
  onCurrentPasswordChange,
  onNextPasswordChange,
  onConfirmPasswordChange,
  onReset,
  onSubmit,
}: ChangePrivatePasswordDialogProps) {
  const handleOpenChange = (nextOpen: boolean): void => {
    if (loading) return;
    onOpenChange(nextOpen);
    if (!nextOpen) onReset();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change private password</DialogTitle>
          <DialogDescription>
            Update your private space password. Recovery questions stay
            unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <PasswordInput
            value={currentPassword}
            placeholder="Current password"
            autoFocus
            onChange={onCurrentPasswordChange}
            onSubmit={onSubmit}
          />
          <PasswordInput
            value={nextPassword}
            placeholder="New password"
            onChange={onNextPasswordChange}
            onSubmit={onSubmit}
          />
          <PasswordInput
            value={confirmPassword}
            placeholder="Confirm new password"
            onChange={onConfirmPasswordChange}
            onSubmit={onSubmit}
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
            {loading ? "Updating..." : "Update password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasswordInput({
  value,
  placeholder,
  autoFocus = false,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <Input
      type="password"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onKeyDown={(event) => {
        if (event.key === "Enter") void onSubmit();
      }}
    />
  );
}
