import { parseJsonValue, type JsonValue } from "@src/common/json-value";

export type RuntimeMessage = {
  target: "offscreen" | "background";
  type: string;
  service?: string;
  payload?: object;
};

/** Send an extension RPC with a hard deadline and parse its JSON boundary. */
export async function sendRuntimeMessage(
  message: RuntimeMessage,
  timeoutMs: number,
): Promise<JsonValue> {
  let timeoutId: number | null = null;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("Request timed out")),
          timeoutMs,
        );
      }),
    ]);
    return parseJsonValue(response);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}
