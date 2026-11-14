import { expect, test } from '@playwright/test';

const source = 'same **same and *nested* words** [same](https://example.com) end.\n\nSecond paragraph same words.\n\nLast paragraph.';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async (text) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Markdown } = await import('/src/components/Markdown.tsx');
    const { default: Linkify } = await import('/src/components/Linkify.tsx');
    const region = document.createElement('div'); region.id = 'capture-fixture';
    Object.assign(region.style, { position: 'fixed', inset: '0', background: 'white', color: 'black', zIndex: '99999', padding: '40px', fontSize: '18px' });
    document.body.append(region);
    createRoot(region).render(React.createElement('div', {},
      React.createElement('div', { 'data-message-id': 'm1' }, React.createElement('div', { 'data-quote-part-id': 'p1' }, React.createElement(Markdown, { text }))),
      React.createElement('div', { 'data-message-id': 'm2' }, React.createElement('div', { 'data-quote-part-id': 'p2', style: { whiteSpace: 'pre-wrap', marginTop: '30px' } }, React.createElement(Linkify, { text: 'plain same same https://example.com\nNext plain line.' })))));
  }, source);
  await expect(page.locator('#capture-fixture p')).toHaveCount(3);
});

for (const clicks of [2, 3]) {
  test('native ' + clicks + '-click nested Markdown has exact reversible source offsets', async ({ page }) => {
    await page.locator('#capture-fixture strong em').click({ clickCount: clicks });
    const result = await page.evaluate(async (text) => {
      const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
      const { quoteRangeIn } = await import('/src/lib/quoteHighlight.ts');
      const range = window.getSelection()!.getRangeAt(0);
      const captured = captureQuoteAnchor({ range, transcript: document.querySelector('#capture-fixture')!, sessionKey: 'host::chat', messages: [{ id: 'm1', role: 'assistant', text, parts: [{ id: 'p1', type: 'text', text }] }] });
      const revealed = captured.ok ? quoteRangeIn(document.querySelector('#capture-fixture [data-quote-part-id="p1"]')!, captured.anchor.spans[0]) : null;
      return { captured, selection: range.toString(), revealed: revealed?.toString(), boundary: { start: range.startContainer.nodeName, end: range.endContainer.nodeName, offset: range.endOffset, parent: range.endContainer.parentElement?.outerHTML } };
    }, source);
    expect(result.captured, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.captured.ok) return;
    expect(result.captured.anchor.quote).toBe(clicks === 2 ? 'nested' : 'same same and nested words same end.');
    expect(result.revealed?.trim()).toBe(result.selection.trim());
    expect(result.captured.anchor.spans[0].start).toBe(clicks === 2 ? source.indexOf('nested') : 0);
  });
}

test('native tripleclick plain Linkify line is exact and reversible', async ({ page }) => {
  await page.locator('#capture-fixture [data-quote-part-id="p2"]').click({ position: { x: 20, y: 9 }, clickCount: 3 });
  const result = await page.evaluate(async () => {
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const { quoteRangeIn } = await import('/src/lib/quoteHighlight.ts');
    const text = 'plain same same https://example.com\nNext plain line.';
    const range = window.getSelection()!.getRangeAt(0);
    const captured = captureQuoteAnchor({ range, transcript: document.querySelector('#capture-fixture')!, sessionKey: 'host::chat', messages: [{ id: 'm2', role: 'user', text, parts: [{ id: 'p2', type: 'text', text }] }] });
    return { captured, selected: range.toString(), revealed: captured.ok ? quoteRangeIn(document.querySelector('[data-quote-part-id="p2"]')!, captured.anchor.spans[0])?.toString() : null };
  });
  expect(result.captured).toMatchObject({ ok: true });
  expect(result.revealed).toBe(result.selected.trim());
});

test('source projection crosses inline and paragraph gaps without confusing display and source quotes', async ({ page }) => {
  const result = await page.evaluate(async (text) => {
    const { captureQuoteAnchor, validateQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const { quoteRangeIn } = await import('/src/lib/quoteHighlight.ts');
    const region = document.querySelector('#capture-fixture')!;
    const part = region.querySelector('[data-quote-part-id="p1"]')!;
    const paragraphs = part.querySelectorAll('p');
    const range = document.createRange(); range.setStart(paragraphs[0].querySelector('strong')!.firstChild!.firstChild!, 0); range.setEnd(paragraphs[1].firstChild!.firstChild!, 21);
    const messages = [{ id: 'm1', role: 'assistant' as const, text, parts: [{ id: 'p1', type: 'text' as const, text }] }];
    const captured = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages });
    if (!captured.ok) return { captured };
    const revealed = quoteRangeIn(part, captured.anchor.spans[0]);
    const changed = text + ' changed';
    const stale = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [{ ...messages[0], text: changed, parts: [{ id: 'p1', type: 'text', text: changed }] }] });
    return { captured, revealed: revealed?.toString(), display: range.toString(), stale, validation: validateQuoteAnchor(captured.anchor, messages) };
  }, source);
  expect(result.captured).toMatchObject({ ok: true });
  expect(result.validation).toMatchObject({ valid: true });
  expect(result.revealed).toBe(result.display);
  expect(result.stale).toMatchObject({ ok: false });
  if (result.captured.ok) {
    expect(result.captured.anchor.spans[0].quote).toContain('*nested*');
    expect(result.captured.anchor.quote).not.toContain('*nested*');
  }
});

