import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@components/ui/sheet";
import { Button } from "@components/ui/button";
import { OpenArrowIcon } from "@icons/open-arrow";
import { useEffect, useRef, useState } from "react";
import { cn } from "@src/lib/utils";
import { Archive, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ItemDocType } from "@src/schemas/item_schema";
import {
  ArchivePreviewError,
  ArchivePreviewSession,
} from "@src/services/archive-preview";

interface WebsitePreviewProps {
  url: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ItemDocType;
}

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; url: string; sourceByteSize: number }
  | { status: "error"; message: string };

/** The card's View sheet renders the cloud archive, never the live website. */
export const WebsitePreview = ({ url, title, open, onOpenChange, item }: WebsitePreviewProps) => {
  const [retryNonce, setRetryNonce] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const activeSessionRef = useRef<ArchivePreviewSession | null>(null);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const preferFresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    const session = new ArchivePreviewSession({ preferFresh });
    activeSessionRef.current = session;
    setPreview({ status: "loading" });
    setFrameLoading(false);

    void session.load(item.id).then((document) => {
      if (cancelled) return;
      setFrameLoading(true);
      setPreview({ status: "ready", ...document });
    }).catch((error: unknown) => {
      if (
        cancelled ||
        (error instanceof ArchivePreviewError && error.code === "ARCHIVE_PREVIEW_ABORTED")
      ) {
        return;
      }
      setFrameLoading(false);
      setPreview({
        status: "error",
        message: error instanceof ArchivePreviewError
          ? error.message
          : "The saved copy could not be loaded.",
      });
    });

    return () => {
      cancelled = true;
      session.dispose();
      if (activeSessionRef.current === session) activeSessionRef.current = null;
    };
  }, [item.id, open, retryNonce]);

  const requestFreshCopy = () => {
    forceRefreshRef.current = true;
    setRetryNonce((value) => value + 1);
  };

  const handleOpenLivePage = () => {
    try {
      void chrome.tabs.create({ url, active: true });
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl lg:max-w-4xl p-0 flex flex-col gap-0 border-l border-border-neutral-faded"
      >
        <SheetHeader className="px-4 py-3 pr-12 border-b border-border-neutral-faded flex flex-row items-center justify-between space-y-0 bg-background-neutral">
          <div className="flex min-w-0 items-center gap-3 overflow-hidden text-left">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-tea-green text-foreground-secondary">
              <Archive size={17} />
            </span>
            <div className="min-w-0">
              <SheetTitle className="text-base truncate">{title}</SheetTitle>
              <SheetDescription className="flex min-w-0 items-center gap-1.5 truncate text-xs">
                <ShieldCheck size={12} className="shrink-0 text-foreground-positive" />
                <span className="shrink-0">Archived copy</span>
                <span aria-hidden className="text-foreground-tertiary">·</span>
                <span className="truncate">{url}</span>
              </SheetDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-4">
            {preview.status === "ready" && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-2"
                onClick={requestFreshCopy}
              >
                <RefreshCw size={14} />
                <span className="hidden sm:inline">Refresh copy</span>
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 gap-2" onClick={handleOpenLivePage}>
              <OpenArrowIcon size={14} />
              <span className="hidden sm:inline">Open live page</span>
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 relative bg-background-page">
          {(preview.status === "loading" || (preview.status === "ready" && frameLoading)) && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background-neutral">
              <Loader2 className="mb-4 h-8 w-8 animate-spin text-accent-primary" />
              <p className="text-sm font-medium text-foreground-secondary">Loading archived copy…</p>
              <p className="mt-1 text-xs text-foreground-tertiary">
                Reading the sanitized snapshot from offline storage or the archive cloud
              </p>
            </div>
          )}

          {open && preview.status === "ready" && (
            <iframe
              title={`Archived copy of ${title}`}
              src={preview.url}
              className={cn(
                "h-full w-full border-none bg-white",
                frameLoading ? "opacity-0" : "opacity-100",
              )}
              onLoad={() => setFrameLoading(false)}
              onError={() => {
                activeSessionRef.current?.dispose();
                activeSessionRef.current = null;
                setFrameLoading(false);
                setPreview({
                  status: "error",
                  message: "The archived document could not be rendered safely.",
                });
              }}
              sandbox="allow-downloads"
              referrerPolicy="no-referrer"
            />
          )}

          {preview.status === "error" && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-background-neutral px-6">
              <div className="max-w-sm text-center">
                <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-background-danger-faded text-foreground-danger">
                  <TriangleAlert size={24} />
                </span>
                <p className="mt-4 text-base font-semibold text-foreground-neutral">
                  Couldn’t open the archived copy
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-foreground-secondary">
                  {preview.message}
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={requestFreshCopy}
                  >
                    <RefreshCw size={14} />
                    Try again
                  </Button>
                  <Button variant="outline" size="sm" className="gap-2" onClick={handleOpenLivePage}>
                    <OpenArrowIcon size={14} />
                    Open live page
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
