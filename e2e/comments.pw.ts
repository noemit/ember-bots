import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query = '') => {
  await page.goto('/' + query);
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('log')).toContainText(query.includes('fixture=annotation') ? 'Historical reply' : 'step counter shows');
  await page.waitForTimeout(600);
  return column;
};
const select = async (page: Page, phrase = 'step counter shows') => {
  await page.evaluate((text) => {
    const root = document.querySelector('main[data-session-key="pi:hearth::10"] [data-message-id="e2"] [data-quote-part-id="e2-1"]');
    if (!root) throw new Error('source part missing');
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode as Text;
      const start = node.data.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); return;
    }
    throw new Error('source phrase missing');
  }, phrase);
};
const settings = (page: Page) => page.evaluate(() => window.ember.getSettings());

test('annotation draft hides and resumes without consuming the main draft; Note links survive restart', async ({ page }) => {
  const column = await open(page);
  const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
  await main.fill('Keep my main draft');
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar).toBeVisible();
  await bar.getByRole('textbox').fill('Keep this annotation');
  await page.screenshot({ path: test.info().outputPath('annotation-composer.png') });
  await bar.getByRole('button', { name: 'Hide annotation draft' }).click();
  await expect(bar).toHaveCount(0);
  await expect(main).toHaveValue('Keep my main draft');
  await column.getByRole('button', { name: /Resume annotation/ }).click();
  await expect(bar.getByRole('textbox')).toHaveValue('Keep this annotation');
  await main.click();
  await expect(bar).toHaveCount(0);
  await column.getByRole('button', { name: /Resume annotation/ }).click();
  await bar.getByRole('button', { name: 'Save annotation with quote as a note' }).click();
  await expect(bar).toHaveCount(0);
  await expect(main).toHaveValue('Keep my main draft');
  const saved = await settings(page);
  expect(saved.quoteLinks).toHaveLength(1);
  const link = saved.quoteLinks[0];
  expect(link.source.spans[0]).toMatchObject({ messageId: 'e2', partId: 'e2-1', quote: 'step counter shows' });
  expect(link.destination.kind).toBe('note');
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(column.getByRole('button', { name: /Open linked note:/ })).toBeVisible();
  await column.getByRole('button', { name: /Open linked note:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Note for later' });
  await expect(dialog).toBeVisible();
  const marks = (await settings(page)).readMarks;
  await dialog.getByRole('button', { name: /Open quoted source:/ }).click();
  await expect(column.locator('[data-quote-highlighted="true"]')).toHaveCount(1);
  expect((await settings(page)).readMarks).toEqual(marks);
});

test('accepted annotation uses a canonical message identity and both directions stay passive', async ({ page }) => {
  const column = await open(page);
  const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
  await main.fill('Unsent main draft');
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Fix the arithmetic');
  await bar.getByRole('button', { name: 'Send annotation with quote' }).click();
  await expect(bar).toHaveCount(0);
  await expect(main).toHaveValue('Unsent main draft');
  await expect.poll(async () => (await settings(page)).quoteLinks.length).toBe(1);
  const saved = (await settings(page)).quoteLinks[0];
  expect(saved.destination.kind).toBe('message');
  expect(saved.destination.id).toMatch(/^e\d+$/);
  const destination = column.locator('[data-message-id="' + saved.destination.id + '"]');
  await expect(destination.getByRole('button', { name: /Open quoted source:/ })).toBeVisible();
  const marks = (await settings(page)).readMarks;
  await destination.getByRole('button', { name: /Open quoted source:/ }).click();
  await expect(column.locator('[data-quote-highlighted="true"]')).toHaveCount(1);
  await column.getByRole('button', { name: /Open linked message:/ }).click();
  expect((await settings(page)).readMarks).toEqual(marks);
});

test('host failure retains the annotation and main draft without saving a placeholder link', async ({ page }) => {
  const column = await open(page, '?failSubmit');
  const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
  await main.fill('Untouched main');
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Retain after refusal');
  await bar.getByRole('button', { name: 'Send annotation with quote' }).click();
  await expect(bar.getByRole('textbox')).toHaveValue('Retain after refusal');
  await expect(main).toHaveValue('Untouched main');
  expect((await settings(page)).quoteLinks).toEqual([]);
});

test('cross-message selection is refused accessibly instead of linked approximately', async ({ page }) => {
  const column = await open(page);
  await page.evaluate(() => {
    const rows = document.querySelectorAll('main[data-session-key="pi:hearth::10"] [data-quote-part-id]');
    const first = rows[0]; const last = rows[rows.length - 1];
    const range = document.createRange(); range.setStartBefore(first); range.setEndAfter(last);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  });
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar.getByRole('status').first()).toContainText(/one message|exact passage/);
  await bar.getByRole('textbox').fill('Do not guess');
  await expect(bar.getByRole('button', { name: /Send annotation with quote/ })).toBeDisabled();
  expect((await settings(page)).quoteLinks).toEqual([]);
});

