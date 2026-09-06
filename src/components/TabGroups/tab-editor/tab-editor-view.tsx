import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  Star,
  Link as LinkIcon,
  StickyNote,
  Tag as TagIcon,
  Plus,
  X,
  Loader2,
  Calendar,
  Clock,
  Folder as FolderIcon,
  Hash,
  Save,
  RotateCcw,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetTitle,
} from "@components/ui/sheet";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@components/ui/select";
import { ScrollArea } from "@components/ui/scroll-area";
import { ConfirmDialog } from "@components/ui/confirm-dialog";
import { WebIcon } from "@icons/web";
import {
  MediaLightboxModal,
  type LightboxEntry,
  type LightboxMetadata,
} from "@components/TabGroups/MediaLightboxModal";
import { MorphingDialog } from "@components/ui/morphing-dialog";
import { cn } from "@src/lib/utils";
import { tagChipStyle, tagDotStyle } from "../tag-color";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  SOURCE_LABEL,
  SOURCE_OPTIONS,
  formatDateTime,
  type TagEntry,
} from "./model";
import { EditorField, MetadataItem, SectionHeading } from "./editor-fields";
import {
  MediaEditorSection,
  type ResolvedMediaMeta,
} from "./media-editor-section";

export type TabEditorViewProps = {
  item: ItemDocType;
  open: boolean;
  handleOpenChange: (open: boolean) => void;
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  titleRef: RefObject<HTMLInputElement | null>;
  url: string;
  setUrl: Dispatch<SetStateAction<string>>;
  urlError: string | null;
  setUrlError: Dispatch<SetStateAction<string | null>>;
  source: ItemDocType["source"];
  setSource: Dispatch<SetStateAction<ItemDocType["source"]>>;
  isFavorite: boolean;
  setIsFavorite: Dispatch<SetStateAction<boolean>>;
  authorUsername: string;
  setAuthorUsername: Dispatch<SetStateAction<string>>;
  likes: string;
  setLikes: Dispatch<SetStateAction<string>>;
  upvotes: string;
  setUpvotes: Dispatch<SetStateAction<string>>;
  textContent: string;
  setTextContent: Dispatch<SetStateAction<string>>;
  charCount: number;
  tags: TagEntry[];
  newTag: string;
  setNewTag: Dispatch<SetStateAction<string>>;
  isAddingTag: boolean;
  handleAddTag: () => Promise<void>;
  handleRemoveTag: (tagId: string, tagName: string) => Promise<void>;
  mediaItems: ItemDocType["media"];
  resolvedMedia: LightboxEntry[];
  resolvedMeta: ResolvedMediaMeta[];
  activeMediaIndex: number;
  setActiveMediaIndex: Dispatch<SetStateAction<number>>;
  mediaErrorIndexes: Set<number>;
  setMediaErrorIndexes: Dispatch<SetStateAction<Set<number>>>;
  isMediaMenuOpen: boolean;
  setIsMediaMenuOpen: Dispatch<SetStateAction<boolean>>;
  isLightboxOpen: boolean;
  setIsLightboxOpen: Dispatch<SetStateAction<boolean>>;
  isAddMediaOpen: boolean;
  setIsAddMediaOpen: Dispatch<SetStateAction<boolean>>;
  mediaUrl: string;
  setMediaUrl: Dispatch<SetStateAction<string>>;
  isAddingMedia: boolean;
  replaceIndex: number | null;
  setReplaceIndex: Dispatch<SetStateAction<number | null>>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleAddMediaByUrl: () => Promise<void>;
  handleUploadFiles: (files: File[], indexToReplace?: number) => Promise<void>;
  handleRemoveMedia: (index: number) => Promise<void>;
  handleSetPrimaryMedia: (index: number) => Promise<void>;
  isRefetchConfirmOpen: boolean;
  setIsRefetchConfirmOpen: Dispatch<SetStateAction<boolean>>;
  handleRefetchMetadata: () => Promise<void>;
  lightboxMetadata?: LightboxMetadata;
  isSaving: boolean;
  hasDirtyChanges: boolean;
  handleReset: () => void;
  handleSave: () => Promise<void>;
};

