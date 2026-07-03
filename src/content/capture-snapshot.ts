/**
 * capture-snapshot.ts
 *
 * First-class, highest-fidelity page capture for Vibesearch's Wayback-style
 * offline archiving. `captureSingleFileSnapshot` serializes the *live, rendered*
 * DOM of the current tab into ONE self-contained HTML string — a lightweight,
 * dependency-free take on the "SingleFile" idea (we intentionally do NOT pull in
 * the heavy `single-file` npm package).
 *
 * IMPORTANT — injection contract:
 * This function is injected into the page via `chrome.scripting.executeScript({
 * func: captureSingleFileSnapshot, args: [options] })`. Chrome serializes the
 * function with `Function.prototype.toString()` and re-parses it inside the page,
 * so the function MUST be entirely self-contained: every helper lives inside the
 * function body and it references NO module-scope symbols or imports. Only
 * `import type` (erased at compile time) may appear at module scope.
 *
 * Philosophy: "preserves everything" — CSS, fonts, media and styles are inlined
 * best-effort; a single failed resource must never abort the capture. Anything
 * we cannot inline degrades to an absolute hotlink (still resolvable via the
 * injected `<base href>`), and the capture always returns *some* HTML.
 */

export interface CaptureSnapshotOptions {
  /** Max size for a single inlined resource before we skip it. Default 1 MiB. */
  perResourceMaxBytes?: number;
  /** Total inlining budget across the whole page. Default 15 MiB. */
  totalMaxBytes?: number;
  /** Per-resource network timeout in ms. Default 8000. */
  fetchTimeoutMs?: number;
  /** Banner label shown on the archived page. Default "Archived by Vibesearch". */
  bannerLabel?: string;
  /** Caller-provided capture timestamp (ISO). Defaults to capture time. */
  capturedAtIso?: string;
  /** When set, also trigger an in-page download of the single-file HTML (local export). */
  downloadFilename?: string;
}

export interface CaptureSnapshotStats {
  imagesInlined: number;
  imagesSkipped: number;
  stylesheetsInlined: number;
  stylesheetsFailed: number;
  cssResourcesInlined: number;
  canvasesSnapshotted: number;
  formFieldsMaterialized: number;
  scriptsRemoved: number;
  eventAttrsRemoved: number;
}

export interface CaptureSnapshotResult {
  ok: boolean;
  html: string;
  /** UTF-8 byte size of `html`. */
  byteSize: number;
  /** True when the inlining budget was hit and some resources were skipped. */
  truncated: boolean;
  stats: CaptureSnapshotStats;
  title: string;
  url: string;
  capturedAt: string;
  error?: string;
}

/**
 * Serialize the live rendered document into a single self-contained HTML string.
 * Runs inside the target page. Never throws — returns a best-effort result.
 */
