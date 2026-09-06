import type { ScreenshotRegionSelectionResult } from "@src/workers/background/import-types";
import { executeScriptInTab } from "@src/workers/background/browser-tab-runtime";

type ToastActionPayload = {
  itemId?: string;
  primaryUrl?: string;
};

type DestinationActionPayload = ToastActionPayload & {
  pendingId?: string;
};

export const showBrandedToast = async (
  tab: chrome.tabs.Tab | undefined,
  message: string,
  actions?: Array<{
    label: string;
    action: string;
    payload?: ToastActionPayload;
  }>,
  duration = 4000,
) => {
  await executeScriptInTab(
    tab,
    (payload: {
      message: string;
      actions?: Array<{
        label: string;
        action: string;
        payload?: ToastActionPayload;
      }>;
      duration: number;
    }) => {
      try {
        const TOKENS = {
          bg: "#ffffff",
          border: "#c6c6c6",
          accent: "#ff4d4d",
          accentFaded: "#ffe5e5",
          text: "#212121",
          shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
          radius: "10px",
          radiusSm: "6px",
          fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
        };

        const rootId = "__vibesearch_toast_root__";
        let root = document.getElementById(rootId);
        if (!root) {
          root = document.createElement("div");
          root.id = rootId;
          const shadow = root.attachShadow({ mode: "open" });
          const container = document.createElement("div");
          container.id = "container";
          Object.assign(container.style, {
            position: "fixed",
            right: "16px",
            bottom: "16px",
            zIndex: "2147483647",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            pointerEvents: "none",
            fontFamily: TOKENS.fontSans,
          });
          shadow.appendChild(container);
          document.documentElement.appendChild(root);
        }

        const shadow = root.shadowRoot!;
        const container = shadow.getElementById("container")!;

        const toast = document.createElement("div");
        Object.assign(toast.style, {
          maxWidth: "380px",
          minWidth: "280px",
          padding: "12px 14px",
          borderRadius: TOKENS.radius,
          background: TOKENS.bg,
          border: `1px solid ${TOKENS.border}`,
          boxShadow: TOKENS.shadow,
          display: "flex",
          alignItems: "center",
          gap: "12px",
          pointerEvents: "auto",
          fontSize: "13px",
          lineHeight: "1.4",
          color: TOKENS.text,
          fontFamily: TOKENS.fontSans,
        });

        const messageEl = document.createElement("div");
        messageEl.textContent = payload.message;
        Object.assign(messageEl.style, { flex: "1", fontWeight: "500" });
        toast.appendChild(messageEl);

        if (payload.actions && payload.actions.length > 0) {
          const actionsRow = document.createElement("div");
          Object.assign(actionsRow.style, {
            display: "flex",
            gap: "8px",
            alignItems: "center",
            flexWrap: "wrap",
          });

          for (const action of payload.actions) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = action.label;
            Object.assign(btn.style, {
              padding: "5px 10px",
              borderRadius: TOKENS.radiusSm,
              border: `1px solid ${TOKENS.accent}`,
              background: "transparent",
              color: TOKENS.accent,
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              fontFamily: TOKENS.fontSans,
              transition: "all 150ms",
            });
            btn.addEventListener("mouseenter", () => {
              btn.style.background = TOKENS.accentFaded;
            });
            btn.addEventListener("mouseleave", () => {
              btn.style.background = "transparent";
            });
            btn.addEventListener("click", () => {
              chrome.runtime.sendMessage({
                target: "background",
                type: action.action,
                payload: action.payload,
              });
              toast.remove();
              if (container.childElementCount === 0) root!.remove();
            });
            actionsRow.appendChild(btn);
          }

          toast.appendChild(actionsRow);
        }

        container.appendChild(toast);

        if (payload.duration > 0) {
          setTimeout(() => {
            toast.remove();
            if (container.childElementCount === 0) root!.remove();
          }, payload.duration);
        }
      } catch {}
    },
    [{ message, actions, duration }],
  );
};

export type DestinationPickerSpace = {
  spaceId: string;
  spaceName: string;
  folders: Array<{ folderId: string; folderName: string; usedAt: number }>;
};

