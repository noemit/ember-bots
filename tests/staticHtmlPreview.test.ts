import { describe, expect, test } from 'bun:test';
import {
  buildHtmlScriptNoticePrompts,
  isDangerousUrl,
  isSafeRasterDataImageUrl,
  sanitizeCssText,
  sanitizeStaticHtml,
  STATIC_HTML_IFRAME_CSP,
} from '../src/lib/staticHtmlPreview';

describe('staticHtmlPreview helpers & fail-closed guarantees', () => {
  test('STATIC_HTML_IFRAME_CSP enforces full sans-JS isolation', () => {
    for (const directive of [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "media-src 'none'",
      "connect-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ]) {
      expect(STATIC_HTML_IFRAME_CSP).toContain(directive);
    }
  });

  test('sanitizeCssText removes @import, external url(), expressions, bindings, and </style breakouts', () => {
    const dirty = [
      '@import url("https://evil.example/a.css");',
      '@\\69 mport "https://evil.example/b.css";',
      '/* c */ @import \'//evil.example/c.css\';',
      '.bg { background-image: url(https://evil.example/bg.png); }',
      '.rel { background: url("./img.png"); }',
      '.ok { color: #222; padding: 8px; }',
      '.inline-ok { background: url("data:image/png;base64,AAAA"); }',
      '.legacy { width: expression(alert(1)); -moz-binding: url(x); behavior: url(y); }',
      '</style><script>alert(1)</script>',
    ].join('\n');

    const cleaned = sanitizeCssText(dirty);
    expect(cleaned).not.toContain('@import');
    expect(cleaned).not.toContain('evil.example');
    expect(cleaned).not.toContain('./img.png');
    expect(cleaned).not.toContain('</style');
    expect(cleaned).not.toContain('expression(');
    expect(cleaned).not.toContain('-moz-binding:');
    expect(cleaned).not.toContain('behavior:');
    expect(cleaned).toContain('color: #222; padding: 8px;');
    expect(cleaned).toContain('url("data:image/png;base64,AAAA")');
  });

  test('isDangerousUrl blocks obfuscated script and local file schemes', () => {
    expect(isDangerousUrl('javascript:alert(1)')).toBe(true);
    expect(isDangerousUrl('  JaVaScRiPt:\talert(1)')).toBe(true);
    expect(isDangerousUrl('java\nscript:alert(1)')).toBe(true);
    expect(isDangerousUrl('vbscript:msgbox(1)')).toBe(true);
    expect(isDangerousUrl('file:///etc/passwd')).toBe(true);
    expect(isDangerousUrl('data:text/html,<script>alert(1)</script>')).toBe(true);
    expect(isDangerousUrl('#details')).toBe(false);
    expect(isDangerousUrl('https://example.com')).toBe(false);
  });

  test('isSafeRasterDataImageUrl admits raster data URIs only and rejects SVG/HTML/external', () => {
    expect(isSafeRasterDataImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeRasterDataImageUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isSafeRasterDataImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isSafeRasterDataImageUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeRasterDataImageUrl('https://example.com/a.png')).toBe(false);
    expect(isSafeRasterDataImageUrl('./local.png')).toBe(false);
  });

  test('sanitizeStaticHtml fails closed when no DOMParser is present', () => {
    const out = sanitizeStaticHtml('<script>alert(1)</script><h1>Raw</h1>', undefined);
    expect(out.fallbackToSource).toBe(true);
    expect(out.srcdoc).toContain(STATIC_HTML_IFRAME_CSP);
    expect(out.srcdoc).not.toContain('<script>');
  });

  test('buildHtmlScriptNoticePrompts names exact host label and path cleanly', () => {
    const prompts = buildHtmlScriptNoticePrompts('Studio Mac', '/Users/alice/app/dist/index.html');
    expect(prompts.serveLocally).toContain('Studio Mac');
    expect(prompts.serveLocally).toContain('/Users/alice/app/dist/index.html');
    expect(prompts.staticCopy).toContain('Studio Mac');
    expect(prompts.staticCopy).toContain('/Users/alice/app/dist/index.html');
    expect(prompts.staticCopy.toLowerCase()).toContain('preserving');
  });
});
