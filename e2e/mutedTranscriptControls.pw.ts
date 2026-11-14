import { expect, test, type Page, type Locator } from '@playwright/test';

const readButtons = (chat: Locator) => chat.getByRole('button', { name: /^(Mark this message as read|Message marked as read)$/ });
const marks = (page: Page) => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
async function mute(page: Page, chat: Locator, value: boolean) {
  await chat.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitem', { name: value ? /New messages: Don't notify/ : /New messages: Notify/ }).click();
  await page.keyboard.press('Escape');
}

test('muting hides multi-reply prompts, cancels a held receipt and restores only existing unread eligibility', async ({ page }) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const chat = page.locator('main[data-session-key="pi:hearth::16"]');
  await expect(chat.getByRole('button', { name: 'Mark all as read', exact: true })).toBeVisible();
  const latest = chat.locator('[data-message-id="e93"]');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await latest.getByRole('button', { name: 'Mark this message as read', exact: true }).click();
  await expect(chat.locator('[data-read-toast]')).toBeVisible();
  // Hold the receipt's timer while opening the session menu so muting must remove it itself.
  await chat.locator('[data-read-toast] button').focus();
  const afterExplicitRead = await marks(page);
  await mute(page, chat, true);
  await expect(chat.locator('[data-unread-navigation], [data-read-toast], [data-read-confirming]')).toHaveCount(0);
  await expect(readButtons(chat)).toHaveCount(0);
  await expect(chat.getByTestId('thread-question').first()).toBeVisible();
  expect(await marks(page)).toEqual(afterExplicitRead);
  await expect(latest.getByRole('button', { name: 'Copy message', exact: true }).first()).toBeAttached();
  await expect(latest.getByRole('button', { name: 'Reply to this message', exact: true })).toBeAttached();
  // An intentional context-menu command remains available; it does not re-enable notifications.
  await latest.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Mark as unread', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const user = chat.locator('[data-message-id="e90"]');
  await expect(user).toBeAttached();
  await expect(readButtons(user)).toHaveCount(0);
  await mute(page, chat, false);
  await expect(chat.locator('[data-read-toast]')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: /New unread messages/ })).toBeVisible();
  await expect(latest.getByRole('button', { name: 'Mark this message as read', exact: true })).toHaveCount(0);
  await expect(chat.locator('[data-message-id="e91"]').getByRole('button', { name: 'Mark this message as read', exact: true })).toBeVisible();
  expect(await marks(page)).toEqual(afterExplicitRead);
});

test('same-id chats on two hosts have independent muted transcript controls in split columns', async ({ page }) => {
  // In-memory fixture only: both mock hosts serve id 10. No live settings or endpoint is used.
  await page.route('**/src/dev/mockPi.ts', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nconst muteTestHosts = await bridge.listInstances(false); bridge.listInstances = async () => [...muteTestHosts, { ...muteTestHosts[0], id: "pi:tower", label: "Tower mock" }]; Object.assign(await bridge.getSettings(), { splitView: true, openSessions: ["pi:hearth::10", "pi:tower::10"], activeSession: "pi:hearth::10", mutedSessions: ["pi:hearth::10"] });\n' });
  });
  await page.goto('/?noDock');
  const muted = page.locator('main[data-session-key="pi:hearth::10"]');
  const other = page.locator('main[data-session-key="pi:tower::10"]');
  await expect(muted).toBeVisible();
  await expect(other).toBeVisible();
  const before = await marks(page);
  await expect(muted.locator('[data-unread-navigation]')).toHaveCount(0);
  await expect(readButtons(muted)).toHaveCount(0);
  await expect(other.getByRole('button', { name: /New unread messages/ })).toBeVisible();
  await expect(readButtons(other)).toHaveCount(1);
  await mute(page, other, true);
  await expect(readButtons(other)).toHaveCount(0);
  await mute(page, muted, false);
  await expect(readButtons(muted)).toHaveCount(1);
  await expect(readButtons(other)).toHaveCount(0);
  expect(await marks(page)).toEqual(before);
});

for (const unmuteBeforeTimer of [false, true]) {
test(`a pending message click cannot acknowledge across mute${unmuteBeforeTimer ? ' and unmute' : ''}`, async ({ page }) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const chat = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(readButtons(chat)).toHaveCount(1);
  const before = await marks(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await chat.locator('[data-message-id="e2"] .conversation-prose p').first().click();
  await mute(page, chat, true);
  await expect(readButtons(chat)).toHaveCount(0);
  if (unmuteBeforeTimer) await mute(page, chat, false);
  await page.clock.runFor(1000);
  expect(await marks(page)).toEqual(before);
  await expect(chat.locator('[data-read-toast]')).toHaveCount(0);
  if (!unmuteBeforeTimer) await mute(page, chat, false);
  await expect(readButtons(chat)).toHaveCount(1);
});
}

test('muted chats retain ordinary last-message navigation without acknowledging replies', async ({ page }) => {
  await page.goto('/?fixture=long-messages&noDock');
  const chat = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(chat).toBeVisible();
  const before = await marks(page);
  await mute(page, chat, true);
  await expect(chat.locator('[data-unread-navigation]')).toHaveCount(0);
  await expect(readButtons(chat)).toHaveCount(0);
  const jump = chat.getByRole('button', { name: '↑ Jump to your last message', exact: true });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(chat.locator('[data-message-id="e3"]')).toBeInViewport();
  expect(await marks(page)).toEqual(before);
});