test('queued annotations retain real identities through edit, send-now and cancellation', async ({ page }) => {
  const column = await open(page, '?staleBusy');
  await select(page);
  let bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('A queued annotation');
  await bar.getByRole('button', { name: 'Send annotation with quote' }).click();
  await expect(bar).toHaveCount(0);
  let link = (await settings(page)).quoteLinks[0];
  expect(link.destination.kind).toBe('queue');
  expect(link.destination.id).toMatch(/^\d+$/);
  const originalId = link.destination.id;
  await column.getByRole('button', { name: /Open linked queue:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Queued message', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
  await column.getByRole('button', { name: /Edit queued message:/ }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('textbox').fill('Edited annotation still quotes the same source');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await settings(page)).quoteLinks[0]?.destination.id).not.toBe(originalId);
  link = (await settings(page)).quoteLinks[0];
  expect(link.source.quote).toBe('step counter shows');
  await column.getByRole('button', { name: /Send queued message now:/ }).click();
  await expect.poll(async () => (await settings(page)).quoteLinks[0]?.destination.kind).toBe('message');
  link = (await settings(page)).quoteLinks[0];
  await expect(column.locator('[data-message-id="' + link.destination.id + '"]').getByRole('button', { name: /Open quoted source:/ })).toBeVisible();
  await page.waitForTimeout(1200);
  await select(page);
  bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Cancel this annotation');
  await bar.getByRole('button', { name: /annotation with quote$/ }).first().click();
  await expect.poll(async () => (await settings(page)).quoteLinks.length).toBe(2);
  await column.getByRole('button', { name: /Cancel queued message:/ }).click();
  await expect.poll(async () => (await settings(page)).quoteLinks.length).toBe(1);
});

for (const fixture of ['annotations', 'annotation-unloaded']) {
test('source navigation mounts history and highlights only a validated passage (' + fixture + ')', async ({ page }) => {
  await page.addInitScript(() => {
    const text = 'Found a regression: the step counter shows **3/2** on the last step.';
    const quote = 'step counter shows'; const start = text.indexOf(quote);
    localStorage.setItem('ember-pi-quote-links', JSON.stringify([{ id: 'quote-virtual', source: { sessionKey: 'pi:hearth::10', quote, spans: [{ messageId: 'e2', partId: 'e2-1', start, end: start + quote.length, quote, text }] }, destination: { kind: 'note', sessionKey: 'pi:hearth::10', id: 'virtual-note' } }]));
    localStorage.setItem('ember-pi-notes', JSON.stringify({ 'pi:hearth::10': [{ id: 'virtual-note', text: 'A note about the old passage', quoteLinkId: 'quote-virtual' }] }));
  });
  const column = await open(page, '?fixture=' + fixture);
  const showTrays = column.getByRole('button', { name: 'Show the composer trays', exact: true });
  if (await showTrays.count()) await showTrays.click();
  if (fixture === 'annotation-unloaded') await expect(column.locator('[data-message-id="e2"]')).toHaveCount(0);
  const marks = (await settings(page)).readMarks;
  await column.getByRole('button', { name: /Open quoted source:/ }).click();
  await expect(column.locator('[data-message-id="e2"] [data-quote-highlighted="true"]')).toHaveCount(1);
  await expect(column.locator('[data-message-id="e2"]')).toBeInViewport();
  expect((await settings(page)).readMarks).toEqual(marks);
});

}

test('annotations preserve attachments, reply context and model draft; multiple links offer a chooser and note deletion cleans up', async ({ page }) => {
  const column = await open(page);
  const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
  await main.fill('Main message with its own context');
  const footer = column.locator('[data-message-id="e2"] [data-message-footer]');
  await footer.getByRole('button', { name: 'Reply to this message' }).focus();
  await footer.getByRole('button', { name: 'Reply to this message' }).click();
  await column.locator('input[type="file"]').setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64') });
  await expect.poll(async () => (await settings(page)).composerDrafts['pi:hearth::10']?.text).toBe('Main message with its own context');
  const before = (await settings(page)).composerDrafts['pi:hearth::10'];
  for (const value of ['First source-linked note', 'Second source-linked note']) {
    await select(page);
    const bar = column.getByRole('group', { name: 'Annotate selected text' });
    await bar.getByRole('textbox').fill(value);
    await bar.getByRole('button', { name: 'Save annotation with quote as a note' }).click();
    await expect(bar).toHaveCount(0);
  }
  await expect(main).toHaveValue('Main message with its own context');
  await expect(column.getByText('Replying with context', { exact: true })).toBeVisible();
  await expect(column.getByText('retained.png', { exact: true })).toBeVisible();
  expect((await settings(page)).composerDrafts['pi:hearth::10']).toMatchObject({ text: before.text, modelId: before.modelId, variant: before.variant });
  const chooser = column.locator('[data-message-id="e2"] details[data-quote-link]');
  await expect(chooser.locator('summary')).toHaveText('2 linked annotations');
  await chooser.locator('summary').click();
  await expect(chooser.getByRole('button', { name: /Open linked note:/ })).toHaveCount(2);
  await column.getByRole('button', { name: /Delete note:.*First source-linked note/ }).click();
  await expect.poll(async () => (await settings(page)).quoteLinks.length).toBe(1);
});

for (const fixture of ['unrecognizedSubmit', 'failQuoteSaveOnce']) {
  test('annotation draft survives ' + fixture + ' and retry links exactly one accepted message', async ({ page }) => {
    const column = await open(page, '?' + fixture);
    await select(page);
    const bar = column.getByRole('group', { name: 'Annotate selected text' });
    await bar.getByRole('textbox').fill('Keep the draft until linked');
    const send = bar.getByRole('button', { name: 'Send annotation with quote' });
    await send.click();
    await expect(send).toBeEnabled();
    await expect(bar.getByRole('textbox')).toHaveValue('Keep the draft until linked');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ember-pi-quote-links') ?? '[]').length)).toBe(0);
    await send.click();
    await expect(bar).toHaveCount(0);
    const links = (await settings(page)).quoteLinks;
    expect(links).toHaveLength(1);
    expect(links[0].destination.kind).toBe('message');
    const sent = column.getByRole('article', { name: /^user message/ }).filter({ hasText: 'Keep the draft until linked' });
    await expect(sent).toHaveCount(1);
  });
}

test('reorder atomically migrates duplicate-text annotation destinations using host identities', async ({ page }) => {
  const column = await open(page, '?staleBusy');
  for (let i = 0; i < 2; i += 1) {
    await select(page);
    const bar = column.getByRole('group', { name: 'Annotate selected text' });
    await bar.getByRole('textbox').fill('Identical queued annotation');
    await bar.getByRole('button', { name: /annotation with quote$/ }).first().click();
    await expect(bar).toHaveCount(0);
  }
  const before = (await settings(page)).quoteLinks;
  expect(before).toHaveLength(2);
  await column.getByRole('button', { name: /Move queued message down:/ }).first().click();
  await expect.poll(async () => (await settings(page)).quoteLinks.every((link) => !before.some((old) => old.destination.id === link.destination.id))).toBe(true);
  const after = (await settings(page)).quoteLinks;
  expect(after.map((link) => link.id)).toEqual(before.map((link) => link.id));
  expect(new Set(after.map((link) => link.destination.id)).size).toBe(2);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ember-pi-quote-links') ?? '[]'));
  expect(saved).toEqual(after);
  await column.locator('[data-message-id="e2"] details[data-quote-link] summary').click();
  await column.getByRole('button', { name: /Open linked queue:/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Queued message', exact: true })).toBeVisible();
});

test('backlinks with colliding message IDs stay scoped to their conversation', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ember-pi-quote-links', JSON.stringify([{ id: 'quote-cross-session', source: { sessionKey: 'pi:hearth::11', quote: 'QA', spans: [{ messageId: 'e1', partId: 'e1-0', start: 0, end: 2, quote: 'QA', text: 'QA the Habit onboarding flow.' }] }, destination: { kind: 'message', sessionKey: 'pi:hearth::10', id: 'e2' } }]));
  });
  const column = await open(page);
  await expect(column.locator('[data-message-id="e1"] [data-quote-link]')).toHaveCount(0);
  await expect(column.locator('[data-message-id="e2"]').getByRole('button', { name: 'Open quoted source: QA', exact: true })).toBeVisible();
  await expect(column.getByRole('button', { name: /Open linked message:/ })).toHaveCount(0);
});

