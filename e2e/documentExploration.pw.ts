import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragText(page: Page, part: Locator, first: string, last: string) {
  const points = await part.evaluate((element, { first, last }) => {
    const point = (phrase: string, end: boolean) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const index = node.data.indexOf(phrase);
        if (index < 0) continue;
        const range = document.createRange();
        const offset = end ? index + phrase.length - 1 : index;
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const box = range.getBoundingClientRect();
        return { x: end ? box.right - 0.1 : box.left + 0.1, y: box.y + box.height / 2 };
      }
      throw new Error(`Missing phrase: ${phrase}`);
    };
    return [point(first, false), point(last, true)];
  }, { first, last });
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

async function assertSandboxedHtmlAdversarialIsolation(
  hostPage: Page,
  evilRequests: string[]
) {
  const iframeEl = hostPage.getByTestId('document-preview-iframe');
  await expect(iframeEl).toBeVisible();
  expect(await iframeEl.getAttribute('sandbox')).toBe('');

  const frame = hostPage.frameLocator('[data-testid="document-preview-iframe"]');
  await expect(frame.locator('h1')).toHaveText('Static Preview Report');
  await expect(frame.locator('body')).toContainText('Safe static content survives.');

  // Layer 1 sanitized active tags, CSS @import/external urls, forms, frames, meta refresh, base:
  await expect(frame.locator('script, iframe, object, embed, meta[http-equiv="refresh"], base, link[rel="stylesheet"], form, noscript')).toHaveCount(0);
  await expect(frame.locator('#js-link')).toHaveAttribute('data-disarmed-link', 'true');
  expect(await frame.locator('#js-link').getAttribute('href')).toBeNull();
  expect(await frame.locator('#ext-link').getAttribute('href')).toBeNull();
  await expect(frame.locator('[data-blocked-image="true"]')).toHaveCount(3);
  await expect(frame.locator('button')).toBeDisabled();

  // Clicking disarmed links inside sandboxed preview causes zero navigation and zero popup:
  const urlBeforeClick = hostPage.url();
  await frame.locator('#js-link').click({ force: true });
  await frame.locator('#ext-link').click({ force: true });
  expect(hostPage.url()).toBe(urlBeforeClick);
  // In-document #details fragment anchor remains clickable without escaping srcdoc:
  await frame.locator('a[href$="#details"]').click();
  await expect(frame.locator('h1')).toHaveText('Static Preview Report');

  // Layer 2 CSP meta present inside iframe head:
  const cspMeta = await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(cspMeta).toContain("default-src 'none'");
  expect(cspMeta).toContain("frame-src 'none'");

  // Layer 3 opaque null origin & script-free proof inside child frame:
  const iframeHandle = await iframeEl.elementHandle();
  const childFrame = await iframeHandle?.contentFrame();
  expect(childFrame).not.toBeNull();
  const childChecks = await childFrame!.evaluate(() => {
    let parentBridgeAccessible: boolean;
    try {
      parentBridgeAccessible = Boolean((window.parent as { ember?: unknown }).ember);
    } catch {
      parentBridgeAccessible = false;
    }
    return {
      origin: window.origin,
      executed: (window as { __htmlExecuted?: unknown }).__htmlExecuted ?? null,
      bridgeSeen: (window as { __bridgeSeen?: unknown }).__bridgeSeen ?? null,
      ownBridge: Boolean((window as { ember?: unknown }).ember),
      parentBridgeAccessible,
      locationHref: window.location.href,
    };
  });
  expect(childChecks.origin).toBe('null');
  expect(childChecks.executed).toBeNull();
  expect(childChecks.bridgeSeen).toBeNull();
  expect(childChecks.ownBridge).toBe(false);
  expect(childChecks.parentBridgeAccessible).toBe(false);

  // Zero top-level leakage or network exfiltration attempts:
  expect(await hostPage.evaluate(() => (window as { __htmlExecuted?: unknown }).__htmlExecuted ?? null)).toBeNull();
  expect(evilRequests).toEqual([]);
}

