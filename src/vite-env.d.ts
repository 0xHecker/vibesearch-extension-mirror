/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IMPORT_MEDIA_UPLOAD_TOKEN?: string;
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  /** Base URL for the deployed vibesearch-api Worker (archiving, sync, …). */
  readonly VITE_API_BASE?: string;
  /** Firebase web config (same public values as apps/web) for cloud sign-in. */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  /** Dev-only test account (presence reveals the "Use test account" button). */
  readonly VITE_TEST_EMAIL?: string;
  readonly VITE_TEST_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
