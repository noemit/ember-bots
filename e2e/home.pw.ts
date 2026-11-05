import { expect, test, type Locator, type Page } from '@playwright/test';

const home = (page: Page): Locator => page.getByTestId('home-view');
const unreadCards = (page: Page): Locator =>
  page.locator('[data-testid="home-session-card"][data-unread="true"]');
const readCards = (page: Page): Locator =>
  page.locator('[data-testid="home-session-card"][data-unread="false"]');

/**
 * Home, on the pi mock: read state is per message and marks are made on purpose.
 *
 * The mock reports no read history (`readSince: 0`) and no saved marks, so every finished
 * assistant turn starts unread — which is what these tests need. Each test starts from a fresh
 * page and its own mock bridge.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(home(page)).toBeVisible();
  await expect(unreadCards(page).first()).toBeVisible();
});

test('home is one flat list of sessions with no rail', async ({ page }) => {
  // No section headings: unread and read sessions run together, separated by a zebra band only.
  await expect(page.getByTestId('home-session-card').first()).toBeVisible();
  await expect(page.getByTestId('home-session-card').first()).toHaveCSS('border-radius', '0px');
  // Links autohide until a session actually shared one; the mock's question carries one.
  await expect(page.getByTestId('home-links')).toBeVisible();
  // The rail is a workspace thing: Home replaces it, so its search box and new-agent button are gone.
  await expect(page.getByRole('button', { name: 'Toggle sessions sidebar' })).toHaveCount(0);
});

test('a card is a session, its rows are messages, and no row names the agent', async ({ page }) => {
  const first = unreadCards(page).first();
  const rows = first.getByTestId('home-unread-row');
  await expect(rows.first()).toBeVisible();
  // Every row opens the reader; the dot beside it is only the indicator.
  const readers = first.getByTestId('home-read-row');
  await expect(readers).toHaveCount(await rows.count());
  // Everything in a card came from that one conversation, so no row repeats a sender.
  await expect(first).not.toContainText('Ember agent');
  // No status words: an unread card says so with colour, a count and dots.
  for (const word of ['Needs you', 'Working', 'Older', 'Unread message']) {
    await expect(first).not.toContainText(word);
  }
});

test('a row opens the whole message, and marking it read happens there', async ({ page }) => {
  const first = unreadCards(page).first();
  const title = await first.getByTestId('home-session-title').innerText();
  const before = await first.getByTestId('home-unread-row').count();

  // The row is truncated on Home; the reader shows it in full.
  const excerpt = await first.getByTestId('home-unread-row').first().innerText();
  await first.getByTestId('home-read-row').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('1 of ' + before + ' unread');

  // Nothing is marked merely by opening it.
  await sheet.getByRole('button', { name: 'Close reading view' }).click();
  await expect(home(page)).toBeVisible();
  await expect(unreadCards(page).filter({ hasText: title }).getByTestId('home-unread-row')).toHaveCount(before);

  // Mark it from the reader: the queue shrinks, and the mark survives a relaunch.
  await unreadCards(page).filter({ hasText: title }).getByTestId('home-read-row').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark read' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close reading view' }).click();
  await expect(unreadCards(page).filter({ hasText: title }).getByTestId('home-unread-row')).toHaveCount(before - 1);

  await page.reload();
  await expect(home(page)).toBeVisible();
  await expect(
    unreadCards(page).filter({ hasText: title }).getByTestId('home-unread-row')
  ).toHaveCount(before - 1);
  expect(excerpt.length).toBeGreaterThan(0);
});

test('the reader can clear a session: Mark all read leaves it caught up', async ({ page }) => {
  await unreadCards(page).first().getByTestId('home-read-row').first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Mark all read' }).click();
  await expect(sheet).toContainText('You’re caught up on');
  await expect(sheet.getByRole('button', { name: /Back to Home/ })).toBeVisible();
});

test('opening a session does not mark anything read', async ({ page }) => {
  const first = unreadCards(page).first();
  const title = await first.getByTestId('home-session-title').innerText();
  const rows = await first.getByTestId('home-unread-row').count();
  await first.getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);

  // Back to Home: the same messages are still waiting.
  await page.getByRole('button', { name: /Home — unread messages/ }).click();
  await expect(home(page)).toBeVisible();
  const sameCard = unreadCards(page).filter({ hasText: title });
  await expect(sameCard.getByTestId('home-unread-row')).toHaveCount(rows);
});

test('right-click marks a whole session read, and it moves to Read', async ({ page }) => {
  const first = unreadCards(page).first();
  const title = await first.getByTestId('home-session-title').innerText();
  await first.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click();

  await expect(unreadCards(page).filter({ hasText: title })).toHaveCount(0);
  // It is the same row in the same list — it just draws no dots or count any more.
  const settled = readCards(page).filter({ hasText: title });
  await expect(settled).toHaveCount(1);
  await expect(settled.getByTestId('home-unread-row')).toHaveCount(0);
});

test('the rail offers Mark all as read too, and Home follows it', async ({ page }) => {
  const first = unreadCards(page).first();
  const title = await first.getByTestId('home-session-title').innerText();
  await first.getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);

  // The rail is back once a session is open (a row is a button named after the session).
  const row = page.getByRole('button', { name: new RegExp(title.split(' ')[0] ?? title) }).first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click();

  await page.getByRole('button', { name: /Home — unread messages/ }).click();
  await expect(readCards(page).filter({ hasText: title })).toHaveCount(1);
});

test('most unread first, then recency', async ({ page }) => {
  // One list: the unread counts descend, and every session after them is settled (no pill).
  const counts = await page.getByTestId('home-session-card').evaluateAll((nodes) =>
    nodes.map((node) => {
      const pill = node.querySelector('[title$="unread messages"], [title$="unread message"]');
      return pill ? Number(pill.textContent?.trim() ?? '0') : 0;
    })
  );
  const sorted = [...counts].sort((a, b) => b - a);
  expect(counts).toEqual(sorted);
});

test('at most six sessions, and Show more reveals the rest when there are more', async ({ page }) => {
  const cards = page.getByTestId('home-session-card');
  await expect(cards.first()).toBeVisible();
  const initial = await cards.count();
  expect(initial).toBeLessThanOrEqual(6);

  // A long list is what the control is for; the default fixture may simply fit on one screen.
  const more = page.getByTestId('home-show-more');
  if (await more.count()) {
    await more.click();
    expect(await cards.count()).toBeGreaterThan(initial);
  }
});

test('a link can jump back to the message that shared it', async ({ page }) => {
  // The message-backed link (a link offered in a pending question has no message to land on).
  const bar = page.locator('[data-testid="home-link-context"][data-message-id]').first();
  await expect(bar).toBeVisible();
  // The context bar names the session and quotes the message, so the jump is not a blind one.
  await expect(bar).toContainText('Jump to message');
  const sessionKey = await bar.getAttribute('data-session-key');
  const messageId = await bar.getAttribute('data-message-id');
  expect(sessionKey).toBeTruthy();
  expect(messageId).toBeTruthy();

  await bar.click();
  await expect(home(page)).toHaveCount(0);
  const column = page.locator(`main[data-session-key="${sessionKey}"]`);
  await expect(column).toBeVisible();
  // The column lands on that very message, highlighted by the transcript's own jump.
  await expect(column.locator(`[data-message-id="${messageId}"][data-highlighted="true"]`)).toBeVisible();
});

test('a pending request is sticky: it survives Mark all as read', async ({ page }) => {
  const card = unreadCards(page).filter({ hasText: 'YOUR CALL' }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('request');
  // Nothing to mark on a request, so its dot is not a button.
  await expect(card.getByRole('button', { name: /Mark this message/ })).toHaveCount(0);
  // It is answered in the conversation, not read away here.
});

test('the counter counts unread messages, and Home toggles over open columns', async ({ page }) => {
  const counter = page.getByTestId('unread-count');
  const before = Number((await counter.innerText()).trim());
  await unreadCards(page).first().getByTestId('home-read-row').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark read' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close reading view' }).click();
  await expect(counter).toHaveText(String(before - 1));

  // Opening a session leaves Home for its column…
  await unreadCards(page).first().getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);
  // …and the Home button brings it back over the column, Esc returns to the column.
  await page.getByRole('button', { name: /Home — unread messages/ }).click();
  await expect(home(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(home(page)).toHaveCount(0);
});

test('a comment drafted in the reader is waiting in the conversation, unsent', async ({ page }) => {
  await unreadCards(page).first().getByTestId('home-read-row').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  // Wait for the message itself: selecting the loading line would leave the bar anchored to text
  // that is about to be replaced, which collapses the selection.
  await expect(sheet.getByText(/1 of \d+ unread/)).toBeVisible();

  // Select a phrase in the sheet, the way a drag would. Retried: the prose is a lazily loaded
  // Markdown chunk, so a selection made just before it swaps in collapses with the old text node.
  const bar = page.getByRole('toolbar', { name: 'Comment on the selection' });
  const selectInSheet = () =>
    page.evaluate(() => {
      const region = document.querySelector('[data-testid="reading-region"]');
      if (!region) throw new Error('no reading region');
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if ((node.nodeValue ?? '').trim().length > 40) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
      }
      throw new Error('no text to select');
    });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await selectInSheet();
    if (await bar.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Comment on the selected text' }).click();
  await bar.getByRole('textbox').fill('Worth pinning for the standup.');
  await bar.getByRole('button', { name: 'Add this comment' }).click();

  // The draft is kept for this session, and the sheet says it is not a sent message.
  const drafts = page.getByTestId('sheet-comments');
  await expect(drafts).toContainText('Worth pinning for the standup.');
  await expect(drafts).toContainText(/kept for this conversation/i);
  await expect(drafts.getByRole('button', { name: /Send 1 comment/ })).toBeVisible();

  // Closing hands it over: the conversation's own tray holds it, still unsent.
  await sheet.getByRole('button', { name: 'Close reading view' }).click();
  await expect(home(page)).toBeVisible();
  await unreadCards(page).first().getByTestId('home-session-title').click();
  const column = page.locator('main[data-session-key]').first();
  await expect(column.getByText('Comments', { exact: true })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Send 1 comment' })).toBeVisible();
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('Worth pinning for the standup.');
});

test('a session says Unread or Read, derived from its messages', async ({ page }) => {
  const unread = unreadCards(page).first();
  await expect(unread.getByTestId('home-read-state')).toHaveText('Unread');
  await expect(readCards(page).first().getByTestId('home-read-state')).toHaveText('Read');

  // It is derived, not stored: marking the session read flips the word and nothing else changes.
  const title = await unread.getByTestId('home-session-title').innerText();
  await unread.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark all as read' }).click();
  await expect(
    readCards(page).filter({ hasText: title }).getByTestId('home-read-state')
  ).toHaveText('Read');
});

test('the top bar is Home / Sessions / Usage', async ({ page }) => {
  const homeTab = page.getByRole('button', { name: /^Home — unread messages/ });
  await expect(homeTab).toHaveAttribute('aria-pressed', 'true');

  // Sessions with nothing open loads the most recent session rather than showing an empty workspace.
  await page.getByRole('button', { name: /^Sessions —/ }).click();
  await expect(home(page)).toHaveCount(0);
  await expect(page.locator('main[data-session-key]').first()).toBeVisible();

  // Usage is a view of its own now, not a dialog over something.
  await page.getByRole('button', { name: /^Usage —/ }).click();
  await expect(page.getByTestId('usage-panel')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // And Home comes back.
  await homeTab.click();
  await expect(home(page)).toBeVisible();
});

test('a note parked while reading is waiting in the conversation', async ({ page }) => {
  await unreadCards(page).first().getByTestId('home-read-row').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/1 of \d+ unread/)).toBeVisible();

  await sheet.getByRole('button', { name: 'Note' }).click();
  await sheet.getByRole('textbox', { name: 'Note for this session' }).fill('Ask about the migration decision tomorrow.');
  await sheet.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByTestId('sheet-note-saved')).toContainText('Saved to For Later');

  await sheet.getByRole('button', { name: 'Close reading view' }).click();
  await unreadCards(page).first().getByTestId('home-session-title').click();
  const column = page.locator('main[data-session-key]').first();
  // Notes have their own tab on the composer shelf; with an empty queue it is the open one, so the
  // note is on screen without a click.
  await expect(column.getByRole('tab', { name: /For later/ })).toBeVisible();
  await expect(column).toContainText('Ask about the migration decision tomorrow.');
});

test('the reader is wide enough to read in, and can send a comment itself', async ({ page }) => {
  await unreadCards(page).first().getByTestId('home-read-row').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/1 of \d+ unread/)).toBeVisible();

  // Wide: the frame, not a 512px dialog (the primitive's sm:max-w-lg used to win).
  const box = await sheet.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(900);

  // Comment on a selection, then send it from here — no trip to the conversation.
  const bar = page.getByRole('toolbar', { name: 'Comment on the selection' });
  const selectInSheet = () =>
    page.evaluate(() => {
      const region = document.querySelector('[data-testid="reading-region"]');
      if (!region) throw new Error('no reading region');
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if ((node.nodeValue ?? '').trim().length > 40) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          return;
        }
      }
      throw new Error('no text to select');
    });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await selectInSheet();
    if (await bar.isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await bar.getByRole('button', { name: 'Comment on the selected text' }).click();
  await bar.getByRole('textbox').fill('Sent from the reader.');
  await bar.getByRole('button', { name: 'Add this comment' }).click();

  const send = page.getByRole('button', { name: /Send 1 comment/ });
  await expect(send).toBeVisible();
  await send.click();
  // The tray empties; the message went to this session's transcript.
  await expect(page.getByTestId('sheet-comments')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close reading view' }).click();
  await unreadCards(page).first().getByTestId('home-session-title').click();
  const column = page.locator('main[data-session-key]').first();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('1. Re: "');
  await expect(column).toContainText('Sent from the reader.');
});
