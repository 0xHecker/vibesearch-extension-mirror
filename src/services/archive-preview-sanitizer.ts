const ACTIVE_CONTAINERS = "script,noscript,iframe,object,embed,frame";
const EXTENSION_UI_SELECTOR = [
  "#__vibesearch_toast_root__",
  "#__vibesearch_picker_root__",
  "#__vibesearch_screenshot_selector__",
].join(",");
const OFFLINE_RESOURCE_ATTRIBUTES = new Set([
  "src",
  "poster",
  "background",
]);

const isEmbeddedResource = (value: string): boolean =>
  value.trim().toLowerCase().startsWith("data:");

/** Remove CSS fetches while retaining SingleFile's embedded data resources. */
export const stripArchivePreviewCssNetworkLoads = (css: string): string => {
  const withoutImports = css.replace(
    /@import\s+(?:url\(\s*(['"]?)[^)]*\1\s*\)|(['"])[^'"]+\2)[^;]*;?/gi,
    "/* external @import removed */",
  );
  return withoutImports.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, _quote: string, ref: string) => {
      const value = ref.trim().toLowerCase();
      return value.startsWith("data:") || value.startsWith("#") ? match : "url('')";
    },
  );
};

const policyMeta = (policy: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
const viewportStyle = (viewportCss: string): string =>
  `<style data-vs-archive-viewport>${viewportCss}</style>`;

/**
 * Bun has no DOMParser. This fallback keeps non-browser tests honest; the
 * extension always takes the structured DOM path below.
 */
const sanitizeWithoutDom = (html: string, policy: string, viewportCss: string): string => {
  let output = html
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*\bid=["']__vibesearch_(?:toast|picker)_root__["'])[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*\bid=["']__vibesearch_screenshot_selector__["'])[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|noscript|iframe|object|frame)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:script|noscript|iframe|object|embed|frame|base|link)\b[^>]*\/?\s*>/gi, "")
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=)[^>]*\/?\s*>/gi, "")
    .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<(a|area)\b([^>]*)>/gi, (tag, name: string, attrs: string) =>
      /\bhref\s*=/i.test(attrs)
        ? `<${name} tabindex="-1"${attrs.replace(/\s+tabindex\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")}>`
        : tag)
    .replace(
      /\s+(src|poster|background|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (match, name: string, _quoted: string, double: string, single: string, bare: string) => {
        const value = double ?? single ?? bare ?? "";
        return name.toLowerCase() !== "srcset" && isEmbeddedResource(value) ? match : "";
      },
    )
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_match, attrs, css) =>
      `<style${attrs}>${stripArchivePreviewCssNetworkLoads(css)}</style>`)
    .replace(
      /\s+style\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (_match, quoted: string, double: string, single: string) => {
        const quote = quoted[0];
        return ` style=${quote}${stripArchivePreviewCssNetworkLoads(double ?? single ?? "")}${quote}`;
      },
    )
    .replace(/^\s*<!doctype\b[^>]*>\s*/i, "");

  const policyHtml = policyMeta(policy);
  const viewportHtml = viewportStyle(viewportCss);
  if (/<html\b/i.test(output)) {
    output = output.replace(/<html\b([^>]*)>/i, '<html data-vs-archive-document$1>');
    output = /<head\b[^>]*>/i.test(output)
      ? output
          .replace(/<head\b([^>]*)>/i, `<head$1>${policyHtml}`)
          .replace(/<\/head\s*>/i, `${viewportHtml}</head>`)
      : output.replace(/<html\b([^>]*)>/i, `<html$1><head>${policyHtml}${viewportHtml}</head>`);
    return `<!doctype html>${output}`;
  }
  return `<!doctype html><html data-vs-archive-document><head>${policyHtml}${viewportHtml}</head><body>${output}</body></html>`;
};

export const sanitizeArchivePreviewHtml = (
  html: string,
  policy: string,
  viewportCss: string,
): string => {
  if (typeof DOMParser === "undefined") {
    return sanitizeWithoutDom(html, policy, viewportCss);
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll(EXTENSION_UI_SELECTOR).forEach((element) => element.remove());
  parsed.querySelectorAll(ACTIVE_CONTAINERS).forEach((element) => element.remove());
  parsed.querySelectorAll("frameset,form").forEach((element) => element.replaceWith(...element.childNodes));
  parsed.querySelectorAll("base,link,meta[http-equiv]").forEach((element) => element.remove());

  for (const element of parsed.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "srcdoc" || name === "ping" || name === "contenteditable") {
        element.removeAttribute(attribute.name);
      } else if (name === "inert") {
        element.removeAttribute(attribute.name);
      } else if (name === "srcset") {
        element.removeAttribute(attribute.name);
      } else if (OFFLINE_RESOURCE_ATTRIBUTES.has(name) && !isEmbeddedResource(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === "style") {
        element.setAttribute(attribute.name, stripArchivePreviewCssNetworkLoads(attribute.value));
      } else if (
        (name === "href" || name === "xlink:href") &&
        ["image", "use", "feimage"].includes(element.localName.toLowerCase()) &&
        !isEmbeddedResource(value) &&
        !value.startsWith("#")
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  parsed.querySelectorAll("style").forEach((element) => {
    element.textContent = stripArchivePreviewCssNetworkLoads(element.textContent || "");
  });
  parsed.querySelectorAll("input,button,select,textarea").forEach((element) => {
    element.setAttribute("disabled", "");
  });
  parsed.querySelectorAll("a[href],area[href]").forEach((element) => {
    element.setAttribute("tabindex", "-1");
  });
  for (const root of [parsed.documentElement, parsed.body]) {
    root.style.removeProperty("overflow");
    root.style.removeProperty("overflow-x");
    root.style.removeProperty("overflow-y");
    root.style.removeProperty("overscroll-behavior");
  }
  parsed.documentElement.removeAttribute("inert");
  parsed.documentElement.setAttribute("data-vs-archive-document", "");
  parsed.head.insertAdjacentHTML("afterbegin", policyMeta(policy));
  parsed.head.insertAdjacentHTML("beforeend", viewportStyle(viewportCss));
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
};

export const sanitizeArchivePreviewBlob = async (
  source: Blob,
  policy: string,
  viewportCss: string,
): Promise<Blob> => new Blob(
  [sanitizeArchivePreviewHtml(await source.text(), policy, viewportCss)],
  { type: "text/html; charset=utf-8" },
);
