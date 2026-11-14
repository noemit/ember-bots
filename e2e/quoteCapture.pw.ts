import { expect, test } from '@playwright/test';

test('native DOM ranges capture exact canonical offsets and refuse ambiguous/multi-message selections', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    // Exercise production capture against native DOM/Range, not a helper-existence assertion.
    const { captureQuoteAnchor } = await import('/src/lib/quoteLinks.ts');
    const region = document.createElement('div');
    document.body.append(region);
    const make = (html: string, canonical: string) => {
      region.innerHTML = '<div data-message-id="m1"><span data-quote-part-id="p1">' + html + '</span></div>';
      const part = region.querySelector('[data-quote-part-id]')!;
      const nodes: Text[] = []; const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const message = { id: 'm1', role: 'assistant' as const, text: canonical, completed: true, parts: [{ id: 'p1', type: 'text' as const, text: canonical }] };
      return { part, nodes, message };
    };
    let current = make('same same', 'same same');
    let range = document.createRange(); range.setStart(current.nodes[0], 5); range.setEnd(current.nodes[0], 9);
    const repeated = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [current.message] });
    current = make('<span>hello </span><strong>world</strong>', 'hello world');
    range = document.createRange(); range.setStart(current.nodes[0], 0); range.setEnd(current.nodes[1], 5);
    const acrossNodes = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [current.message] });
    current = make('<strong>important</strong> item', '**important** item');
    range = document.createRange(); range.setStart(current.nodes[0], 0); range.setEnd(current.nodes[0], 9);
    const markdown = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [current.message] });
    current = make('<strong>same</strong> same', '**same** same');
    range = document.createRange(); range.setStart(current.nodes[1], 1); range.setEnd(current.nodes[1], 5);
    const ambiguous = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [current.message] });
    const another = document.createElement('div'); another.dataset.messageId = 'm2'; another.innerHTML = '<span data-quote-part-id="p2">another</span>'; region.append(another);
    range = document.createRange(); range.setStart(current.nodes[0], 0); range.setEnd(another.querySelector('span')!.firstChild!, 7);
    const multiMessage = captureQuoteAnchor({ range, transcript: region, sessionKey: 'host::chat', messages: [current.message] });
    region.remove();
    return { repeated, acrossNodes, markdown, ambiguous, multiMessage };
  });
  expect(results.repeated).toMatchObject({ ok: true, anchor: { spans: [{ start: 5, end: 9, quote: 'same', text: 'same same' }] } });
  expect(results.acrossNodes).toMatchObject({ ok: true, anchor: { spans: [{ start: 0, end: 11, quote: 'hello world' }] } });
  expect(results.markdown).toMatchObject({ ok: true, anchor: { spans: [{ start: 2, end: 11, quote: 'important', text: '**important** item' }] } });
  expect(results.ambiguous).toMatchObject({ ok: false, reason: 'invalid-range' });
  expect(results.multiMessage).toMatchObject({ ok: false, reason: 'multi-message' });
});
