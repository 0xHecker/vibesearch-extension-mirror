import { memo, useCallback, useState } from "react";
import { ScanText, Check, Copy, ChevronDown, ChevronUp } from "lucide-react";
import type { MediaOcrMetadata } from "@src/schemas/item_schema";
import { cn } from "@src/lib/utils";

/**
 * Shows the text OCR extracted from a single media item. OCR output can run to
 * several paragraphs, so long text is clamped (with a CSS-mask fade that works
 * on any background) behind a Show more/less toggle, expands into a bounded
 * scroll area rather than growing without limit, and offers a Copy action.
 * Renders nothing for media that was never OCR'd.
 *
 * `variant="card"` is the inline editor surface; `variant="overlay"` is the
 * glassy floating panel used over the dark lightbox backdrop.
 */
const COLLAPSED_MAX = { card: "9rem", overlay: "7rem" } as const;
const EXPANDED_MAX = { card: "52vh", overlay: "40vh" } as const;
const FADE_MASK =
  "[mask-image:linear-gradient(to_bottom,#000_72%,transparent)] [-webkit-mask-image:linear-gradient(to_bottom,#000_72%,transparent)]";

export const OcrExtractedText = memo(
  ({
    ocr,
    className,
    variant = "card",
  }: {
    ocr?: MediaOcrMetadata;
    className?: string;
    variant?: "card" | "overlay";
  }) => {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    // Whole-panel collapse. The lightbox overlay floats over the image, so it
    // starts collapsed to keep the view uncluttered; the inline card stays open.
    const [collapsed, setCollapsed] = useState(variant === "overlay");

    const status = ocr?.status;
    const text = (ocr?.text || "").trim();

    const handleCopy = useCallback(() => {
      if (!text) return;
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    }, [text]);

    // Never-OCR'd media, or a deliberate skip with nothing to show.
    if (!status || (status === "skipped" && !text)) return null;

    const lineCount = typeof ocr?.lineCount === "number" ? ocr.lineCount : 0;
    const confidence =
      typeof ocr?.confidence === "number" && ocr.confidence !== null ? ocr.confidence : null;
    // Long enough that clamping + a Show more toggle is worthwhile.
    const isLong = lineCount > 6 || text.length > 320;

    return (
      <div
        className={cn(
          "rounded-xl border",
          collapsed ? "p-2" : "p-3",
          variant === "overlay"
            ? "border-border-neutral-faded/60 bg-background-neutral/80 shadow-lg backdrop-blur-md"
            : "border-border-neutral-faded bg-background-page-secondary/60",
          className,
        )}
      >
        <div className={cn("flex items-center gap-2", collapsed ? "" : "mb-1.5")}>
          <ScanText size={13} className="text-foreground-tertiary" />
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-foreground-tertiary">
            Extracted text
          </span>
          <span className="ml-auto flex items-center gap-2">
            {status === "done" && (lineCount > 0 || confidence !== null) && (
              <span className="flex items-center gap-1.5 text-[10px] tabular-nums text-foreground-tertiary">
                {lineCount > 0 && (
                  <span>
                    {lineCount} line{lineCount > 1 ? "s" : ""}
                  </span>
                )}
                {confidence !== null && <span>· {Math.round(confidence * 100)}%</span>}
              </span>
            )}
            {!collapsed && text && (
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy extracted text"
                title={copied ? "Copied" : "Copy"}
                className="flex items-center gap-1 text-[10px] text-foreground-tertiary transition-colors hover:text-foreground-secondary"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((value) => !value);
              }}
              aria-label={collapsed ? "Expand extracted text" : "Collapse extracted text"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand" : "Collapse"}
              className="flex items-center text-foreground-tertiary transition-colors hover:text-foreground-secondary"
            >
              {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </span>
        </div>

        {!collapsed &&
          (status === "processing" || status === "pending" ? (
            <div className="flex items-center gap-2 text-xs text-foreground-tertiary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground-tertiary" />
              Reading text from image…
            </div>
          ) : status === "error" ? (
            <div className="text-xs leading-relaxed text-foreground-tertiary">
              Couldn’t read text from this image.{" "}
              <span className="text-foreground-secondary">Try “Re-run OCR” from the menu.</span>
            </div>
          ) : text ? (
            <>
              <p
                className={cn(
                  "select-text whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground-secondary",
                  expanded ? "overflow-auto" : isLong ? cn("overflow-hidden", FADE_MASK) : "",
                )}
                style={{
                  maxHeight: expanded
                    ? EXPANDED_MAX[variant]
                    : isLong
                      ? COLLAPSED_MAX[variant]
                      : undefined,
                }}
              >
                {text}
              </p>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-1.5 text-[11px] font-medium text-foreground-secondary transition-colors hover:text-foreground"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          ) : (
            <div className="text-xs text-foreground-tertiary">
              No readable text found in this image.
            </div>
          ))}
      </div>
    );
  },
);

OcrExtractedText.displayName = "OcrExtractedText";
