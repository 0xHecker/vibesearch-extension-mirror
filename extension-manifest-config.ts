type BaseManifest = {
  name?: string;
  key?: string;
  permissions?: string[];
  sandbox?: unknown;
  content_security_policy?: {
    extension_pages?: string;
    sandbox?: string;
  };
  [key: string]: unknown;
};

type BrowserManifest = {
  [key: string]: unknown;
};

export const createChromeManifest = (
  baseManifest: BaseManifest,
  chromeManifest: BrowserManifest,
  hostPermissions: string[],
  version: string
) => ({
  ...baseManifest,
  ...chromeManifest,
  host_permissions: [...hostPermissions],
  version,
});

export const createFirefoxManifest = (
  baseManifest: BaseManifest,
  firefoxManifest: BrowserManifest,
  hostPermissions: string[],
  version: string
) => {
  // Chrome's public key, offscreen permission, and manifest sandbox pages are
  // not Gecko manifest features. Firefox gets a stable identity from its
  // explicit gecko.id and hosts the local runtime in a background document.
  const {
    key: _chromePublicKey,
    sandbox: _chromeSandboxPages,
    content_security_policy: sharedCsp,
    permissions = [],
    ...sharedManifest
  } = baseManifest;

  return {
    ...sharedManifest,
    ...firefoxManifest,
    permissions: permissions.filter((permission) => permission !== "offscreen"),
    host_permissions: [...hostPermissions],
    content_security_policy: sharedCsp?.extension_pages
      ? { extension_pages: sharedCsp.extension_pages }
      : undefined,
    version,
  };
};
