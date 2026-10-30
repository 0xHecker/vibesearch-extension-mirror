import { LOCAL_COMPANION_HOST, LOCAL_MESSAGE_MAX_BYTES, LocalCompanionError, localRequestBytes, localRequestSchema, localResponseSchema, localSaveResultSchema, localSearchResultSchema, localStatusResultSchema, localReadResultSchema, localImportChunkResultSchema, localImportRecordResultSchema, localOriginalResultSchema, type LocalReadRequest, type LocalReadResult, type LocalNativeResult, type LocalRequest, type LocalSaveRequest, type LocalSaveResult, type LocalSearchRequest, type LocalSearchResult, type LocalStatusRequest, type LocalStatusResult } from "./local-companion-protocol";

export type LocalNativeMessageListener = (message: Parameters<Parameters<chrome.runtime.Port["onMessage"]["addListener"]>[0]>[0]) => void;

export interface LocalNativeRuntime {
  connectNative(host: string): {
    onMessage: { addListener(listener: LocalNativeMessageListener): void; removeListener(listener: LocalNativeMessageListener): void };
    onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
    disconnect(): void;
    postMessage(request: LocalRequest): void;
  };
  readonly lastError?: { message?: string };
}

export function requestLocalNative(request: LocalStatusRequest, runtime?: LocalNativeRuntime): Promise<LocalStatusResult>;
export function requestLocalNative(request: LocalSaveRequest, runtime?: LocalNativeRuntime): Promise<LocalSaveResult>;
export function requestLocalNative(request: LocalSearchRequest, runtime?: LocalNativeRuntime): Promise<LocalSearchResult>;
export function requestLocalNative(request: LocalReadRequest, runtime?: LocalNativeRuntime): Promise<LocalReadResult>;
export function requestLocalNative(request: Extract<LocalRequest, { action: "import-chunk" }>, runtime?: LocalNativeRuntime): Promise<import("zod").z.infer<typeof localImportChunkResultSchema>>;
export function requestLocalNative(request: Extract<LocalRequest, { action: "import-record" }>, runtime?: LocalNativeRuntime): Promise<import("zod").z.infer<typeof localImportRecordResultSchema>>;
export function requestLocalNative(request: Extract<LocalRequest, { action: "read-original" }>, runtime?: LocalNativeRuntime): Promise<import("zod").z.infer<typeof localOriginalResultSchema>>;
export function requestLocalNative(request: LocalRequest, runtime: LocalNativeRuntime = chrome.runtime): Promise<LocalNativeResult> {
  localRequestSchema.parse(request);
  if (localRequestBytes(request) > LOCAL_MESSAGE_MAX_BYTES) return Promise.reject(new LocalCompanionError("REQUEST_TOO_LARGE"));
  return new Promise((resolve, reject) => {
    let port: ReturnType<LocalNativeRuntime["connectNative"]>;
    try { port = runtime.connectNative(LOCAL_COMPANION_HOST); }
    catch { reject(new LocalCompanionError("COMPANION_UNAVAILABLE")); return; }
    let settled = false;
    const finish = (result: { ok: true; value: LocalNativeResult } | { ok: false; code: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try { port.disconnect(); } catch { /* The host may already have disconnected. */ }
      if (result.ok) resolve(result.value);
      else reject(new LocalCompanionError(result.code));
    };
    const onMessage: LocalNativeMessageListener = (message) => {
      const raw: unknown = message;
      if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > LOCAL_MESSAGE_MAX_BYTES) { finish({ ok: false, code: "INVALID_COMPANION_RESPONSE" }); return; }
      const parsed = localResponseSchema.safeParse(raw);
      if (!parsed.success || (parsed.data.id !== undefined && parsed.data.id !== request.id)) {
        finish({ ok: false, code: "INVALID_COMPANION_RESPONSE" }); return;
      }
      if (!parsed.data.ok) finish({ ok: false, code: parsed.data.error });
      else {
        const result = request.action === "status" ? localStatusResultSchema.safeParse(parsed.data.result)
          : request.action === "save" ? localSaveResultSchema.safeParse(parsed.data.result)
          : request.action === "search" ? localSearchResultSchema.safeParse(parsed.data.result)
          : request.action === "read" ? localReadResultSchema.safeParse(parsed.data.result)
          : request.action === "import-chunk" ? localImportChunkResultSchema.safeParse(parsed.data.result)
          : request.action === "import-record" ? localImportRecordResultSchema.safeParse(parsed.data.result)
          : localOriginalResultSchema.safeParse(parsed.data.result);
        if (!result.success || (request.action === "save" && "captureId" in result.data && result.data.captureId !== request.capture.id)) finish({ ok: false, code: "INVALID_COMPANION_RESPONSE" });
        else finish({ ok: true, value: result.data });
      }
    };
    const onDisconnect = () => {
      // Reading lastError suppresses Chrome's unchecked runtime error warning.
      void runtime.lastError;
      finish({ ok: false, code: "COMPANION_UNAVAILABLE" });
    };
    const timer = setTimeout(() => finish({ ok: false, code: "COMPANION_TIMEOUT" }), 15000);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try { port.postMessage(request); }
    catch { finish({ ok: false, code: "COMPANION_UNAVAILABLE" }); }
  });
}
