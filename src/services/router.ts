import type { JsonValue } from "@src/common/json-value";
import { z } from "zod";

type ServiceMethod = (payload: any) => any;

type RegisteredService = {
  methods: ReadonlyMap<string, ServiceMethod>;
};

type RouterResponse =
  | { success: false; error: string }
  | { success: true; type: string; payload: any };

const routedMessageSchema = z.object({
  target: z.literal("offscreen"),
  isForwarded: z.literal(true),
  service: z.string().min(1),
  type: z.string().min(1),
  payload: z.json().optional(),
});

export class OffscreenRouter {
  private readonly services = new Map<string, RegisteredService>();

  registerService<
    MethodName extends string,
    Service extends Record<MethodName, ServiceMethod>,
  >(
    name: string,
    service: Service,
    options: { methods: readonly MethodName[] },
  ): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered.`);
    }
    if (options.methods.length === 0) {
      throw new Error(`Service "${name}" must expose at least one method.`);
    }

    const methods = new Map<string, ServiceMethod>();
    for (const methodName of options.methods) {
      methods.set(methodName, service[methodName].bind(service));
    }
    this.services.set(name, { methods });
    console.log(`Service registered: ${name}`);
  }

  private isTrustedForwarder(sender: chrome.runtime.MessageSender): boolean {
    if (sender.id !== chrome.runtime.id) return false;

    // UI pages (search/popup/options/etc.) should never directly forward
    // privileged calls. Service-worker senders commonly omit their URL.
    if (sender.tab) return false;
    const senderUrl = sender.url ?? "";
    if (!senderUrl) return true;

    try {
      const parsed = new URL(senderUrl);
      const path = parsed.pathname || "";
      if (path.includes("/src/pages/")) return false;
      return !path.endsWith(".html") || path.endsWith("/_generated_background_page.html");
    } catch {
      return false;
    }
  }

  listen(): void {
    chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
      const parsedMessage = routedMessageSchema.safeParse(rawMessage);
      if (!parsedMessage.success) return;

      if (!this.isTrustedForwarder(sender)) {
        sendResponse({ success: false, error: "UNAUTHORIZED_FORWARDER" });
        return true;
      }

      const { service, type, payload } = parsedMessage.data;
      void this.dispatch(service, type, payload, sendResponse);
      return true;
    });
  }

  private async dispatch(
    serviceName: string,
    methodName: string,
    payload: JsonValue | undefined,
    sendResponse: (response: RouterResponse) => void,
  ): Promise<void> {
    const registration = this.services.get(serviceName);
    if (!registration) {
      const error = `Service "${serviceName}" not found.`;
      console.error(error);
      sendResponse({ success: false, error });
      return;
    }

    const method = registration.methods.get(methodName);
    if (!method) {
      const error = `Method "${methodName}" is not exposed for service "${serviceName}".`;
      console.error(error);
      sendResponse({ success: false, error });
      return;
    }

    try {
      const result = await method(payload);
      sendResponse({
        success: true,
        type: `${serviceName}_${methodName}_COMPLETE`,
        payload: result,
      });
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "An unknown error occurred";
      console.error(`Error in service "${serviceName}", method "${methodName}":`, caught);
      sendResponse({ success: false, error });
    }
  }
}
