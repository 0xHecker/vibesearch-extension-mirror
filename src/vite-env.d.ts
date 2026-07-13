/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IMPORT_MEDIA_UPLOAD_TOKEN?: string;
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly VITE_VIBESEARCH_API_BASE?: string;
  readonly VITE_VIBESEARCH_AUTH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "single-file-core/single-file.js" {
  export function getPageData(
    options?: Record<string, unknown>,
    initOptions?: { fetch?: typeof fetch; frameFetch?: typeof fetch },
    doc?: Document,
    win?: Window,
  ): Promise<Record<string, unknown>>;
}
