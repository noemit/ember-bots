import { expect, test } from '@playwright/test';

/**
 * Starting a new agent, from the keystroke to the session.
 *
 * The create is the one request whose answer the person waits on with nothing else to look at, so
 * these tests pin the three promises that make that wait honest: the message is on screen at once,
 * a refusal belongs to the pane it happened in (with the ways out), and a create that landed while
 * the person was elsewhere says so instead of moving them.
 *
 * The mock's fixtures (`src/dev/mockPi.ts`) hold the create (`?slowCreate`), refuse it once
 * (`?failCreate`), or create the conversation and drop the answer (`?dropCreate` — the ambiguous
 * failure that must not become a second session).
 */

/** A rail row's accessible name when the session is named the new way: `<Adjective> <noun>`. */
const RAIL_TITLE = /^[A-Z][a-z]+ [A-Z][a-z]+/;

const newAgent = async (page: import('@playwright/test').Page, query = '') => {
  await page.goto(`/${query}`);
  await page.getByRole('button', { name: 'New agent' }).first().click();
  // The draft is ready when its destination row exists.
  await expect(page.getByRole('textbox', { name: 'New agent folder' })).toBeVisible();
  return page.locator('textarea').first();
};

test('the message is on screen before the host answers, and the composer stays usable', async ({ page }) => {
  const composer = await newAgent(page, '?slowCreate');
  await composer.fill('check the build output');
  await composer.press('Enter');

  // Enter did something visible, immediately, without waiting for the create.
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('check the build output', { timeout: 1_000 });
  await expect(page.getByText(/Starting this session on/)).toBeVisible();

  // The draft does not become an unresponsive pane: the composer still takes the next thought.
  await composer.fill('and then run the tests');
  await composer.press('Enter');
  await expect(page.getByText('Sends once this session has started.')).toBeVisible();

  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());

  // One column, holding both messages in the order they were typed — and no draft left behind.
  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  const conversation = column.getByRole('log', { name: 'Conversation' });
  await expect(conversation).toContainText('check the build output');
  await expect(conversation).toContainText('and then run the tests');
  await expect(page.getByRole('textbox', { name: 'New agent folder' })).toHaveCount(0);
  // Each message appears once, in the order it was typed: the draft's bubbles became the session's,
  // they were not sent a second time on the way.
  const rows = conversation.locator('[data-message-id]');
  await expect(rows.first()).toHaveText('check the build output');
  await expect(rows.nth(1)).toContainText('Echo from Hearth: check the build output');
  await expect(rows.nth(2)).toHaveText('and then run the tests');
});

test('a note parked while the session starts joins its For later tray', async ({ page }) => {
  const composer = await newAgent(page, '?slowCreate');
  await composer.fill('start it after all');
  await composer.press('Enter');
  await expect(page.getByText(/Starting this session on/)).toBeVisible();

  // The draft has no session to park a note for, so the attempt holds it.
  await composer.fill('ask about the flaky test');
  await composer.press('ControlOrMeta+Enter');
  await expect(page.getByText(/For later: “ask about the flaky test”/)).toBeVisible();
  await expect(composer).toHaveValue('');

  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());

  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  // The note is the session's now: the same For later tray as any note saved in a column.
  await expect(column.getByRole('tab', { name: /For later/ })).toContainText('1');
  await expect(column.getByRole('tab', { name: /For later/ })).toBeVisible();
});

test('a refusal is shown in the pane, and Try again starts the session once the row is fixed', async ({ page }) => {
  const composer = await newAgent(page, '?failCreate');
  await composer.fill('retry me');
  await composer.press('Enter');

  const failure = page.getByRole('status').filter({ hasText: "didn't start this session" });
  await expect(failure).toBeVisible();
  // The reason names the host and the folder, and the folder is on screen below it.
  await expect(failure).toContainText('Hearth (mock)');
  await expect(failure).toContainText('/workspace/hearth');
  await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Edit' })).toBeVisible();
  // Not duplicated in the top bar, which is for news about something else.
  await expect(page.getByRole('alert')).toHaveCount(0);

  // The fixture refuses once, so the same folder is enough: the retry starts the session there.
  await page.getByRole('button', { name: 'Try again' }).click();
  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('retry me');
  // One user bubble: the message was sent once, on the retry.
  await expect(column.getByRole('log', { name: 'Conversation' }).locator('[data-message-id]').first()).toHaveText(
    'retry me'
  );
});

