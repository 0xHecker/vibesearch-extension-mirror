export const CLOUD_SYNC_TOKEN_KEY = "vibesearch:firebaseIdToken";
export const CLOUD_SYNC_API_BASE_KEY = "vibesearch:apiBaseUrl";

const env = (import.meta as any).env ?? {};

export const DEVELOPMENT_CLOUD_AUTH_ENABLED =
  env.DEV === true && env.VITE_VIBESEARCH_DEV_AUTH !== "false";

export const DEVELOPMENT_CLOUD_AUTH_UID = (
  env.VITE_VIBESEARCH_DEV_UID || "user_demo"
).trim();

export const DEFAULT_VIBESEARCH_API_BASE = (
  env.VITE_VIBESEARCH_API_BASE ||
  env.VITE_API_BASE ||
  "https://vibesearch-api.watermelons.workers.dev"
).trim().replace(/\/+$/, "");

export const DEFAULT_VIBESEARCH_AUTH_URL = (
  env.VITE_VIBESEARCH_AUTH_URL ||
  "https://vibesearch-web.watermelons.workers.dev/extension-auth"
).trim();