export function TabEditorView({
  item,
  open,
  handleOpenChange,
  title,
  setTitle,
  titleRef,
  url,
  setUrl,
  urlError,
  setUrlError,
  source,
  setSource,
  isFavorite,
  setIsFavorite,
  authorUsername,
  setAuthorUsername,
  likes,
  setLikes,
  upvotes,
  setUpvotes,
  textContent,
  setTextContent,
  charCount,
  tags,
  newTag,
  setNewTag,
  isAddingTag,
  handleAddTag,
  handleRemoveTag,
  mediaItems,
  resolvedMedia,
  resolvedMeta,
  activeMediaIndex,
  setActiveMediaIndex,
  mediaErrorIndexes,
  setMediaErrorIndexes,
  isMediaMenuOpen,
  setIsMediaMenuOpen,
  isLightboxOpen,
  setIsLightboxOpen,
  isAddMediaOpen,
  setIsAddMediaOpen,
  mediaUrl,
  setMediaUrl,
  isAddingMedia,
  replaceIndex,
  setReplaceIndex,
  fileInputRef,
  handleAddMediaByUrl,
  handleUploadFiles,
  handleRemoveMedia,
  handleSetPrimaryMedia,
  isRefetchConfirmOpen,
  setIsRefetchConfirmOpen,
  handleRefetchMetadata,
  lightboxMetadata,
  isSaving,
  hasDirtyChanges,
  handleReset,
  handleSave,
}: TabEditorViewProps) {
  return (
    <MorphingDialog>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          onInteractOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          className="w-full sm:max-w-lg md:max-w-xl p-0 flex flex-col gap-0 border-l border-border-neutral-faded bg-background-neutral"
        >
          <SheetTitle className="sr-only">
            {item?.title || "Edit tab"}
          </SheetTitle>
          {/* Header */}
          <div className="relative px-6 pt-6 pb-5 bg-gradient-to-b from-background-page to-background-neutral border-b border-border-neutral-faded">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden bg-background-neutral-faded ring-1 ring-black/10 shadow-sm flex items-center justify-center">
                {item.displayImageUrl ? (
                  <img
                    src={item.displayImageUrl}
                    alt={item.title}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : item.iconUrl ? (
                  <img
                    src={item.iconUrl}
                    alt={item.title}
                    className="w-7 h-7 rounded-md"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <WebIcon className="w-6 h-6 text-foreground-icon" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  placeholder="Tab title"
                  className={cn(
                    "w-full bg-transparent border-0 outline-none px-0 py-0",
                    "text-foreground-neutral font-semibold text-xl leading-tight",
                    "placeholder:text-foreground-tertiary",
                    "focus-visible:outline-none focus-visible:ring-0",
                    "[text-wrap:balance]",
                  )}
                  style={{ textWrap: "balance" }}
                />
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    try {
                      chrome.tabs.create({ url: item.url, active: true });
                    } catch (openErr) {
                      console.error("Failed to open tab from editor", openErr);
                    }
                  }}
                  className="mt-1 flex items-center gap-1.5 text-xs text-foreground-secondary hover:text-foreground-neutral transition-colors duration-200 group/link max-w-full"
                  title={item.url}
                >
                  <LinkIcon
                    size={12}
                    className="flex-shrink-0 text-foreground-tertiary group-hover/link:text-accent transition-colors"
                  />
                  <span className="truncate">{item.url}</span>
                </a>
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-background-neutral-faded text-[11px] font-medium text-foreground-secondary border border-border-neutral-faded">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                    {SOURCE_LABEL[source]}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsFavorite((v) => !v)}
                    aria-pressed={isFavorite}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium",
                      "border transition-all duration-200 active:scale-[0.96]",
                      isFavorite
                        ? "bg-accent-faded border-accent/30 text-accent"
                        : "bg-background-neutral-faded border-border-neutral-faded text-foreground-secondary hover:text-foreground-neutral",
                    )}
                  >
                    <Star
                      size={11}
                      className={cn(isFavorite && "fill-current")}
                    />
                    {isFavorite ? "Favorite" : "Mark favorite"}
                  </button>
                  {tags.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-background-neutral-faded text-[11px] font-medium text-foreground-secondary border border-border-neutral-faded tabular-nums">
                      <TagIcon size={11} className="text-foreground-tertiary" />
                      {tags.length} {tags.length === 1 ? "tag" : "tags"}
                    </span>
                  )}
                </div>
              </div>

              <SheetClose asChild>
                <button
                  type="button"
                  aria-label="Close editor"
                  className={cn(
                    "flex-shrink-0 w-10 h-10 -m-2 rounded-lg",
                    "flex items-center justify-center",
                    "text-foreground-secondary hover:text-foreground-neutral",
                    "hover:bg-background-highlight-faded transition-all duration-200",
                    "active:scale-[0.96] outline-none focus-visible:ring-2 focus-visible:ring-border-neutral/60",
                  )}
                >
                  <X size={18} />
                </button>
              </SheetClose>
            </div>
          </div>

          {/* Body */}
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-6 space-y-7">
              {/* Details section */}
              <section className="space-y-3">
                <SectionHeading icon={<LinkIcon size={14} />} label="Details" />

                <div className="rounded-xl bg-background-neutral-faded/50 p-4 space-y-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <EditorField label="URL" error={urlError}>
                    <Input
                      type="url"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        if (urlError) setUrlError(null);
                      }}
                      aria-invalid={!!urlError}
                      placeholder="https://example.com"
                      className="bg-background-neutral"
                    />
                  </EditorField>

                  <EditorField label="Source">
                    <Select
                      value={source}
                      onValueChange={(value) => {
                        const selectedSource = SOURCE_OPTIONS.find(
                          (option) => option.value === value,
                        );
                        if (selectedSource) setSource(selectedSource.value);
                      }}
                    >
                      <SelectTrigger className="w-full bg-background-neutral h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SOURCE_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </EditorField>

                  <EditorField label="Author">
                    <Input
                      type="text"
                      value={authorUsername}
                      onChange={(e) => setAuthorUsername(e.target.value)}
                      placeholder="@username (optional)"
                      className="bg-background-neutral"
                    />
                  </EditorField>

                  <div className="grid grid-cols-2 gap-3">
                    <EditorField label="Likes">
                      <Input
                        type="number"
                        min={0}
                        value={likes}
                        onChange={(e) => setLikes(e.target.value)}
                        placeholder="0"
                        className="bg-background-neutral tabular-nums"
                      />
                    </EditorField>
                    <EditorField label="Upvotes">
                      <Input
                        type="number"
                        min={0}
                        value={upvotes}
                        onChange={(e) => setUpvotes(e.target.value)}
                        placeholder="0"
                        className="bg-background-neutral tabular-nums"
                      />
                    </EditorField>
                  </div>
                </div>
              </section>

              {/* Notes section */}
              <section className="space-y-3">
                <SectionHeading
                  icon={<StickyNote size={14} />}
                  label="Notes"
                  trailing={
                    <span className="text-[11px] text-foreground-tertiary tabular-nums">
                      {charCount} {charCount === 1 ? "char" : "chars"}
                    </span>
                  }
                />
                <div className="rounded-xl bg-background-neutral-faded/50 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <textarea
                    value={textContent}
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder="Add notes, context, or thoughts about this tab..."
                    className={cn(
                      "w-full min-h-[120px] resize-y",
                      "rounded-lg bg-background-neutral",
                      "border border-border-neutral-faded/60 px-3.5 py-2.5",
                      "text-sm leading-relaxed text-foreground-neutral",
                      "placeholder:text-foreground-secondary",
                      "outline-none transition-[border-color,box-shadow]",
                      "focus-visible:border-accent/45 focus-visible:ring-[3px] focus-visible:ring-accent/15",
                    )}
                  />
                </div>
              </section>

              <MediaEditorSection
                mediaItems={mediaItems}
                resolvedMedia={resolvedMedia}
                resolvedMeta={resolvedMeta}
                activeMediaIndex={activeMediaIndex}
                setActiveMediaIndex={setActiveMediaIndex}
                mediaErrorIndexes={mediaErrorIndexes}
                setMediaErrorIndexes={setMediaErrorIndexes}
                isMediaMenuOpen={isMediaMenuOpen}
                setIsMediaMenuOpen={setIsMediaMenuOpen}
                setIsLightboxOpen={setIsLightboxOpen}
                isAddMediaOpen={isAddMediaOpen}
                setIsAddMediaOpen={setIsAddMediaOpen}
                mediaUrl={mediaUrl}
                setMediaUrl={setMediaUrl}
                isAddingMedia={isAddingMedia}
                replaceIndex={replaceIndex}
                setReplaceIndex={setReplaceIndex}
                fileInputRef={fileInputRef}
                handleAddMediaByUrl={handleAddMediaByUrl}
                handleUploadFiles={handleUploadFiles}
                handleRemoveMedia={handleRemoveMedia}
                handleSetPrimaryMedia={handleSetPrimaryMedia}
                setIsRefetchConfirmOpen={setIsRefetchConfirmOpen}
              />

              {/* Tags section */}
              <section className="space-y-3">
                <SectionHeading
                  icon={<TagIcon size={14} />}
                  label="Tags"
                  trailing={
                    tags.length > 0 ? (
                      <span className="text-[11px] text-foreground-tertiary tabular-nums">
                        {tags.length}
                      </span>
                    ) : null
                  }
                />

                <div className="rounded-xl bg-background-neutral-faded/50 p-4 space-y-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      placeholder="Add a tag..."
                      className="bg-background-neutral h-9"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddTag}
                      disabled={isAddingTag || newTag.trim().length === 0}
                      className="h-9 px-3 active:scale-[0.96] transition-transform"
                    >
                      {isAddingTag ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Plus size={14} />
                      )}
                      <span className="hidden sm:inline">Add</span>
                    </Button>
                  </div>

                  {tags.length === 0 ? (
                    <p className="text-xs text-foreground-tertiary py-1">
                      No tags yet. Tags help you find this tab faster.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((tag) => (
                        <span
                          key={tag.id}
                          style={tagChipStyle(tag.color)}
                          className={cn(
                            "group/tag inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full border",
                            "text-xs font-medium text-foreground-neutral transition-all duration-200",
                            tag.color
                              ? ""
                              : "bg-background-neutral border-border-neutral-faded hover:border-border-neutral",
                          )}
                        >
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={tagDotStyle(tag.color)}
                          />
                          <span className="truncate max-w-[180px]">
                            {tag.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveTag(tag.id, tag.name)}
                            aria-label={`Remove tag ${tag.name}`}
                            className={cn(
                              "flex-shrink-0 w-5 h-5 rounded-full",
                              "flex items-center justify-center",
                              "text-foreground-tertiary hover:text-foreground-danger hover:bg-background-danger-faded",
                              "transition-all duration-150 active:scale-[0.96]",
                            )}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Metadata section — read only */}
              <section className="space-y-3">
                <SectionHeading
                  icon={<Hash size={14} />}
                  label="Metadata"
                  trailing={
                    <span className="text-[11px] text-foreground-tertiary font-normal normal-tracking">
                      read-only
                    </span>
                  }
                />
                <div className="rounded-xl bg-background-neutral-faded/50 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                    <MetadataItem
                      icon={<Calendar size={13} />}
                      label="Created"
                      value={formatDateTime(item.createdAt)}
                    />
                    <MetadataItem
                      icon={<Clock size={13} />}
                      label="Updated"
                      value={formatDateTime(item.updatedAt)}
                    />
                    <MetadataItem
                      icon={<FolderIcon size={13} />}
                      label="Folder ID"
                      value={item.folderId}
                      mono
                    />
                    <MetadataItem
                      icon={<Hash size={13} />}
                      label="Item ID"
                      value={item.id}
                      mono
                    />
                  </dl>
                </div>
              </section>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-border-neutral-faded bg-background-neutral flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {hasDirtyChanges ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-foreground-secondary">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  Unsaved changes
                </span>
              ) : (
                <span className="text-xs text-foreground-tertiary">
                  {isSaving ? "Saving..." : "All changes saved"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleReset}
                disabled={isSaving || !hasDirtyChanges}
                className="h-9 gap-1.5 active:scale-[0.96] transition-transform"
              >
                <RotateCcw size={14} />
                <span className="hidden sm:inline">Reset</span>
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !hasDirtyChanges}
                className="h-9 gap-1.5 active:scale-[0.96] transition-transform min-w-[96px]"
              >
                {isSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                <span>{isSaving ? "Saving..." : "Save changes"}</span>
              </Button>
            </div>
          </div>
        </SheetContent>

        <ConfirmDialog
          open={isRefetchConfirmOpen}
          onOpenChange={setIsRefetchConfirmOpen}
          title="Refetch metadata from source?"
          description="This will override ALL data for this tab — title, media, description, and other metadata will be replaced with fresh data from the source URL. This cannot be undone."
          confirmLabel="Refetch & override"
          cancelLabel="Cancel"
          variant="warning"
          onConfirm={handleRefetchMetadata}
        />

        <MediaLightboxModal
          entries={resolvedMedia}
          initialIndex={activeMediaIndex}
          metadata={lightboxMetadata}
          onClose={() => setIsLightboxOpen(false)}
        />
      </Sheet>
    </MorphingDialog>
  );
}