test('multi-message native range is refused even when both texts are mappable', async ({ page }) => {
  const result = await page.evaluate(async (text) => {
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const region = document.querySelector('#capture-fixture')!;
    const range = document.createRange();
    range.setStart(region.querySelector('em')!.firstChild!.firstChild!, 0);
    range.setEnd(region.querySelector('[data-quote-part-id="p2"]')!.firstChild!, 5);
    return captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [{ id: 'm1', role: 'assistant', text, parts: [{ id: 'p1', type: 'text', text }] }] });
  }, source);
  expect(result).toMatchObject({ ok: false, reason: 'multi-message' });
});

test('plain Linkify doubleclick preserves the second occurrence offset', async ({ page }) => {
  const part = page.locator('#capture-fixture [data-quote-part-id="p2"]');
  const point = await part.evaluate(element => {
    const node = element.firstChild!;
    const range = document.createRange(); range.setStart(node, 11); range.setEnd(node, 15);
    const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.dblclick(point.x, point.y);
  const captured = await page.evaluate(async () => {
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const text = 'plain same same https://example.com\nNext plain line.';
    return captureQuoteAnchor({ range: window.getSelection()!.getRangeAt(0), transcript: document.querySelector('#capture-fixture')!, sessionKey: 'host::chat', messages: [{ id: 'm2', role: 'user', text, parts: [{ id: 'p2', type: 'text', text }] }] });
  });
  expect(captured).toMatchObject({ ok: true, anchor: { spans: [{ start: 11, end: 15, quote: 'same' }] } });
});

test('unmapped Markdown and code are refused, not relocated to identical prose', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { default: Markdown } = await import('/src/components/Markdown.tsx');
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const region = document.createElement('div'); document.body.append(region);
    const text = 'same `same` &amp; same';
    createRoot(region).render(React.createElement('div', { 'data-message-id': 'm' }, React.createElement('div', { 'data-quote-part-id': 'p' }, React.createElement(Markdown, { text }))));
    await new Promise(resolve => setTimeout(resolve, 100));
    const messages = [{ id: 'm', role: 'assistant' as const, text, parts: [{ id: 'p', type: 'text' as const, text }] }];
    const results = ['code', '[data-quote-unsupported]'].map(selector => {
      const range = document.createRange(); range.selectNodeContents(region.querySelector(selector)!);
      return captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages });
    });
    region.remove(); return results;
  });
  for (const result of results) expect(result).toMatchObject({ ok: false, reason: 'unsupported-content' });
});

test('tripleclick-style end at next row offset zero trims the empty boundary, not another message', async ({ page }) => {
  const result = await page.evaluate(async (text) => {
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const region = document.querySelector('#capture-fixture')!;
    const range = document.createRange();
    range.setStart(region.querySelector('p')!.firstChild!.firstChild!, 0);
    range.setEnd(region.querySelector('[data-message-id="m2"]')!, 0);
    return captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [{ id: 'm1', role: 'assistant', text, parts: [{ id: 'p1', type: 'text', text }] }] });
  }, source);
  expect(result).toMatchObject({ ok: true, anchor: { spans: [{ messageId: 'm1', start: 0, end: source.length }] } });
});

for (const [label, value] of [
  ['LF', 'same first line\nsame second line.\n\nNext block.'],
  ['CRLF', 'same first line\r\nsame second line.\r\n\r\nNext block.'],
  ['NBSP', 'same\u00a0same words.\n\nNext block.'],
  ['hard break and trailing spaces', 'same first line  \nsame second line.   \n\nNext block.'],
  ['soft wrap', 'same first line with enough ordinary words to wrap visually and same final words.\n\nNext block.'],
]) {
  test('native full-paragraph tripleclick whitespace: ' + label, async ({ page }) => {
    await page.evaluate(async text => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { default: Markdown } = await import('/src/components/Markdown.tsx');
      const region = document.querySelector('#capture-fixture')!;
      const fixture = document.createElement('div'); fixture.id = 'whitespace-fixture'; fixture.style.width = '210px';
      region.replaceChildren(fixture);
      createRoot(fixture).render(React.createElement('div', { 'data-message-id': 'm' }, React.createElement('div', { 'data-quote-part-id': 'p' }, React.createElement(Markdown, { text }))));
    }, value);
    const paragraph = page.locator('#whitespace-fixture p').first();
    await expect(paragraph).toBeVisible();
    await paragraph.click({ position: { x: 25, y: 8 }, clickCount: 3 });
    const result = await page.evaluate(async text => {
      const { captureQuoteAnchor, normaliseSelection } = await import('/src/lib/quoteLinks.ts');
      const { quoteRangeIn } = await import('/src/lib/quoteHighlight.ts');
      const region = document.querySelector('#whitespace-fixture')!;
      const selection = window.getSelection()!;
      const range = selection.getRangeAt(0);
      const captured = captureQuoteAnchor({ range, selectedText: selection.toString(), transcript: region, sessionKey: 'host::chat', messages: [{ id: 'm', role: 'assistant', text, parts: [{ id: 'p', type: 'text', text }] }] });
      return { captured, selected: normaliseSelection(selection.toString()), endNode: range.endContainer.nodeName, endOffset: range.endOffset, revealed: captured.ok ? quoteRangeIn(region.querySelector('[data-quote-part-id]')!, captured.anchor.spans[0])?.toString() : null };
    }, value);
    expect(result.captured, JSON.stringify(result)).toMatchObject({ ok: true });
    if (result.captured.ok) {
      expect(result.captured.anchor.quote).toBe(result.selected);
      expect(result.revealed?.trim()).toBeTruthy();
      expect(value.slice(result.captured.anchor.spans[0].start, result.captured.anchor.spans[0].end)).toBe(result.captured.anchor.spans[0].quote);
    }
  });
}
