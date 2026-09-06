import type { Dispatch, SetStateAction } from "react";

import type { BinEntry } from "@src/common/bin";
import { Button } from "@src/components/ui/button";
import { ConfirmDialog } from "@src/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@src/components/ui/dialog";
import { Input } from "@src/components/ui/input";

import { BinView } from "./BinView";
import type {
  DeleteBinEntryState,
  DeleteFolderState,
  DeleteSpaceGroupState,
  DeleteSpaceState,
  NewTabGroupTarget,
} from "./sidebar-types";

type SidebarDialogsProps = {
  binViewOpen: boolean;
  setBinViewOpen: Dispatch<SetStateAction<boolean>>;
  binEntries: BinEntry[];
  binTotal: number;
  binPage: number;
  binHasMore: boolean;
  binPageLoading: boolean;
  now: number;
  onNextBinPage: () => void;
  onPreviousBinPage: () => void;
  restoreBinEntry: (entry: BinEntry) => Promise<void>;
  setDeleteBinEntryState: Dispatch<SetStateAction<DeleteBinEntryState | null>>;
  deleteFolderState: DeleteFolderState | null;
  setDeleteFolderState: Dispatch<SetStateAction<DeleteFolderState | null>>;
  confirmDeleteFolder: () => Promise<void>;
  deleteSpaceState: DeleteSpaceState | null;
  setDeleteSpaceState: Dispatch<SetStateAction<DeleteSpaceState | null>>;
  confirmDeleteSpace: () => Promise<void>;
  deleteSpaceGroupState: DeleteSpaceGroupState | null;
  setDeleteSpaceGroupState: Dispatch<
    SetStateAction<DeleteSpaceGroupState | null>
  >;
  confirmDeleteSpaceGroup: () => Promise<void>;
  deleteBinEntryState: DeleteBinEntryState | null;
  confirmDeleteBinEntry: () => Promise<void>;
  newTabGroupTarget: NewTabGroupTarget | null;
  setNewTabGroupTarget: Dispatch<SetStateAction<NewTabGroupTarget | null>>;
  busy: boolean;
  submitNewTabGroup: () => Promise<void>;
};