test('Edit puts the refused message back in the composer', async ({ page }) => {
  const composer = await newAgent(page, '?failCreate');
  await composer.fill('edit me instead');
  await composer.press('Enter');
  const failure = page.getByRole('status').filter({ hasText: "didn't start this session" });
  await failure.getByRole('button', { name: 'Edit' }).click();

  // Back to the draft pane, with the message where it can be changed and sent again.
  await expect(page.getByRole('textbox', { name: 'New agent folder' })).toBeVisible();
  await expect(page.locator('textarea').first()).toHaveValue('edit me instead');
  await expect(page.getByRole('log', { name: 'Conversation' })).toHaveCount(0);
});

test('leaving the draft lets the create finish, and offers the session instead of moving the reader', async ({ page }) => {
  const composer = await newAgent(page, '?slowCreate');
  await composer.fill('background start');
  await composer.press('Enter');
  await expect(page.getByText(/Starting this session on/)).toBeVisible();

  // The person moves on to another conversation while the create is still out.
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).first().click();
  const reading = page.locator('main[data-session-key]');
  const readingKey = await reading.getAttribute('data-session-key');

  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());

  // The session is real, and the rail says so — but the reader is not pulled off what they opened.
  await expect(page.getByText(/Started “.*” on Hearth \(mock\)\./)).toBeVisible();
  await expect(reading).toHaveAttribute('data-session-key', readingKey ?? '');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('main[data-session-key]')).not.toHaveAttribute('data-session-key', readingKey ?? '');
  await expect(page.locator('main[data-session-key]').getByRole('log', { name: 'Conversation' })).toContainText(
    'background start'
  );
});

test('a refusal that happens while the reader is elsewhere offers the draft back, not a silent loss', async ({ page }) => {
  const composer = await newAgent(page, '?slowCreate&failCreate');
  await composer.fill('fails while away');
  await composer.press('Enter');
  await expect(page.getByText(/Starting this session on/)).toBeVisible();

  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).first().click();
  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());

  // The banner carries the reason and one action, and the action returns to the pane that failed.
  const banner = page.getByRole('alert').filter({ hasText: "didn't start this session" });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Show', exact: true }).click();

  const failure = page.getByRole('status').filter({ hasText: "didn't start this session" });
  await expect(failure).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New agent folder' })).toBeVisible();
  // The attempt is still the one that failed, not a fresh empty draft: Try again reuses its message.
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('fails while away');
});

test('a create whose answer was lost is adopted on retry, never created twice', async ({ page }) => {
  const composer = await newAgent(page, '?dropCreate');
  await composer.fill('ambiguous create');
  await composer.press('Enter');

  const failure = page.getByRole('status').filter({ hasText: /stopped answering partway through/ });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Check the rail before you try again');

  await failure.getByRole('button', { name: 'Try again' }).click();

  // The conversation the lost answer had already made is the one the message lands in: one row in
  // the rail, one column, one copy of the message.
  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('ambiguous create');
  // One user bubble: the adopted conversation carries the message once, like any other send.
  await expect(column.getByRole('log', { name: 'Conversation' }).locator('[data-message-id]').first()).toHaveText(
    'ambiguous create'
  );
  // One row: the adopted conversation, never a second one. Its title is `<Adjective> <noun>` from
  // the naming roster, which is what `lib/sessionNames` tests exhaustively — not a word lifted from
  // the message, which is the shape the owner rejected ("What Gardener", "Ambiguous Create Gardener").
  await expect(page.locator('aside').getByRole('button', { name: RAIL_TITLE })).toHaveCount(1);
  await expect(page.locator('aside').getByRole('button', { name: /Ambiguous/ })).toHaveCount(0);
});

test('a create that succeeds but whose send fails lands in the session, without a banner', async ({ page }) => {
  const composer = await newAgent(page, '?failSubmit');
  await composer.fill('this one fails');
  await composer.press('Enter');

  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  // The failure is the bubble's, with its ways out — the session itself exists.
  await expect(column.getByRole('status').filter({ hasText: 'Not sent' })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Send again' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