test('source navigation falls back to a message jump when CSS highlighting is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const text = 'Found a regression: the step counter shows **3/2** on the last step.';
    const quote = 'step counter shows'; const start = text.indexOf(quote);
    localStorage.setItem('ember-pi-quote-links', JSON.stringify([{ id: 'quote-fallback', source: { sessionKey: 'pi:hearth::10', quote, spans: [{ messageId: 'e2', partId: 'e2-1', start, end: start + quote.length, quote, text }] }, destination: { kind: 'note', sessionKey: 'pi:hearth::10', id: 'fallback-note' } }]));
    localStorage.setItem('ember-pi-notes', JSON.stringify({ 'pi:hearth::10': [{ id: 'fallback-note', text: 'Fallback note', quoteLinkId: 'quote-fallback' }] }));
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const column = await open(page);
  await page.evaluate(() => {
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: undefined });
  });
  const showTrays = column.getByRole('button', { name: 'Show the composer trays', exact: true });
  if (await showTrays.count()) await showTrays.click();
  await column.getByRole('button', { name: /Open quoted source:/ }).click();
  await expect(column.locator('[data-message-id="e2"][data-highlighted="true"]')).toBeVisible();
  await expect(column.locator('[data-quote-highlighted="true"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('repeated link-save failures retain one visible canonical message as well as the annotation draft', async ({ page }) => {
  const column = await open(page, '?failQuoteSave');
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Accepted message stays visible');
  const send = bar.getByRole('button', { name: /^(Send|Queue) annotation with quote$/ });
  const sent = column.getByRole('article', { name: /^user message/ }).filter({ hasText: 'Accepted message stays visible' });
  let canonicalId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await send.click();
    // Check while the failing link store is still pending, not only after a transcript refresh.
    await expect(send).toBeDisabled();
    await expect(sent).toHaveCount(1);
    const id = await sent.locator('[data-message-id]').getAttribute('data-message-id');
    expect(id).toMatch(/^e\d+$/);
    if (canonicalId) expect(id).toBe(canonicalId);
    canonicalId = id;
    await page.evaluate(() => (window as unknown as { releaseAnnotationLinkSave: () => void }).releaseAnnotationLinkSave());
    await expect(send).toBeEnabled();
    await expect(bar.getByRole('textbox')).toHaveValue('Accepted message stays visible');
    await expect(sent).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ember-pi-quote-links') ?? '[]').length)).toBe(0);
  }
  await expect(sent.locator('[data-message-id]')).toHaveAttribute('data-message-id', canonicalId!);
});