export function SidebarDialogs({
  binViewOpen,
  setBinViewOpen,
  binEntries,
  binTotal,
  binPage,
  binHasMore,
  binPageLoading,
  now,
  onNextBinPage,
  onPreviousBinPage,
  restoreBinEntry,
  setDeleteBinEntryState,
  deleteFolderState,
  setDeleteFolderState,
  confirmDeleteFolder,
  deleteSpaceState,
  setDeleteSpaceState,
  confirmDeleteSpace,
  deleteSpaceGroupState,
  setDeleteSpaceGroupState,
  confirmDeleteSpaceGroup,
  deleteBinEntryState,
  confirmDeleteBinEntry,
  newTabGroupTarget,
  setNewTabGroupTarget,
  busy,
  submitNewTabGroup,
}: SidebarDialogsProps) {
  return (
    <>
      <BinView
        open={binViewOpen}
        onOpenChange={setBinViewOpen}
        entries={binEntries}
        total={binTotal}
        page={binPage}
        hasMore={binHasMore}
        loading={binPageLoading}
        now={now}
        onNextPage={onNextBinPage}
        onPreviousPage={onPreviousBinPage}
        onRestore={(entry) => void restoreBinEntry(entry)}
        onRequestDelete={(entry) => setDeleteBinEntryState({ entry })}
      />

      <ConfirmDialog
        open={Boolean(deleteFolderState)}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderState(null);
        }}
        title={
          deleteFolderState
            ? `Move "${deleteFolderState.folder.name}" to Bin?`
            : ""
        }
        description={getDeleteFolderDescription(deleteFolderState)}
        confirmLabel="Move to Bin"
        variant="danger"
        onConfirm={confirmDeleteFolder}
      />

      <ConfirmDialog
        open={Boolean(deleteSpaceState)}
        onOpenChange={(open) => {
          if (!open) setDeleteSpaceState(null);
        }}
        title={
          deleteSpaceState
            ? `Move "${deleteSpaceState.space.name}" to bin?`
            : ""
        }
        description="This moves the space to Bin with every tab group, folder, and saved item inside. It is removed from search and the sidebar now, recoverable for 30 days, then permanently deleted."
        confirmLabel="Move to Bin"
        variant="danger"
        onConfirm={confirmDeleteSpace}
      />

      <ConfirmDialog
        open={Boolean(deleteSpaceGroupState)}
        onOpenChange={(open) => {
          if (!open) setDeleteSpaceGroupState(null);
        }}
        title={
          deleteSpaceGroupState
            ? `Delete "${deleteSpaceGroupState.group.name}"?`
            : ""
        }
        description={getDeleteSpaceGroupDescription(deleteSpaceGroupState)}
        confirmLabel={getDeleteSpaceGroupLabel(deleteSpaceGroupState)}
        variant="danger"
        onConfirm={confirmDeleteSpaceGroup}
      />

      <ConfirmDialog
        open={Boolean(deleteBinEntryState)}
        onOpenChange={(open) => {
          if (!open) setDeleteBinEntryState(null);
        }}
        title={
          deleteBinEntryState
            ? `Permanently delete "${deleteBinEntryState.entry.name}"?`
            : ""
        }
        description={getPermanentDeleteDescription(deleteBinEntryState?.entry)}
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={confirmDeleteBinEntry}
      />

      <Dialog
        open={Boolean(newTabGroupTarget)}
        onOpenChange={(open) => {
          if (!open) setNewTabGroupTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New tab group</DialogTitle>
            <DialogDescription>
              {newTabGroupTarget?.parentId
                ? "Created inside the selected folder."
                : "Created in the active space at the root of the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={newTabGroupTarget?.name ?? ""}
            placeholder="e.g. Research – Local-first"
            onChange={(event) =>
              setNewTabGroupTarget((current) =>
                current ? { ...current, name: event.target.value } : null,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitNewTabGroup();
              }
              if (event.key === "Escape") setNewTabGroupTarget(null);
            }}
          />
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setNewTabGroupTarget(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitNewTabGroup()}
              disabled={busy || !newTabGroupTarget?.name.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function getDeleteFolderDescription(state: DeleteFolderState | null): string {
  if (!state || state.itemCount === null) return "Counting items…";
  if (!state.alsoDeleteItems) {
    return 'This moves the tab group and every nested tab group or folder inside it to Bin. Saved tabs inside stay searchable under "All tab groups."';
  }

  const tabLabel = state.itemCount === 1 ? "saved tab" : "saved tabs";
  return `This moves the tab group and every nested tab group or folder inside it to Bin. ${state.itemCount} ${tabLabel} inside will be removed from search and can be recovered from Bin.`;
}

function getDeleteSpaceGroupDescription(
  state: DeleteSpaceGroupState | null,
): string {
  if (state?.mode === "deleteContents") {
    return "This moves every space in the group to Bin, including all tab groups, folders, and saved items inside. Spaces are recoverable for 30 days, then permanently deleted.";
  }
  return "Spaces inside will move to Ungrouped. Their tab groups are kept.";
}

function getDeleteSpaceGroupLabel(state: DeleteSpaceGroupState | null): string {
  return state?.mode === "deleteContents"
    ? "Move group to Bin"
    : "Delete group";
}

function getPermanentDeleteDescription(entry?: BinEntry): string {
  if (entry?.kind === "space") {
    return "This cannot be undone. The space and all of its tab groups, folders, and saved items will be removed immediately.";
  }
  if (entry?.kind === "folder") {
    return "This cannot be undone. The folder or tab group and every nested folder and saved item inside will be removed immediately.";
  }
  return "This cannot be undone. This saved tab will be removed immediately.";
}
