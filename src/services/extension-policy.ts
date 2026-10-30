import { z } from "zod";

export const EXTENSION_POLICY_KEY = "vibesearch.extension-policy.v1";
export const EXTENSION_POLICY_READ_MESSAGE = "EXTENSION_POLICY_READ";
export const extensionPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["local-only", "legacy-browser"]),
  legacyCloudEnabled: z.boolean().default(false),
}).strict();
export type ExtensionPolicy = z.infer<typeof extensionPolicySchema>;
const policyResponseSchema = z.object({ success: z.literal(true), payload: extensionPolicySchema });
export const DEFAULT_EXTENSION_POLICY: ExtensionPolicy = { version: 1, mode: "legacy-browser", legacyCloudEnabled: true };
const FAIL_CLOSED_EXTENSION_POLICY: ExtensionPolicy = { version: 1, mode: "local-only", legacyCloudEnabled: false };

export function parseExtensionPolicy(value: unknown): ExtensionPolicy {
  if (value === undefined) return { ...DEFAULT_EXTENSION_POLICY };
  const parsed = extensionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : { ...FAIL_CLOSED_EXTENSION_POLICY };
}

export async function readExtensionPolicy(): Promise<ExtensionPolicy> {
  try {
    if (chrome.storage?.local) {
      return parseExtensionPolicy((await chrome.storage.local.get(EXTENSION_POLICY_KEY))[EXTENSION_POLICY_KEY]);
    }
    const response: unknown = await chrome.runtime.sendMessage({ target: "background", type: EXTENSION_POLICY_READ_MESSAGE });
    const parsed = policyResponseSchema.safeParse(response);
    return parsed.success ? parsed.data.payload : { ...FAIL_CLOSED_EXTENSION_POLICY };
  }
  catch { return { ...FAIL_CLOSED_EXTENSION_POLICY }; }
}

export async function writeExtensionPolicy(policy: ExtensionPolicy): Promise<void> {
  await chrome.storage.local.set({ [EXTENSION_POLICY_KEY]: extensionPolicySchema.parse(policy) });
}

export async function legacyBrowserEnabled(): Promise<boolean> {
  return (await readExtensionPolicy()).mode === "legacy-browser";
}
export async function legacyCloudEnabled(): Promise<boolean> {
  const policy = await readExtensionPolicy();
  return policy.mode === "legacy-browser" && policy.legacyCloudEnabled;
}
export async function requireLegacyBrowser(): Promise<void> {
  if (!await legacyBrowserEnabled()) throw new Error("LOCAL_ONLY_LEGACY_DISABLED");
}
export async function requireLegacyCloud(): Promise<void> {
  if (!await legacyCloudEnabled()) throw new Error("LOCAL_ONLY_CLOUD_DISABLED");
}