test('a queued annotation remains visible while its source-link save repeatedly fails', async ({ page }) => {
  const column = await open(page, '?failQuoteSave&staleBusy');
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Queued work stays visible');
  const send = bar.getByRole('button', { name: /^(Send|Queue) annotation with quote$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await send.click();
    await expect(send).toBeDisabled();
    await expect(column.getByRole('button', { name: /Read queued message:.*Queued work stays visible/ })).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { releaseAnnotationLinkSave: () => void }).releaseAnnotationLinkSave());
    await expect(send).toBeEnabled();
    await expect(bar.getByRole('textbox')).toHaveValue('Queued work stays visible');
    await expect(column.getByRole('button', { name: /Read queued message:.*Queued work stays visible/ })).toHaveCount(1);
  }
});

test('a slow native drag settles before annotation capture and leaves selection intact until editor focus', async ({ page }) => {
  const column = await open(page);
  const marks = (await settings(page)).readMarks;
  const prose = column.locator('[data-message-id="e2"] p');
  const box = await prose.boundingBox();
  if (!box) throw new Error('Source prose is not laid out');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 4 });
  await page.waitForTimeout(300);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar).toHaveCount(0);
  await page.mouse.move(box.x + 145, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(bar).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Found');
  await expect(bar.getByRole('textbox')).not.toBeFocused();
  await page.keyboard.press('Control+Alt+c');
  await expect(bar.getByRole('textbox')).toBeFocused();
  expect((await settings(page)).readMarks).toEqual(marks);
});

