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
  | { status: "loading"; message?: string }
  | { status: "ready"; url: string; sourceByteSize: number; capturedAt?: number }
  | { status: "error"; message: string };

const formatCaptureTime = (value: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "recently";
  }
};

type ArchiveCaptureResult = {
  captured: boolean;
  reason?: string;
};

const captureArchiveNow = async (itemId: string, url: string): Promise<ArchiveCaptureResult> => {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "ARCHIVE_CAPTURE_NOW",
    payload: { itemId, url },
  });
  if (response?.success === false) {
    throw new Error(response?.error || "Capture request failed");
  }
  const payload = response?.payload ?? {};
  return {
    captured: payload.captured === true,
    ...(typeof payload.reason === "string" && payload.reason
      ? { reason: payload.reason }
      : {}),
  };
};

/** The card's View sheet renders the cloud archive, never the live website. */
export const WebsitePreview = ({ url, title, open, onOpenChange, item }: WebsitePreviewProps) => {
  const [retryNonce, setRetryNonce] = useState(0);
  const [frameLoading, setFrameLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "loading" });
  const [cloudConnected, setCloudConnected] = useState<boolean | null>(null);
  const [canCapture, setCanCapture] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const activeSessionRef = useRef<ArchivePreviewSession | null>(null);
  const forceRefreshRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Login-optional archives: surface whether this copy lives in the
    // ephemeral device namespace so the connect nudge makes sense.
    chrome.runtime
      .sendMessage({ service: "cloudAuth", type: "status", target: "offscreen", payload: {} })
      .then((response) => {
        if (cancelled) return;
        const payload = response?.payload ?? response;
        setCloudConnected(payload?.connected === true);
      })
      .catch(() => {
        if (!cancelled) setCloudConnected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const preferFresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    const session = new ArchivePreviewSession({
      preferFresh,
      recoverMissing: async () => {
        if (!cancelled) {
          setCanCapture(false);
          setCapturing(true);
          setPreview({
            status: "loading",
            message: "No snapshot existed, so Vibesearch is capturing this page now…",
          });
        }
        try {
          const result = await captureArchiveNow(item.id, url);
          if (!result.captured) {
            throw new ArchivePreviewError(
              "ARCHIVE_PREVIEW_NETWORK_ERROR",
              result.reason
                ? `Capture did not finish: ${result.reason}`
                : "Capture is queued but has not finished yet.",
            );
          }
          return true;
        } finally {
          if (!cancelled) setCapturing(false);
        }
      },
    });
    activeSessionRef.current = session;
    setPreview({ status: "loading" });
    setFrameLoading(false);

    void session.load(item.id).then((document) => {
      if (cancelled) return;
      setCanCapture(false);
      setFrameLoading(true);
      setPreview({ status: "ready", ...document });
    }).catch((error: unknown) => {
      if (
        cancelled ||
        (error instanceof ArchivePreviewError && error.code === "ARCHIVE_PREVIEW_ABORTED")
      ) {
        return;
      }
      if (error instanceof ArchivePreviewError) {
        console.warn(`[archive-preview] failed code=${error.code} status=${error.status ?? "-"}`, error);
        if (
          error.code === "ARCHIVE_PREVIEW_NOT_FOUND" ||
          error.code === "ARCHIVE_PREVIEW_NETWORK_ERROR"
        ) {
          setCanCapture(true);
        }
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

  useEffect(() => {
    if (!open) return;
    setCanCapture(false);
    setCapturing(false);
  }, [open, retryNonce]);

  const requestServerCapture = () => {
    if (capturing) return;
    setCapturing(true);
    captureArchiveNow(item.id, url)
      .then((payload) => {
        setCapturing(false);
        if (payload.captured === true) {
          requestFreshCopy();
          return;
        }
        setCanCapture(true);
        setPreview({
          status: "error",
          message: payload.reason
            ? `Capture is queued but not finished: ${payload.reason}`
            : "Capture is queued. Try again after you’re back online.",
        });
      })
      .catch((error) => {
        console.warn("[archive-preview] server capture request failed", error);
        setCapturing(false);
        setCanCapture(true);
        setPreview({
          status: "error",
          message: error instanceof Error ? error.message : "Capture request failed.",
        });
      });
  };

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
                {preview.status === "ready" && (
                  <>
                    <span className="shrink-0">
                      Captured {formatCaptureTime(
                        preview.capturedAt || Math.max(
                          item.updatedAt || 0,
                          ...(item.blobs || [])
                            .filter((blob) => blob.kind === "archive")
                            .map((blob) => blob.capturedAt || 0),
                        )
                      )}
                    </span>
                    <span aria-hidden className="text-foreground-tertiary">·</span>
                  </>
                )}
                <span className="truncate">{url}</span>
              </SheetDescription>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-4">
            {cloudConnected === false && (
              <span
                className="hidden sm:inline-flex items-center gap-1 rounded-full bg-background-neutral px-2 py-0.5 text-[10px] font-medium text-foreground-tertiary"
                title="This copy is stored on this device only. The oldest copies are dropped once this device is holding 5,000 snapshots or 256 MB, and copies backed up without an account are cleared after 30 days. Log in with Google to keep them permanently and open them on your other devices."
              >
                Saved on this device
              </span>
            )}
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
                {preview.status === "loading" && preview.message
                  ? preview.message
                  : "Reading the sanitized snapshot from offline storage or the archive cloud"}
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
              sandbox=""
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
                  {canCapture && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={requestServerCapture}
                      disabled={capturing}
                    >
                      <Archive size={14} />
                      {capturing ? "Capturing…" : "Capture this page now"}
                    </Button>
                  )}
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
