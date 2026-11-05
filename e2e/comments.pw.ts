import { expect, test, type Page } from '@playwright/test';

/**
 * Comments on a transcript segment: select text, say what you think, and send the whole set as one
 * ordinary user message. The selection is made programmatically (a Range over the text node that
 * holds the wanted phrase) so the scene never depends on a pointer drag settling.
 */

/** Select the transcript text node that contains `needle`, the way a drag would. */
const selectText = async (page: Page, needle: string) => {
  await page.evaluate(async (text) => {
    const log = document.querySelector('main[data-session-key="pi:hearth::10"] [role="log"]');
    if (!log) throw new Error('no transcript');
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
    let found: Node | null = null;
    while (walker.nextNode()) {
      if ((walker.currentNode.nodeValue ?? '').includes(text)) {
        found = walker.currentNode;
        break;
      }
    }
    if (!found) throw new Error(`no text containing ${text}`);
    const range = document.createRange();
    range.selectNodeContents(found);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, needle);
};

test('a selected segment can be commented on and sent as one message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const log = column.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('step counter shows');
  // Let the opening fetch land: a transcript that re-renders under a fresh selection replaces the
  // text node, which collapses it in any browser (nothing to do with the bar).
  await page.waitForTimeout(1200);

  await selectText(page, 'step counter shows');
  const bar = column.getByRole('toolbar', { name: 'Comment on the selection' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Yes', exact: true }).click();

  // The tray collects the draft; nothing has been sent yet.
  await expect(column.getByText('Comments', { exact: true })).toBeVisible();
  const send = column.getByRole('button', { name: 'Send 1 comment' });
  await expect(send).toBeVisible();
  await expect(log).not.toContainText('1. Re: "');

  await send.click();
  await expect(log).toContainText('1. Re: "');
  // One message: the quoted segment, then the quick reply on its own line.
  //
  // Scoped to the sent *user* turn rather than the whole log. The mock echoes a user turn into the
  // assistant's `thinking` ("The user said: …"), so an unscoped text match resolves twice and fails
  // strict mode — the duplication is the fixture being realistic, not the app rendering twice.
  const sentTurn = log.getByRole('article', { name: /^user message/ }).last();
  expect(await sentTurn.innerText()).toMatch(/1\. Re: "[^"]*"\s*\nYes/);
  // A successful send empties the tray.
  await expect(column.getByRole('button', { name: 'Send 1 comment' })).toHaveCount(0);
});