test('annotation shortcut during a held pointer focuses the final released selection', async ({ page }) => {
  const column = await open(page);
  const before = (await settings(page)).readMarks;
  const box = await column.locator('[data-message-id="e2"] p').boundingBox();
  if (!box) throw new Error('Source prose is not laid out');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 4 });
  await page.keyboard.press('Control+Alt+c');
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar).toHaveCount(0);
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + 145, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(bar.getByRole('textbox')).toBeFocused();
  await expect(bar.getByRole('textbox')).toHaveAttribute('aria-label', /Found/);
  expect((await settings(page)).readMarks).toEqual(before);
});

test('annotation shortcut before the selection debounce opens and focuses immediately', async ({ page }) => {
  const column = await open(page);
  const before = (await settings(page)).readMarks;
  await page.evaluate(() => {
    const part = document.querySelector('main[data-session-key="pi:hearth::10"] [data-message-id="e2"] [data-quote-part-id="e2-1"]')!;
    const node = part.querySelector('p')!.firstChild!;
    const start = node.textContent!.indexOf('step counter shows');
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'step counter shows'.length);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    // Same browser task: the 120ms capture debounce cannot have fired yet.
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  });
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar.getByRole('textbox')).toBeFocused();
  await expect(bar.getByRole('textbox')).toHaveAttribute('aria-label', /step counter shows/);
  expect((await settings(page)).readMarks).toEqual(before);
});

test('a held-pointer shortcut defers resuming an existing annotation until release without rebinding its source', async ({ page }) => {
  const column = await open(page);
  const before = (await settings(page)).readMarks;
  await select(page);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Retain this annotation and its source');
  await bar.getByRole('button', { name: 'Hide annotation draft' }).click();
  const box = await column.locator('[data-message-id="e2"] p').boundingBox();
  if (!box) throw new Error('Source prose is not laid out');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 4 });
  await page.keyboard.press('Control+Alt+c');
  // Even an existing draft must not take focus in the middle of the native drag.
  await expect(bar).toHaveCount(0);
  await page.mouse.move(box.x + 145, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(bar.getByRole('textbox')).toBeFocused();
  await expect(bar.getByRole('textbox')).toHaveValue('Retain this annotation and its source');
  await expect(bar.getByRole('textbox')).toHaveAttribute('aria-label', /step counter shows/);
  expect((await settings(page)).readMarks).toEqual(before);
});