export async function captureSingleFileSnapshot(
  options: CaptureSnapshotOptions = {}
): Promise<CaptureSnapshotResult> {
  const PER_RESOURCE_MAX = options.perResourceMaxBytes ?? 1024 * 1024; // 1 MiB
  const TOTAL_MAX = options.totalMaxBytes ?? 15 * 1024 * 1024; // 15 MiB
  const FETCH_TIMEOUT = options.fetchTimeoutMs ?? 8000;
  const BANNER_LABEL = options.bannerLabel ?? "Archived by Vibesearch";
  const capturedAt = options.capturedAtIso ?? new Date().toISOString();

  const pageUrl = location.href;
  const pageTitle = document.title || pageUrl;

  const stats: CaptureSnapshotStats = {
    imagesInlined: 0,
    imagesSkipped: 0,
    stylesheetsInlined: 0,
    stylesheetsFailed: 0,
    cssResourcesInlined: 0,
    canvasesSnapshotted: 0,
    formFieldsMaterialized: 0,
    scriptsRemoved: 0,
    eventAttrsRemoved: 0,
  };

  let usedBytes = 0;
  let truncated = false;

  const byteSizeOf = (text: string): number => {
    try {
      return new Blob([text]).size;
    } catch {
      return text.length;
    }
  };

  try {
    // ---- resource inlining primitives -----------------------------------
    const dataUriCache = new Map<string, string | null>();

    const absolutize = (url: string | null | undefined, base: string): string | null => {
      if (!url) return null;
      const trimmed = String(url).trim();
      if (!trimmed) return null;
      try {
        return new URL(trimmed, base || pageUrl).href;
      } catch {
        return null;
      }
    };

    const readBlobAsDataUri = (blob: Blob): Promise<string | null> =>
      new Promise((resolve) => {
        try {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        } catch {
          resolve(null);
        }
      });

    const fetchWithTimeout = async (url: string): Promise<Response | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        return await fetch(url, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "force-cache",
          redirect: "follow",
        });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    /** Fetch a resource and return it as a data: URI, honoring the byte budget. */
    const toDataUri = async (rawUrl: string | null | undefined, base: string): Promise<string | null> => {
      const abs = absolutize(rawUrl, base);
      if (!abs) return null;
      if (abs.startsWith("data:")) return abs;
      if (!/^https?:/i.test(abs)) return null;
      if (dataUriCache.has(abs)) return dataUriCache.get(abs) ?? null;
      if (usedBytes >= TOTAL_MAX) {
        truncated = true;
        dataUriCache.set(abs, null);
        return null;
      }

      let result: string | null = null;
      try {
        const response = await fetchWithTimeout(abs);
        if (response && response.ok) {
          const blob = await response.blob();
          if (blob.size > PER_RESOURCE_MAX || usedBytes + blob.size > TOTAL_MAX) {
            truncated = true;
          } else {
            const dataUri = await readBlobAsDataUri(blob);
            if (dataUri) {
              usedBytes += blob.size;
              result = dataUri;
            }
          }
        }
      } catch {
        result = null;
      }
      dataUriCache.set(abs, result);
      return result;
    };

    // ---- CSS handling ----------------------------------------------------
    const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

    const inlineCssResources = async (cssText: string, base: string): Promise<string> => {
      if (!cssText || cssText.indexOf("url(") === -1) return cssText;
      const rawUrls = new Set<string>();
      let match: RegExpExecArray | null;
      CSS_URL_RE.lastIndex = 0;
      while ((match = CSS_URL_RE.exec(cssText))) {
        const raw = (match[2] || "").trim();
        if (!raw || raw.startsWith("data:") || raw.startsWith("#")) continue;
        rawUrls.add(raw);
      }
      if (rawUrls.size === 0) return cssText;

      // Map each url() to a data: URI when we can inline it, otherwise to an
      // absolute URL so it still hotlinks correctly (a relative url() from a
      // cross-origin sheet would otherwise resolve against the injected <base>).
      const replacements = new Map<string, string>();
      await Promise.all(
        Array.from(rawUrls).map(async (raw) => {
          const dataUri = await toDataUri(raw, base);
          if (dataUri) {
            replacements.set(raw, dataUri);
          } else {
            const abs = absolutize(raw, base);
            if (abs) replacements.set(raw, abs);
          }
        })
      );
      if (replacements.size === 0) return cssText;

      CSS_URL_RE.lastIndex = 0;
      return cssText.replace(CSS_URL_RE, (whole, _quote: string, raw: string) => {
        const replacement = replacements.get((raw || "").trim());
        if (!replacement) return whole;
        if (replacement.startsWith("data:")) stats.cssResourcesInlined++;
        return 'url("' + replacement + '")';
      });
    };

    const IMPORT_RULE = 3; // CSSRule.IMPORT_RULE

    const serializeStyleSheet = async (sheet: CSSStyleSheet, depth: number): Promise<string> => {
      if (depth > 4) return "";
      const base = sheet.href || pageUrl;
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        rules = null; // cross-origin — read blocked, fall back to fetching href
      }

      if (rules) {
        let out = "";
        for (const rule of Array.from(rules)) {
          if (rule.type === IMPORT_RULE) {
            const imported = (rule as CSSImportRule).styleSheet;
            if (imported) {
              out += (await serializeStyleSheet(imported, depth + 1)) + "\n";
              continue;
            }
          }
          out += rule.cssText + "\n";
        }
        return inlineCssResources(out, base);
      }

      if (sheet.href) {
        const response = await fetchWithTimeout(sheet.href);
        if (response && response.ok) {
          const text = await response.text();
          return inlineCssResources(text, sheet.href);
        }
      }
      return "";
    };

    // ---- snapshot the live-only state synchronously ----------------------
    // Reads that depend on live layout/state (currentSrc, canvas pixels, form
    // values) are gathered up front so the async inlining window can't skew them.
    const clone = document.documentElement.cloneNode(true) as HTMLElement;

    const liveImages = Array.from(document.querySelectorAll("img"));
    const cloneImages = Array.from(clone.querySelectorAll("img"));
    const imageSources = liveImages.map(
      (img) => img.currentSrc || img.getAttribute("src") || img.src || ""
    );

    const liveCanvases = Array.from(document.querySelectorAll("canvas"));
    const cloneCanvases = Array.from(clone.querySelectorAll("canvas"));
    const canvasData = liveCanvases.map((canvas) => {
      try {
        return (canvas as HTMLCanvasElement).toDataURL();
      } catch {
        return null; // tainted canvas — skip
      }
    });

    const liveInputs = Array.from(document.querySelectorAll("input"));
    const cloneInputs = Array.from(clone.querySelectorAll("input"));
    const liveTextareas = Array.from(document.querySelectorAll("textarea"));
    const cloneTextareas = Array.from(clone.querySelectorAll("textarea"));
    const liveSelects = Array.from(document.querySelectorAll("select"));
    const cloneSelects = Array.from(clone.querySelectorAll("select"));

    // ---- strip active content on the clone -------------------------------
    clone.querySelectorAll("script").forEach((node) => {
      node.remove();
      stats.scriptsRemoved++;
    });
    clone
      .querySelectorAll(
        'link[rel~="preload"],link[rel~="modulepreload"],link[rel~="prefetch"],link[rel~="prerender"]'
      )
      .forEach((node) => node.remove());

    clone.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
          stats.eventAttrsRemoved++;
        } else if (
          (name === "href" || name === "src" || name === "xlink:href") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.setAttribute(attr.name, "#");
        }
      }
    });

    // ---- inline all stylesheets into a single <style> --------------------
    clone
      .querySelectorAll('style,link[rel~="stylesheet"]')
      .forEach((node) => node.remove());

    const sheets = Array.from(document.styleSheets).filter(
      (sheet): sheet is CSSStyleSheet => sheet instanceof CSSStyleSheet
    );
    const cssChunks: string[] = [];
    for (const sheet of sheets) {
      try {
        if (sheet.disabled) continue;
        let text = await serializeStyleSheet(sheet, 0);
        if (text && text.trim()) {
          const mediaText = sheet.media && sheet.media.mediaText ? sheet.media.mediaText.trim() : "";
          if (mediaText && mediaText !== "all") {
            text = "@media " + mediaText + " {\n" + text + "\n}";
          }
          cssChunks.push(text);
          stats.stylesheetsInlined++;
        } else {
          stats.stylesheetsFailed++;
        }
      } catch {
        stats.stylesheetsFailed++;
      }
    }

    const cloneHead = clone.querySelector("head") || clone;
    if (cssChunks.length > 0) {
      const styleEl = document.createElement("style");
      styleEl.setAttribute("data-vibesearch-archive-styles", "");
      styleEl.textContent = cssChunks.join("\n\n");
      cloneHead.appendChild(styleEl);
    }

    // ---- inline images ---------------------------------------------------
    await Promise.all(
      imageSources.map(async (src, index) => {
        const target = cloneImages[index];
        if (!target) return;
        target.removeAttribute("loading");
        target.removeAttribute("srcset");
        if (!src) return;
        const dataUri = await toDataUri(src, pageUrl);
        if (dataUri) {
          target.setAttribute("src", dataUri);
          stats.imagesInlined++;
        } else {
          const abs = absolutize(src, pageUrl);
          if (abs) target.setAttribute("src", abs); // hotlink fallback
          stats.imagesSkipped++;
        }
      })
    );
    // <picture><source srcset> references candidates we didn't inline; drop them
    // so the browser can't re-select a non-inlined image over our <img src>.
    clone.querySelectorAll("picture source").forEach((node) => node.remove());

    // Inline background images declared via inline style attributes.
    await Promise.all(
      Array.from(clone.querySelectorAll<HTMLElement>('[style*="url("]')).map(async (el) => {
        const style = el.getAttribute("style");
        if (!style) return;
        const replaced = await inlineCssResources(style, pageUrl);
        if (replaced !== style) el.setAttribute("style", replaced);
      })
    );

    // ---- snapshot <canvas> as <img> --------------------------------------
    canvasData.forEach((data, index) => {
      const target = cloneCanvases[index];
      if (!target || !data) return;
      const img = document.createElement("img");
      img.setAttribute("src", data);
      img.setAttribute("data-vibesearch-canvas", "");
      const width = target.getAttribute("width");
      const height = target.getAttribute("height");
      if (width) img.setAttribute("width", width);
      if (height) img.setAttribute("height", height);
      const style = target.getAttribute("style");
      if (style) img.setAttribute("style", style);
      target.replaceWith(img);
      stats.canvasesSnapshotted++;
    });

    // ---- materialize current form values ---------------------------------
    liveInputs.forEach((el, index) => {
      const target = cloneInputs[index];
      if (!target) return;
      const type = (el.getAttribute("type") || el.type || "text").toLowerCase();
      if (type === "password" || type === "file") return; // never persist secrets / paths
      if (type === "checkbox" || type === "radio") {
        if (el.checked) target.setAttribute("checked", "");
        else target.removeAttribute("checked");
      } else {
        target.setAttribute("value", el.value ?? "");
      }
      stats.formFieldsMaterialized++;
    });
    liveTextareas.forEach((el, index) => {
      const target = cloneTextareas[index];
      if (!target) return;
      target.textContent = el.value ?? "";
      stats.formFieldsMaterialized++;
    });
    liveSelects.forEach((el, index) => {
      const target = cloneSelects[index];
      if (!target) return;
      const selectedIndex = el.selectedIndex;
      const options = target.querySelectorAll("option");
      options.forEach((option, optionIndex) => {
        if (optionIndex === selectedIndex) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      });
      stats.formFieldsMaterialized++;
    });

    // ---- <base href> + charset ------------------------------------------
    const head = clone.querySelector("head");
    if (head) {
      head.querySelectorAll("base").forEach((node) => node.remove());
      const base = document.createElement("base");
      base.setAttribute("href", document.baseURI || pageUrl);
      head.insertBefore(base, head.firstChild);
      if (!head.querySelector("meta[charset]")) {
        const charset = document.createElement("meta");
        charset.setAttribute("charset", "utf-8");
        head.insertBefore(charset, head.firstChild);
      }
    }

    // ---- "Archived by Vibesearch" banner ---------------------------------
    const body = clone.querySelector("body");
    if (body) {
      let hostLabel = pageUrl;
      try {
        hostLabel = new URL(pageUrl).hostname.replace(/^www\./, "");
      } catch {
        hostLabel = pageUrl;
      }
      let dateLabel = capturedAt;
      try {
        dateLabel = new Date(capturedAt).toLocaleString();
      } catch {
        dateLabel = capturedAt;
      }

      const banner = document.createElement("div");
      banner.setAttribute("data-vibesearch-archive-banner", "");
      banner.setAttribute(
        "style",
        [
          "all:initial",
          "position:sticky",
          "top:0",
          "left:0",
          "right:0",
          "z-index:2147483647",
          "display:flex",
          "align-items:center",
          "gap:10px",
          "box-sizing:border-box",
          "width:100%",
          "padding:8px 16px",
          "background:linear-gradient(90deg,#fffef8 0%,#fff6f6 100%)",
          "border-bottom:1px solid #f1d9d9",
          "box-shadow:0 1px 0 rgba(15,23,42,0.04)",
          'font-family:"Neutral Sans",ui-sans-serif,system-ui,-apple-system,sans-serif',
          "font-size:12.5px",
          "line-height:1.4",
          "color:#212121",
        ].join(";")
      );

      const dot = document.createElement("span");
      dot.setAttribute(
        "style",
        [
          "flex:0 0 auto",
          "width:9px",
          "height:9px",
          "border-radius:50%",
          "background:#ff4d4d",
          "box-shadow:0 0 0 3px #ffe5e5",
        ].join(";")
      );

      const label = document.createElement("span");
      label.setAttribute("style", "font-weight:600;color:#212121;white-space:nowrap");
      label.textContent = BANNER_LABEL;

      const middot = document.createElement("span");
      middot.setAttribute("style", "color:#d4a5a5");
      middot.textContent = "·";

      const link = document.createElement("a");
      link.setAttribute("href", pageUrl);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.setAttribute(
        "style",
        [
          "color:#787878",
          "text-decoration:none",
          "overflow:hidden",
          "text-overflow:ellipsis",
          "white-space:nowrap",
          "max-width:45vw",
        ].join(";")
      );
      link.textContent = hostLabel;

      const middot2 = document.createElement("span");
      middot2.setAttribute("style", "color:#d4a5a5");
      middot2.textContent = "·";

      const date = document.createElement("span");
      date.setAttribute("style", "color:#a1a1a1;white-space:nowrap;margin-left:auto");
      date.textContent = dateLabel;

      banner.appendChild(dot);
      banner.appendChild(label);
      banner.appendChild(middot);
      banner.appendChild(link);
      banner.appendChild(middot2);
      banner.appendChild(date);
      body.insertBefore(banner, body.firstChild);
    }

    // ---- serialize -------------------------------------------------------
    let doctype = "<!DOCTYPE html>";
    try {
      const dt = document.doctype;
      if (dt) {
        doctype =
          "<!DOCTYPE " +
          dt.name +
          (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : "") +
          (!dt.publicId && dt.systemId ? " SYSTEM" : "") +
          (dt.systemId ? ' "' + dt.systemId + '"' : "") +
          ">";
      }
    } catch {
      doctype = "<!DOCTYPE html>";
    }

    const html = doctype + "\n" + clone.outerHTML;

    // ---- optional: download the single-file HTML locally (no account needed) --
    if (options.downloadFilename) {
      try {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = options.downloadFilename;
        a.rel = "noopener";
        a.style.display = "none";
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => {
          try {
            URL.revokeObjectURL(objectUrl);
            a.remove();
          } catch {
            /* noop */
          }
        }, 5000);
      } catch {
        /* best-effort — the local download is optional */
      }
    }

    return {
      ok: true,
      html,
      byteSize: byteSizeOf(html),
      truncated,
      stats,
      title: pageTitle,
      url: pageUrl,
      capturedAt,
    };
  } catch (error) {
    // Last-resort fallback — never abort a capture over a single failure.
    try {
      const fallback = "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
      return {
        ok: false,
        html: fallback,
        byteSize: byteSizeOf(fallback),
        truncated,
        stats,
        title: pageTitle,
        url: pageUrl,
        capturedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    } catch (fatal) {
      return {
        ok: false,
        html: "",
        byteSize: 0,
        truncated,
        stats,
        title: pageTitle,
        url: pageUrl,
        capturedAt,
        error: fatal instanceof Error ? fatal.message : String(fatal),
      };
    }
  }
}
