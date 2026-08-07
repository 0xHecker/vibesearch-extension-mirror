import { expect, test } from "bun:test";
import { OcrSandboxClient, OcrService } from "@src/services/ocr.service";

test("OcrSandboxClient removes its iframe and listener when released", async () => {
  const runtime = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
    document?: Document;
    chrome?: typeof chrome;
  };
  const previousWindow = runtime.window;
  const previousDocument = runtime.document;
  const previousChrome = runtime.chrome;

  const listeners = new Set<EventListenerOrEventListenerObject>();
  let appended = 0;
  let removed = 0;
  const frame = {
    src: "",
    style: { display: "" },
    contentWindow: { postMessage() {} },
    setAttribute() {},
    remove() {
      removed += 1;
    },
  } as unknown as HTMLIFrameElement;

  runtime.window = {
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
      listeners.delete(listener);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window & typeof globalThis;
  runtime.document = {
    createElement: () => frame,
    body: {
      appendChild() {
        appended += 1;
        return frame;
      },
    },
  } as unknown as Document;
  runtime.chrome = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  } as unknown as typeof chrome;

  try {
    const client = new OcrSandboxClient(async () => new Response());
    const preparing = client.prepare();

    expect(appended).toBe(1);
    expect(listeners.size).toBe(1);

    client.dispose("test release");

    await expect(preparing).rejects.toThrow("test release");
    expect(removed).toBe(1);
    expect(listeners.size).toBe(0);
  } finally {
    if (previousWindow === undefined) delete runtime.window;
    else runtime.window = previousWindow;
    if (previousDocument === undefined) delete runtime.document;
    else runtime.document = previousDocument;
    if (previousChrome === undefined) delete runtime.chrome;
    else runtime.chrome = previousChrome;
  }
});

test("OcrService waits for every active OCR operation before releasing the sandbox", async () => {
  const runtime = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  const previousWindow = runtime.window;
  runtime.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as unknown as Window & typeof globalThis;

  try {
    const service = new OcrService() as any;
    let disposeCount = 0;
    service.IDLE_RELEASE_MS = 5;
    service.sandbox = {
      dispose() {
        disposeCount += 1;
      },
    };

    let finishOperation!: () => void;
    const activeOperation = service.withActiveOperation(
      () => new Promise<void>((resolve) => {
        finishOperation = resolve;
      })
    );
    service.scheduleIdleRelease();
    await Bun.sleep(20);
    expect(disposeCount).toBe(0);

    finishOperation();
    await activeOperation;
    await Bun.sleep(20);
    expect(disposeCount).toBe(1);
  } finally {
    if (previousWindow === undefined) delete runtime.window;
    else runtime.window = previousWindow;
  }
});
