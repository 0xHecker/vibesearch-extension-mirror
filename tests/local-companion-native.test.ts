import { expect, test } from "bun:test";
import { requestLocalNative, type LocalNativeMessageListener, type LocalNativeRuntime } from "@src/services/local-companion-native";
import { type LocalRequest, type LocalStatusResult } from "@src/services/local-companion-protocol";

const request = { version: 1, id: "6be26637-0c0c-4f79-85bb-74e0fd8f1c93", action: "status" } satisfies LocalRequest;
function runtimeHarness(onPost: (message: LocalRequest, emit: LocalNativeMessageListener, disconnect: () => void) => void) {
  const messageListeners = new Set<LocalNativeMessageListener>();
  const disconnectListeners = new Set<() => void>();
  let disconnects = 0;
  let hosts: string[] = [];
  const runtime: LocalNativeRuntime = {
    connectNative(host) {
      hosts.push(host);
      return {
        onMessage: { addListener(listener) { messageListeners.add(listener); }, removeListener(listener) { messageListeners.delete(listener); } },
        onDisconnect: { addListener(listener) { disconnectListeners.add(listener); }, removeListener(listener) { disconnectListeners.delete(listener); } },
        disconnect() { disconnects++; },
        postMessage(message) { onPost(message, (raw) => { for (const listener of messageListeners) listener(raw); }, () => { for (const listener of disconnectListeners) listener(); }); },
      };
    },
  };
  return { runtime, get disconnects() { return disconnects; }, get hosts() { return hosts; }, messageListeners, disconnectListeners };
}

test("native status request uses the fixed host and closes its port after the matching response", async () => {
  const result: LocalStatusResult = { ready: true, mode: "local", transport: "native-messaging", items: 1, passages: 1, generation: 1, accountRequired: false, cloudSync: "optional_explicit" };
  const harness = runtimeHarness((message, emit) => emit({ version: 1, id: message.id, ok: true, result }));
  expect(await requestLocalNative(request, harness.runtime)).toEqual(result);
  expect(harness.hosts).toEqual(["app.vibesearch.local"]);
  expect(harness.disconnects).toBe(1);
  expect(harness.messageListeners.size).toBe(0);
  expect(harness.disconnectListeners.size).toBe(0);
});

test("a wrong correlation id or malformed native envelope cannot acknowledge a request", async () => {
  for (const response of [{ version: 1, id: crypto.randomUUID(), ok: true, result: {} }, { id: request.id, ok: true, result: {} }]) {
    const harness = runtimeHarness((_message, emit) => emit(response));
    await expect(requestLocalNative(request, harness.runtime)).rejects.toThrow("INVALID_COMPANION_RESPONSE");
    expect(harness.disconnects).toBe(1);
  }
});

test("disconnect and correlated permanent failures are returned as typed errors", async () => {
  const disconnected = runtimeHarness((_message, _emit, disconnect) => disconnect());
  await expect(requestLocalNative(request, disconnected.runtime)).rejects.toThrow("COMPANION_UNAVAILABLE");
  const invalid = runtimeHarness((message, emit) => emit({ version: 1, id: message.id, ok: false, error: "NATIVE_INVALID_REQUEST" }));
  await expect(requestLocalNative(request, invalid.runtime)).rejects.toThrow("NATIVE_INVALID_REQUEST");
});