test('verified Markdown/HTML links, triple-lock static HTML modal + popout adversarial isolation, and quote compatibility', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const evilRequests: string[] = [];
  await context.route('**://evil.example/**', async (route) => {
    evilRequests.push(route.request().url());
    await route.abort();
  });

  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/?fixture=doc-exploration');
  await page.locator('aside').getByRole('button', { name: /Document Exploration QA/ }).click();

  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const userPart = column.locator('[data-message-id="e1"] [data-quote-part-id]').first();
  const assistantPart = column.locator('[data-message-id="e2"] [data-quote-part-id]').first();
  await expect(assistantPart).toContainText('Document Verification');

  // Verified links appear cleanly in both assistant Markdown and user Linkify prose:
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: 'docs/plan.md#phase-2' })).toBeVisible();
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: 'the HTML report' })).toBeVisible();
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: 'docs/architecture.md#overview' })).toBeVisible();
  await expect(userPart.locator('a[data-doc-link="true"]', { hasText: 'docs/plan.md' })).toBeVisible();

  // Inline code link renders inside <code> as <a> (never <button>) for quote-annotation compatibility:
  expect(await assistantPart.locator('code a[data-doc-link="true"]').count()).toBe(1);
  expect(await assistantPart.locator('code button').count()).toBe(0);

  // Unverified, duplicate, secret, external web URLs & fenced code behave correctly:
  await expect(assistantPart.locator('a[href="https://example.com/spec.html"]')).toBeVisible();
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: 'missing.md' })).toHaveCount(0);
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: 'dup.md' })).toHaveCount(0);
  await expect(assistantPart.locator('a[data-doc-link="true"]', { hasText: '.env.local.md' })).toHaveCount(0);
  await expect(assistantPart.locator('pre a[data-doc-link="true"]')).toHaveCount(0);

  // Quote selection drag across verified inline code doc link preserves exact byte slice and never triggers modal:
  await dragText(page, assistantPart, 'Inspect ', 'before rollout.');
  await expect(page.getByTestId('document-preview-dialog')).toHaveCount(0);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar.getByRole('textbox')).toBeEnabled();
  await bar.getByRole('textbox').fill('Check phase 2 plan link');
  await bar.getByRole('button', { name: 'Send annotation with quote' }).click();
  await expect.poll(async () => (await page.evaluate(() => window.ember.getSettings())).quoteLinks.length).toBe(1);
  const span = (await page.evaluate(() => window.ember.getSettings())).quoteLinks[0]!.source.spans[0]!;
  expect(span.quote).toBe(span.text.slice(span.start, span.end));
  expect(span.quote).toContain('`docs/plan.md#phase-2`');

  // Clear selection then click verified Markdown link:
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await assistantPart.locator('a[data-doc-link="true"]', { hasText: 'docs/plan.md#phase-2' }).click();
  const dialog = page.getByTestId('document-preview-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('ember-harness (mock)');
  await expect(dialog.getByTestId('document-preview-path')).toHaveText('/workspace/habit/docs/plan.md');

  // Raw HTML script inside Markdown is stripped; external image is blocked by default:
  await expect(dialog.getByTestId('document-preview-markdown')).toContainText('Rollout Plan');
  await expect(dialog.locator('[data-testid="document-preview-markdown"] script')).toHaveCount(0);
  await expect(dialog).toContainText('External images are hidden in preview.');
  expect(evilRequests).toEqual([]);

  // Click Copy path and Source/Rendered toggle:
  await dialog.getByRole('button', { name: 'Copy path' }).click();
  await expect(dialog.getByRole('button', { name: 'Copy path' })).toContainText('Copied');
  await dialog.getByRole('button', { name: 'Source' }).click();
  await expect(dialog.getByTestId('document-preview-source')).toContainText('# Rollout Plan');
  await dialog.getByRole('button', { name: 'Rendered' }).click();

  // Navigate relative Markdown link inside preview, test Download, Back, and error/Refresh recovery:
  await dialog.getByTestId('document-preview-markdown').getByRole('link', { name: 'Architecture' }).click();
  await expect(dialog.getByTestId('document-preview-path')).toHaveText('/workspace/habit/docs/architecture.md');
  await expect(dialog.getByTestId('document-preview-markdown')).toContainText('Isolated triple-lock');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('architecture.md');

  // Navigate to static HTML report from plan.md:
  await dialog.getByRole('button', { name: 'Previous document' }).click();
  await expect(dialog.getByTestId('document-preview-path')).toHaveText('/workspace/habit/docs/plan.md');
  await dialog.getByTestId('document-preview-markdown').getByRole('link', { name: 'Report' }).click();
  await expect(dialog.getByTestId('document-preview-path')).toHaveText('/workspace/habit/docs/report.html');

  // Calm script notice bar + copy-only prompts (never auto-submitted):
  const scriptNotice = dialog.getByTestId('html-script-notice');
  await expect(scriptNotice).toBeVisible();
  await scriptNotice.getByRole('button', { name: 'Copy prompt for static HTML/CSS copy' }).click();
  const copiedPrompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedPrompt).toContain('ember-harness (mock)');
  expect(copiedPrompt).toContain('/workspace/habit/docs/report.html');

  // Adversarial isolation in modal iframe:
  await assertSandboxedHtmlAdversarialIsolation(page, evilRequests);

  // Open in new window (?docPopout=1) & assert identical triple-lock isolation in popout:
  const [popoutPage] = await Promise.all([
    context.waitForEvent('page'),
    dialog.getByRole('button', { name: 'Open in new window' }).click(),
  ]);
  await popoutPage.waitForURL(/docPopout=1/);
  await popoutPage.waitForLoadState('domcontentloaded');
  expect(popoutPage.url()).toContain('docPopout=1');
  await expect(popoutPage.getByTestId('document-preview-surface')).toContainText('ember-harness (mock)');
  await expect(popoutPage.getByTestId('document-preview-path')).toHaveText('/workspace/habit/docs/report.html');
  await expect(popoutPage.getByTestId('html-script-notice')).toBeVisible();
  await assertSandboxedHtmlAdversarialIsolation(popoutPage, evilRequests);

  // Session-expiry event clears modal preview and wipes/closes popout cleanly:
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('ember:session-expired'));
  });
  await expect(page.getByTestId('document-preview-dialog')).toHaveCount(0);
  await expect.poll(() => popoutPage.isClosed()).toBe(true);

  // Re-open plan.md after clearing and verify heading anchor id + forbidden relative escape error:
  await assistantPart.locator('a[data-doc-link="true"]', { hasText: 'docs/plan.md#phase-2' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#user-content-phase-2')).toHaveText('Phase 2');
  await dialog.getByTestId('document-preview-markdown').getByRole('link', { name: 'Outside Secret' }).click();
  await expect(dialog.getByTestId('document-preview-error')).toContainText('ember-harness (mock)');
  await dialog.getByRole('button', { name: 'Retry Refresh' }).click();
  await expect(dialog.getByTestId('document-preview-error')).toContainText('ember-harness (mock)');

  expect(consoleErrors).toEqual([]);
});

test('legacy host returning 404/405/501 keeps candidates plain text silently with zero errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/?fixture=doc-exploration-legacy');
  await page.locator('aside').getByRole('button', { name: /Document Exploration QA/ }).click();

  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const assistantPart = column.locator('[data-message-id="e2"] [data-quote-part-id]').first();
  await expect(assistantPart).toContainText('Document Verification');
  // Wait a beat for batched resolve attempt to settle cleanly:
  await page.waitForTimeout(300);

  await expect(assistantPart.locator('a[data-doc-link="true"]')).toHaveCount(0);
  await expect(assistantPart.locator('a[href="https://example.com/spec.html"]')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