export const showDestinationPickerToast = async (
  tab: chrome.tabs.Tab | undefined,
  title: string,
  spaces: DestinationPickerSpace[],
  confirmAction: string,
  extraPayload: DestinationActionPayload = {},
  options: {
    autoSave?: { timeoutMs: number; targetLabel: string };
    allowSpaceDirectSave?: boolean;
  } = {},
) => {
  await executeScriptInTab(
    tab,
    (payload: {
      title: string;
      spaces: Array<{
        spaceId: string;
        spaceName: string;
        folders: Array<{
          folderId: string;
          folderName: string;
          usedAt: number;
        }>;
      }>;
      confirmAction: string;
      extraPayload: DestinationActionPayload;
      autoSave: { timeoutMs: number; targetLabel: string } | null;
      allowSpaceDirectSave: boolean;
    }) => {
      try {
        const TOKENS = {
          bg: "#ffffff",
          border: "#c6c6c6",
          accent: "#ff4d4d",
          accentFaded: "#ffe5e5",
          text: "#212121",
          textMuted: "#6b6b6b",
          rowHover: "#f5f5f5",
          shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
          radius: "10px",
          radiusSm: "6px",
          fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
        };

        const rootId = "__vibesearch_picker_root__";
        const existing = document.getElementById(rootId);
        if (existing) existing.remove();

        const root = document.createElement("div");
        root.id = rootId;
        const shadow = root.attachShadow({ mode: "open" });

        let closed = false;
        let countdownTimer: ReturnType<typeof setInterval> | null = null;
        let onKey: ((event: KeyboardEvent) => void) | null = null;
        const cleanup = () => {
          if (countdownTimer !== null) {
            clearInterval(countdownTimer);
            countdownTimer = null;
          }
          if (onKey) {
            window.removeEventListener("keydown", onKey, true);
            onKey = null;
          }
        };
        const dismiss = () => {
          if (closed) return;
          closed = true;
          cleanup();
          root.remove();
        };
        const confirmSave = (
          folderId: string,
          spaceId: string,
          auto: boolean,
        ) => {
          if (closed) return;
          chrome.runtime.sendMessage({
            target: "background",
            type: payload.confirmAction,
            payload: {
              ...payload.extraPayload,
              folderId,
              spaceId,
              autoSave: auto,
            },
          });
          dismiss();
        };

        const panel = document.createElement("div");
        Object.assign(panel.style, {
          position: "fixed",
          right: "16px",
          bottom: "16px",
          zIndex: "2147483647",
          width: "320px",
          maxHeight: "420px",
          display: "flex",
          flexDirection: "column",
          background: TOKENS.bg,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: TOKENS.radius,
          boxShadow: TOKENS.shadow,
          fontFamily: TOKENS.fontSans,
          color: TOKENS.text,
          fontSize: "13px",
          overflow: "hidden",
          pointerEvents: "auto",
        });

        const header = document.createElement("div");
        Object.assign(header.style, {
          padding: "10px 14px",
          borderBottom: `1px solid ${TOKENS.border}`,
          fontWeight: "600",
          fontSize: "13px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        });
        header.textContent = payload.title;

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "×";
        Object.assign(closeBtn.style, {
          background: "transparent",
          border: "none",
          color: TOKENS.textMuted,
          fontSize: "18px",
          cursor: "pointer",
          padding: "0 4px",
          lineHeight: "1",
          fontFamily: TOKENS.fontSans,
        });
        closeBtn.addEventListener("click", () => {
          dismiss();
        });
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const listScroll = document.createElement("div");
        Object.assign(listScroll.style, {
          overflowY: "auto",
          flex: "1",
          padding: "4px 0",
        });

        const renderRow = (
          label: string,
          onClick: () => void,
          opts: {
            indent?: boolean;
            muted?: boolean;
            bold?: boolean;
            chevron?: boolean;
          } = {},
        ) => {
          const row = document.createElement("div");
          Object.assign(row.style, {
            padding: "8px 14px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            paddingLeft: opts.indent ? "28px" : "14px",
            color: opts.muted ? TOKENS.textMuted : TOKENS.text,
            fontWeight: opts.bold ? "600" : "400",
            fontSize: "13px",
            transition: "background 120ms",
            fontFamily: TOKENS.fontSans,
          });
          row.textContent = label;
          row.addEventListener("mouseenter", () => {
            row.style.background = TOKENS.rowHover;
          });
          row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
          });
          row.addEventListener("click", onClick);
          return row;
        };

        const addHint = (row: HTMLElement, text: string) => {
          const hint = document.createElement("span");
          hint.textContent = text;
          Object.assign(hint.style, {
            marginLeft: "auto",
            fontSize: "11px",
            fontWeight: "400",
            color: TOKENS.textMuted,
          });
          row.appendChild(hint);
        };

        for (const space of payload.spaces) {
          const spaceLabel = `space-${space.spaceName}`;
          const sortedFolders = [...space.folders].sort(
            (a, b) => b.usedAt - a.usedAt,
          );

          // A space with no groups can't be expanded into folder rows. Instead of
          // leaving an inert row that looks "stuck", make it directly saveable
          // (screenshot picker) or show it as non-actionable.
          if (sortedFolders.length === 0) {
            if (payload.allowSpaceDirectSave) {
              const spaceRow = renderRow(
                spaceLabel,
                () => confirmSave("", space.spaceId, false),
                { bold: true },
              );
              addHint(spaceRow, "save here");
              listScroll.appendChild(spaceRow);
            } else {
              const spaceRow = renderRow(spaceLabel, () => {}, {
                bold: true,
                muted: true,
              });
              spaceRow.style.cursor = "default";
              addHint(spaceRow, "no groups");
              listScroll.appendChild(spaceRow);
            }
            continue;
          }

          let expanded = false;
          const folderRows: HTMLElement[] = [];

          const spaceRow = renderRow(
            spaceLabel,
            () => {
              expanded = !expanded;
              for (const fr of folderRows) {
                fr.style.display = expanded ? "flex" : "none";
              }
            },
            { bold: true, chevron: true },
          );

          const chevron = document.createElement("span");
          chevron.textContent = "›";
          Object.assign(chevron.style, {
            fontSize: "14px",
            color: TOKENS.textMuted,
            transition: "transform 150ms",
          });
          spaceRow.insertBefore(chevron, spaceRow.firstChild!);

          listScroll.appendChild(spaceRow);

          for (const folder of sortedFolders) {
            const folderRow = renderRow(
              folder.folderName || "Untitled",
              () => confirmSave(folder.folderId, space.spaceId, false),
              { indent: true, muted: false },
            );
            folderRow.style.display = "none";
            folderRows.push(folderRow);
            listScroll.appendChild(folderRow);
          }
        }

        panel.appendChild(listScroll);

        if (payload.autoSave) {
          const autoSave = payload.autoSave;
          const footer = document.createElement("div");
          Object.assign(footer.style, {
            padding: "8px 14px",
            borderTop: `1px solid ${TOKENS.border}`,
            fontSize: "12px",
            color: TOKENS.textMuted,
            fontFamily: TOKENS.fontSans,
          });
          panel.appendChild(footer);

          let remainingMs = autoSave.timeoutMs;
          let paused = false;
          let lastTick = Date.now();
          const secondsLeft = () => Math.max(0, Math.ceil(remainingMs / 1000));
          const renderFooter = () => {
            footer.textContent = paused
              ? `Paused. Move away to resume saving to ${autoSave.targetLabel}.`
              : `Auto-saving to ${autoSave.targetLabel} in ${secondsLeft()}s. Hover to pause.`;
          };
          renderFooter();

          countdownTimer = setInterval(() => {
            const now = Date.now();
            const delta = now - lastTick;
            lastTick = now;
            if (!paused) {
              remainingMs -= delta;
              if (remainingMs <= 0) {
                // No explicit choice within the window: save to the recent/LRU
                // folder (empty folderId + spaceId routes through preferLru).
                confirmSave("", "", true);
                return;
              }
            }
            renderFooter();
          }, 200);

          panel.addEventListener("mouseenter", () => {
            paused = true;
            renderFooter();
          });
          panel.addEventListener("mouseleave", () => {
            paused = false;
            lastTick = Date.now();
            renderFooter();
          });
        }

        shadow.appendChild(panel);
        document.documentElement.appendChild(root);

        onKey = (event: KeyboardEvent) => {
          if (event.key === "Escape") dismiss();
        };
        window.addEventListener("keydown", onKey, true);
      } catch {}
    },
    [
      {
        title,
        spaces,
        confirmAction,
        extraPayload,
        autoSave: options.autoSave ?? null,
        allowSpaceDirectSave: options.allowSpaceDirectSave === true,
      },
    ],
  );
};

