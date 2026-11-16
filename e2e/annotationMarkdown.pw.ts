import { expect, test, type Locator, type Page } from '@playwright/test';

const settings = (page: Page) => page.evaluate(() => window.ember.getSettings());
// Actual mouse selection: endpoint coordinates come from text geometry, not addRange.
async function drag(page: Page, part: Locator, first: string, last: string) {
  const points = await part.evaluate((element, { first, last }) => {
    const point = (phrase: string, end: boolean) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const index = node.data.indexOf(phrase);
        if (index < 0) continue;
        const range = document.createRange();
        const offset = end ? index + phrase.length - 1 : index;
        range.setStart(node, offset); range.setEnd(node, offset + 1);
        const box = range.getBoundingClientRect();
        return { x: end ? box.right - 0.1 : box.left + 0.1, y: box.y + box.height / 2 };
      }
      throw new Error('Missing phrase: ' + phrase);
    };
    return [point(first, false), point(last, true)];
  }, { first, last });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 25 });
  await page.waitForTimeout(180);
  await page.mouse.up();
}

test('native multi-line Markdown drag sends exact annotation across heading, paragraphs, inline code and lists', async ({ page }) => {
  await page.goto('/?fixture=annotation-markdown');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const part = column.locator('[data-message-id="e2"] [data-quote-part-id="e2-1"]');
  await expect(part).toContainText('Selection review');
  await part.evaluate(element => { (element as HTMLElement).style.maxWidth = '480px'; });
  await page.waitForTimeout(600);
  expect(await part.locator('p').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map(rect => rect.top)).size;
  })).toBeGreaterThan(1);
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  // First leave an empty editor open; starting another drag must dismiss it without
  // stealing focus or destroying the new selection.
  await drag(page, part, 'Start with', 'bold words');
  await expect(bar.getByRole('textbox')).toBeEnabled();
  await drag(page, part, 'Selection review', 'ends here.');
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toContain('inline code');
  expect(selected).toContain('Next paragraph');
  expect(selected).toContain('Second list item ends here.');
  expect(selected?.split('\n').length).toBeGreaterThan(4);
  await expect(bar.getByRole('textbox')).toBeEnabled();
  await expect(bar.getByRole('textbox')).not.toBeFocused();
  await bar.getByRole('textbox').fill('Review these lines together');
  await bar.getByRole('button', { name: 'Send annotation with quote' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(async () => (await settings(page)).quoteLinks.length).toBe(1);
  const link = (await settings(page)).quoteLinks[0];
  const span = link.source.spans[0];
  expect(span.quote).toBe(span.text.slice(span.start, span.end));
  expect(span.quote).toContain('`inline code`');
  expect(span.quote).toContain('**bold words**');
  expect(span.quote).toContain('\n\n- First list');
  expect(link.destination.kind).toBe('message');
  await column.locator('[data-message-id="' + link.destination.id + '"]').getByRole('button', { name: /Open quoted source:/ }).click();
  await expect(column.locator('[data-quote-highlighted="true"]')).toHaveCount(1);
});

test('native selection across fenced code is refused rather than approximated', async ({ page }) => {
  await page.goto('/?fixture=annotation-markdown');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const part = column.locator('[data-message-id="e2"] [data-quote-part-id="e2-1"]');
  await expect(part).toContainText('After the code block.');
  await part.locator('pre').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await drag(page, part, 'Unsafe boundary:', 'After the code block.');
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar.getByRole('textbox')).toBeDisabled();
  await expect(bar.getByRole('status').first()).toContainText('code blocks');
  expect((await settings(page)).quoteLinks).toEqual([]);
});
