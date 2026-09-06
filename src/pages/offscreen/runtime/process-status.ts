export type ProcessStatus = {
  id: string;
  label: string;
  state: "processing" | "success" | "error";
  detail: string;
  retryAction?:
    | "RETRY_QUERY"
    | "TRIGGER_EMBEDDING"
    | "TRIGGER_OCR"
    | "REBUILD_INDEX"
    | "REBUILD_VECTORS";
};

export function sendStatusUpdate(message: string): void {
  try {
    void chrome.runtime.sendMessage({
      type: "STATUS_UPDATE",
      payload: message,
    });
  } catch {
    // The UI may not be mounted while the offscreen runtime starts or stops.
  }
}

export function sendProcessStatus(payload: ProcessStatus): void {
  try {
    void chrome.runtime.sendMessage({
      type: "PROCESS_STATUS",
      payload: {
        ...payload,
        updatedAt: Date.now(),
      },
    });
  } catch {
    // Process status is advisory; the worker must continue when no UI listens.
  }
}