export const selectScreenshotRegion = async (
  tab: chrome.tabs.Tab | undefined,
): Promise<ScreenshotRegionSelectionResult> => {
  const result = await executeScriptInTab<
    ScreenshotRegionSelectionResult | null,
    []
  >(tab, () => {
    try {
      return new Promise<
        | {
            status: "selected";
            selection: {
              x: number;
              y: number;
              width: number;
              height: number;
              viewportWidth: number;
              viewportHeight: number;
            };
          }
        | { status: "cancelled" }
      >((resolve) => {
        const TOKENS = {
          bg: "#ffffff",
          border: "#c6c6c6",
          accent: "#ff4d4d",
          text: "#212121",
          shadow: "0px 20px 35px rgba(15, 23, 42, 0.18)",
          radius: "10px",
          fontSans: '"Neutral Sans", ui-sans-serif, system-ui, sans-serif',
        };

        const rootId = "__vibesearch_screenshot_selector__";
        const existing = document.getElementById(rootId);
        if (existing) existing.remove();

        const root = document.createElement("div");
        root.id = rootId;
        const shadow = root.attachShadow({ mode: "open" });

        // Scrim
        const scrim = document.createElement("div");
        Object.assign(scrim.style, {
          position: "fixed",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          background: "rgba(0, 0, 0, 0.4)",
          zIndex: "2147483646",
          cursor: "crosshair",
        });

        // Selection box
        const box = document.createElement("div");
        Object.assign(box.style, {
          position: "fixed",
          border: `2px solid ${TOKENS.accent}`,
          background: "rgba(255, 77, 77, 0.08)",
          pointerEvents: "none",
          display: "none",
          zIndex: "2147483647",
        });

        // Hint
        const hint = document.createElement("div");
        hint.textContent =
          "Drag to select \u2022 Enter to save \u2022 Esc to cancel";
        Object.assign(hint.style, {
          position: "fixed",
          top: "20px",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "10px 16px",
          borderRadius: TOKENS.radius,
          background: TOKENS.bg,
          border: `1px solid ${TOKENS.border}`,
          boxShadow: TOKENS.shadow,
          fontSize: "13px",
          fontWeight: "500",
          color: TOKENS.text,
          fontFamily: TOKENS.fontSans,
          zIndex: "2147483647",
          pointerEvents: "none",
        });

        shadow.appendChild(scrim);
        shadow.appendChild(box);
        shadow.appendChild(hint);
        document.documentElement.appendChild(root);

        let startX = 0;
        let startY = 0;
        let isDragging = false;

        const cleanup = (
          selection: {
            x: number;
            y: number;
            width: number;
            height: number;
            viewportWidth: number;
            viewportHeight: number;
          } | null,
        ) => {
          window.removeEventListener("keydown", onKeyDown, true);
          scrim.removeEventListener("mousedown", onMouseDown);
          scrim.removeEventListener("mousemove", onMouseMove);
          scrim.removeEventListener("mouseup", onMouseUp);
          root.remove();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (selection) {
                resolve({ status: "selected", selection });
              } else {
                resolve({ status: "cancelled" });
              }
            });
          });
        };

        const onMouseDown = (e: MouseEvent) => {
          startX = e.clientX;
          startY = e.clientY;
          isDragging = true;
          box.style.display = "block";
          box.style.left = `${startX}px`;
          box.style.top = `${startY}px`;
          box.style.width = "0";
          box.style.height = "0";
        };

        const onMouseMove = (e: MouseEvent) => {
          if (!isDragging) return;
          const x = Math.min(startX, e.clientX);
          const y = Math.min(startY, e.clientY);
          const width = Math.abs(e.clientX - startX);
          const height = Math.abs(e.clientY - startY);
          box.style.left = `${x}px`;
          box.style.top = `${y}px`;
          box.style.width = `${width}px`;
          box.style.height = `${height}px`;
        };

        const onMouseUp = (e: MouseEvent) => {
          if (!isDragging) return;
          isDragging = false;
          const x = Math.min(startX, e.clientX);
          const y = Math.min(startY, e.clientY);
          const width = Math.abs(e.clientX - startX);
          const height = Math.abs(e.clientY - startY);
          if (width > 10 && height > 10) {
            cleanup({
              x,
              y,
              width,
              height,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
            });
          } else {
            box.style.display = "none";
          }
        };

        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cleanup(null);
          } else if (e.key === "Enter" && box.style.display === "block") {
            e.preventDefault();
            const x = parseInt(box.style.left, 10);
            const y = parseInt(box.style.top, 10);
            const width = parseInt(box.style.width, 10);
            const height = parseInt(box.style.height, 10);
            if (width > 10 && height > 10) {
              cleanup({
                x,
                y,
                width,
                height,
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
              });
            }
          }
        };

        scrim.addEventListener("mousedown", onMouseDown);
        scrim.addEventListener("mousemove", onMouseMove);
        scrim.addEventListener("mouseup", onMouseUp);
        window.addEventListener("keydown", onKeyDown, true);
      });
    } catch {
      return {
        status: "unavailable",
      } satisfies ScreenshotRegionSelectionResult;
    }
  }, []);

  if (!result) {
    return { status: "unavailable" };
  }
  if (result.status === "selected") {
    const { selection } = result;
    if (
      Number.isFinite(selection.x) &&
      Number.isFinite(selection.y) &&
      Number.isFinite(selection.width) &&
      Number.isFinite(selection.height) &&
      selection.width > 0 &&
      selection.height > 0 &&
      selection.viewportWidth > 0 &&
      selection.viewportHeight > 0
    ) {
      return result;
    }
    return { status: "cancelled" };
  }
  if (result.status === "cancelled") {
    return result;
  }
  return { status: "unavailable" };
};
