/**
 * Triple-Lock Static ("Sans-JavaScript") HTML Preview Sanitizer (`D4`).
 *
 * Layer 1 (`DOMParser` inert sanitizer & script detector): parses raw HTML into a detached inert
 * document, records script/event-handler/SPA indicators for the calm disclosure banner, strips
 * active markup/handlers/external fetches/CSS imports, disarms non-fragment navigation, replaces
 * unverified/external images with placeholders, and runs an idempotent second-pass re-parse against
 * mXSS mutations before prepending Layer 2's restrictive CSP + no-referrer `<meta>` tags.
 *
 * Layer 3 is enforced by the preview container (`<iframe sandbox="" srcdoc={...}>`) and host CSP.
 */

export const MAX_MARKDOWN_RENDER_BYTES = 512 * 1024;
export const MAX_STATIC_HTML_NODES = 15_000;

export const STATIC_HTML_IFRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

export type StaticHtmlDynamicReason =
  | 'script_tag'
  | 'event_handler'
  | 'javascript_url'
  | 'spa_mount_root';

export type StaticHtmlAnalysis = {
  srcdoc: string;
  nodeCount: number;
  fallbackToSource: boolean;
  fallbackReason?: string;
  scriptsDetected: boolean;
  spaMountLikely: boolean;
  externalImagesHidden: boolean;
  reasons: StaticHtmlDynamicReason[];
};

const SAFE_RASTER_DATA_IMAGE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/i;

const SAFE_DATA_FONT =
  /^data:(?:font\/(?:woff2?|ttf|otf|sfnt)|application\/font-(?:woff|ttf|sfnt)|application\/vnd\.ms-fontobject);base64,[A-Za-z0-9+/=]+$/i;

const DANGEROUS_SCHEME_PATTERN = /^(?:javascript|vbscript|file|blob|filesystem):|^data:text\/html/i;

const STRIPPED_TAGS = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'portal',
  'template',
  'foreignobject',
  'math',
  'audio',
  'video',
  'source',
  'track',
]);

const STRIPPED_IN_SVG_TAGS = new Set([
  'script',
  'style',
  'animate',
  'animatemotion',
  'animatetransform',
  'set',
  'mpath',
  'discard',
  'handler',
  'listener',
  'use',
  'image',
  'foreignobject',
]);

const URL_BEARING_ATTRS = new Set([
  'href',
  'src',
  'xlink:href',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'srcdoc',
  'srcset',
  'imagesrcset',
  'cite',
  'longdesc',
  'usemap',
  'ping',
]);

const SPA_MOUNT_IDS = new Set(['root', 'app', '__next', '__nuxt', 'svelte', 'main-app']);

const normalizeSchemeProbe = (value: string): string => {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0x20 && code !== 0x7f && !/\s/.test(value[i]!)) {
      out += value[i]!;
    }
  }
  return out;
};

const hasWhitespaceOrControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i]!)) return true;
  }
  return false;
};

export const isDangerousUrl = (raw: string): boolean =>
  DANGEROUS_SCHEME_PATTERN.test(normalizeSchemeProbe(raw));

export const isSafeRasterDataImageUrl = (raw: string): boolean => {
  const collapsed = raw.trim().replace(/\s+/g, '');
  return SAFE_RASTER_DATA_IMAGE.test(collapsed);
};

const isSafeCssUrl = (rawInner: string): boolean => {
  const cleaned = rawInner.trim().replace(/['"]/g, '').replace(/\s+/g, '');
  return SAFE_RASTER_DATA_IMAGE.test(cleaned) || SAFE_DATA_FONT.test(cleaned);
};

/** Decode simple CSS backslash escapes so obfuscated `@\69mport` or `u\72l(...)` cannot slip past regexes. */
const decodeCssEscapes = (css: string): string =>
  css.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n\r\f0-9a-fA-F])/g, (_full, hex?: string, literal?: string) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return '';
    }
    return literal ?? '';
  });

/**
 * Strip CSS comments, `@import` rules, IE `expression()` / `behavior`, `-moz-binding`,
 * `</style` breakouts, and non-data `url(...)` references from `<style>` blocks and `style=""`.
 */
export const sanitizeCssText = (rawCss: string): string => {
  const withoutComments = decodeCssEscapes(rawCss).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutBreakout = withoutComments.replace(/<\s*\/?\s*(?:style|script)\b[^>]*>/gi, '');
  const withoutImports = withoutBreakout
    .replace(/@import\b[\s\S]*?(?:;|\r?\n|$)/gi, ' ')
    .replace(/@namespace\b[\s\S]*?(?:;|\r?\n|$)/gi, ' ');

  // Strip balanced/unbalanced `url(...)` unless it resolves cleanly to safe raster image / font data URI.
  const safeUrls = withoutImports.replace(/url\s*\(([\s\S]*?)\)/gi, (_match, inner: string) =>
    isSafeCssUrl(inner) ? `url("${inner.trim().replace(/['"\\]/g, '')}")` : 'none'
  );

  // Neutralize legacy dynamic CSS bindings (avoid leaving literal `expression(` substring).
  return safeUrls
    .replace(/expression\s*\(/gi, 'blocked-expr(')
    .replace(/-moz-binding\s*:/gi, 'blocked-prop:')
    .replace(/\bbehavior\s*:/gi, 'blocked-prop:')
    .trim();
};

const buildInertFallbackSrcdoc = (title: string, message: string): string => {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<!doctype html>',
    '<html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${STATIC_HTML_IFRAME_CSP}" />`,
    '<meta name="referrer" content="no-referrer" />',
    `<title>${escape(title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;padding:24px;line-height:1.5;color:#e5e5e5;background:#161616;}p{max-width:60ch;}</style>',
    `</head><body><p>${escape(message)}</p></body></html>`,
  ].join('');
};

const detectDynamicFeatures = (doc: Document): {
  reasons: StaticHtmlDynamicReason[];
  spaMountLikely: boolean;
} => {
  const reasons = new Set<StaticHtmlDynamicReason>();
  const scriptElements = doc.querySelectorAll('script');
  const hasScriptTag = scriptElements.length > 0;
  if (hasScriptTag) {
    reasons.add('script_tag');
  }

  let hasModuleOrBundleScript = false;
  scriptElements.forEach((script) => {
    const type = (script.getAttribute('type') ?? '').toLowerCase();
    const src = (script.getAttribute('src') ?? '').trim();
    if (type === 'module' || Boolean(src)) {
      hasModuleOrBundleScript = true;
    }
  });

  const allElements = doc.querySelectorAll('*');
  let spaMountEmpty = false;

  allElements.forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        reasons.add('event_handler');
      } else if (URL_BEARING_ATTRS.has(name) && isDangerousUrl(attr.value)) {
        reasons.add('javascript_url');
      }
    }
    const id = (el.getAttribute('id') ?? '').trim().toLowerCase();
    if (SPA_MOUNT_IDS.has(id)) {
      const visibleText = (el.textContent ?? '').trim();
      const hasRenderedChildren = el.children.length > 0;
      if (!visibleText && !hasRenderedChildren) {
        spaMountEmpty = true;
      }
    }
  });

  const bodyText = (doc.body?.textContent ?? '').trim();
  const spaMountLikely =
    hasScriptTag &&
    (spaMountEmpty || (hasModuleOrBundleScript && bodyText.length < 40 && allElements.length < 25));

  if (spaMountLikely) {
    reasons.add('spa_mount_root');
  }

  return {
    reasons: [...reasons],
    spaMountLikely,
  };
};

const unwrapElement = (el: Element): void => {
  const parent = el.parentNode;
  if (!parent) {
    el.remove();
    return;
  }
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  el.remove();
};

const sanitizeDomTree = (doc: Document): { externalImagesHidden: boolean } => {
  let externalImagesHidden = false;

  const sanitizeElementAttributes = (el: Element, tag: string): void => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        const cleaned = sanitizeCssText(attr.value);
        if (cleaned) el.setAttribute('style', cleaned);
        else el.removeAttribute('style');
        continue;
      }
      if (name === 'autofocus' || name === 'form' || name === 'formmethod' || name === 'formenctype' || name === 'formtarget') {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href') {
        if (tag === 'a') {
          const trimmed = attr.value.trim();
          const isFragment = trimmed.startsWith('#') && !hasWhitespaceOrControlChars(trimmed);
          if (isFragment) {
            el.setAttribute('href', trimmed);
            el.setAttribute('target', '_self');
          } else {
            const disarmedNotice = isDangerousUrl(trimmed)
              ? 'Script link disabled in static preview'
              : `External or relative link disabled in static preview: ${trimmed}`;
            el.removeAttribute('href');
            el.removeAttribute('target');
            el.removeAttribute('download');
            el.setAttribute('data-disarmed-link', 'true');
            el.setAttribute('title', disarmedNotice);
            const prevStyle = el.getAttribute('style') ?? '';
            const extraStyle = 'text-decoration: underline dotted; opacity: 0.78; cursor: not-allowed;';
            el.setAttribute('style', prevStyle ? `${prevStyle}; ${extraStyle}` : extraStyle);
          }
        } else {
          el.removeAttribute(attr.name);
        }
        continue;
      }
      if (name === 'src' && tag === 'img') {
        continue;
      }
      if (URL_BEARING_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
    }
  };

  const walk = (node: Node, insideSvg: boolean): void => {
    if (node.nodeType === 8 /* Comment */) {
      node.parentNode?.removeChild(node);
      return;
    }
    if (node.nodeType !== 1 /* Element */) {
      return;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (STRIPPED_TAGS.has(tag) || (insideSvg && STRIPPED_IN_SVG_TAGS.has(tag))) {
      el.remove();
      return;
    }

    // Unwrap `<noscript>` and `<form>` after stripping any unsafe children recursively.
    const childrenSnapshot = Array.from(el.childNodes);
    const nextInsideSvg = insideSvg || tag === 'svg';
    for (const child of childrenSnapshot) {
      walk(child, nextInsideSvg);
    }

    if (tag === 'noscript' || tag === 'form') {
      unwrapElement(el);
      return;
    }

    if (tag === 'style') {
      el.textContent = sanitizeCssText(el.textContent ?? '');
      // Remove any attributes on <style> (e.g. onload/media/nonce) except benign type="text/css".
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.toLowerCase() !== 'type' || attr.value.toLowerCase() !== 'text/css') {
          el.removeAttribute(attr.name);
        }
      }
      return;
    }

    if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'file') {
      el.remove();
      return;
    }

    if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      if (isSafeRasterDataImageUrl(src)) {
        // Keep only sanitized raster data URL, dropping srcset and active attrs.
        el.setAttribute('src', src.trim().replace(/\s+/g, ''));
      } else {
        externalImagesHidden = true;
        const placeholder = doc.createElement('span');
        placeholder.setAttribute('data-blocked-image', 'true');
        placeholder.setAttribute(
          'style',
          'display:inline-block;padding:2px 6px;border:1px solid currentColor;border-radius:4px;font-size:12px;opacity:0.75;'
        );
        const alt = (el.getAttribute('alt') ?? '').trim();
        placeholder.textContent = alt
          ? `[Image hidden in static preview: ${alt}]`
          : '[Image hidden in static preview]';
        el.replaceWith(placeholder);
        return;
      }
    }

    sanitizeElementAttributes(el, tag);

    if (tag === 'button') {
      el.setAttribute('type', 'button');
      el.setAttribute('disabled', '');
    } else if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'image' || type === 'reset') {
        el.setAttribute('disabled', '');
      }
    }
    if (tag === 'a' && el.hasAttribute('target') && el.getAttribute('href')?.startsWith('#')) {
      el.setAttribute('target', '_self');
    } else if (tag === 'a' && !el.hasAttribute('href')) {
      el.removeAttribute('target');
      el.removeAttribute('download');
    }
  };

  if (doc.documentElement) {
    sanitizeElementAttributes(doc.documentElement, 'html');
  }
  if (doc.head) {
    sanitizeElementAttributes(doc.head, 'head');
    for (const child of Array.from(doc.head.childNodes)) {
      walk(child, false);
    }
  }
  if (doc.body) {
    sanitizeElementAttributes(doc.body, 'body');
    for (const child of Array.from(doc.body.childNodes)) {
      walk(child, false);
    }
  }

  return { externalImagesHidden };
};

const serializeWithCsp = (doc: Document): string => {
  const cloneDoc = doc.implementation.createHTMLDocument(doc.title || 'Document Preview');
  cloneDoc.head.innerHTML = '';
  const cspMeta = cloneDoc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', STATIC_HTML_IFRAME_CSP);
  const referrerMeta = cloneDoc.createElement('meta');
  referrerMeta.setAttribute('name', 'referrer');
  referrerMeta.setAttribute('content', 'no-referrer');
  cloneDoc.head.appendChild(cspMeta);
  cloneDoc.head.appendChild(referrerMeta);

  if (doc.head) {
    for (const child of Array.from(doc.head.childNodes)) {
      cloneDoc.head.appendChild(cloneDoc.importNode(child, true));
    }
  }
  if (doc.body) {
    cloneDoc.body.innerHTML = doc.body.innerHTML;
    for (const attr of Array.from(doc.body.attributes)) {
      cloneDoc.body.setAttribute(attr.name, attr.value);
    }
  }
  return `<!doctype html>\n${cloneDoc.documentElement.outerHTML}`;
};

export const sanitizeStaticHtml = (
  rawHtml: string,
  parser: DOMParser | undefined = typeof DOMParser !== 'undefined' ? new DOMParser() : undefined
): StaticHtmlAnalysis => {
  // Fail closed if DOMParser is missing rather than ever emitting raw HTML.
  if (!parser) {
    return {
      srcdoc: buildInertFallbackSrcdoc('Document Preview', 'Static HTML preview requires a browser DOM parser. Use Source view.'),
      nodeCount: 0,
      fallbackToSource: true,
      fallbackReason: 'DOMParser unavailable; displaying source safely.',
      scriptsDetected: false,
      spaMountLikely: false,
      externalImagesHidden: false,
      reasons: [],
    };
  }

  const doc = parser.parseFromString(rawHtml, 'text/html');
  const nodeCount = doc.querySelectorAll('*').length;
  const detection = detectDynamicFeatures(doc);

  if (nodeCount > MAX_STATIC_HTML_NODES) {
    return {
      srcdoc: buildInertFallbackSrcdoc(
        'Document Preview',
        `This HTML document has ${nodeCount.toLocaleString()} elements (over the 15,000-element rendered preview limit). Switched to Source view.`
      ),
      nodeCount,
      fallbackToSource: true,
      fallbackReason: `HTML has ${nodeCount.toLocaleString()} elements (limit ${MAX_STATIC_HTML_NODES.toLocaleString()}); switched to Source view.`,
      scriptsDetected: detection.reasons.length > 0,
      spaMountLikely: detection.spaMountLikely,
      externalImagesHidden: false,
      reasons: detection.reasons,
    };
  }

  const pass1 = sanitizeDomTree(doc);
  const intermediateHtml = serializeWithCsp(doc);

  // Second pass re-parse defends against mXSS serializer/parser differentials.
  const reparsed = parser.parseFromString(intermediateHtml, 'text/html');
  const pass2 = sanitizeDomTree(reparsed);
  // Rewrite surviving same-doc `#fragment` anchors to `about:srcdoc#fragment` so clicking
  // an anchor inside `<iframe sandbox="" srcdoc>` scrolls smoothly instead of resolving
  // against the parent app's base URL and tripping `frame-ancestors 'none'`.
  reparsed.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (href && href.startsWith('#')) {
      anchor.setAttribute('href', `about:srcdoc${href}`);
    }
  });
  const srcdoc = serializeWithCsp(reparsed);

  return {
    srcdoc,
    nodeCount,
    fallbackToSource: false,
    scriptsDetected: detection.reasons.length > 0,
    spaMountLikely: detection.spaMountLikely,
    externalImagesHidden: pass1.externalImagesHidden || pass2.externalImagesHidden,
    reasons: detection.reasons,
  };
};

export const buildHtmlScriptNoticePrompts = (
  hostLabel: string,
  path: string
): { serveLocally: string; staticCopy: string } => {
  const safeHost = hostLabel.trim() || 'this host';
  const safePath = path.trim() || 'this document';
  return {
    serveLocally: `Please start a local development server for "${safePath}" on ${safeHost} and share the local URL so I can open the interactive page in my browser.`,
    staticCopy: `Please generate a standalone static HTML/CSS copy of "${safePath}" on ${safeHost} with a new filename next to it (preserving "${safePath}" unchanged) so the layout renders cleanly without JavaScript.`,
  };
};
