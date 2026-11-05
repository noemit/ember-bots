import { expect, test } from '@playwright/test';

/**
 * The send path's delivery states, end to end. A 2xx is confirmation (queued or placed) and the
 * transcript says so factually; only a definite failure offers Send again; an in-flight request
 * stays in its loading state for as long as it takes, with no time-based doubt.
 */

const openConversation = async (page: import('@playwright/test').Page, name: RegExp, key: string) => {
  await page.getByRole('button', { name }).first().click();
  const column = page.locator(`main[data-session-key="${key}"]`);
  await expect(column).toBeVisible();
  return column;
};

test('a definite failure keeps the message with Send again, never "may not have sent"', async ({ page }) => {
  await page.goto('/?failSubmit');
  const column = await openConversation(page, /Habit onboarding QA/, 'pi:hearth::10');
  const composer = column.locator('textarea');
  await composer.fill('this one fails');
  await composer.press('Enter');
  const row = column.getByRole('status').filter({ hasText: 'Not sent' });
  await expect(row).toBeVisible();
  // The message itself is still in the transcript, so nothing the user typed can vanish.
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('this one fails');
  await expect(row.getByRole('button', { name: 'Send again' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Discard' })).toBeVisible();
  // Send again replays the exact input, so it fails the same way rather than sending nothing.
  await row.getByRole('button', { name: 'Send again' }).click();
  await expect(column.getByRole('status').filter({ hasText: 'Not sent' })).toBeVisible();
});

test('an in-flight submit stays "Sending…" past 20s and is never doubted', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?slowSubmit');
  const column = await openConversation(page, /Habit onboarding QA/, 'pi:hearth::10');
  const composer = column.locator('textarea');
  await composer.fill('slow to answer');
  await composer.press('Enter');
  // A first message to Hearth is not shown as a bubble until the submit answers (a bubble that
  // later turns into a queue row is exactly the lie that path avoids), so the send button's
  // spinner is the loading state while the request is in flight.
  // The label flips to "Queue message" while a send is in flight (the session reads busy), so
  // match either: the spinner is what matters here.
  const sendButton = column.getByRole('button', { name: /^(Send|Queue message)$/ });
  await expect(sendButton.locator('svg.animate-spin')).toBeVisible();
  // Past the old 20s doubt deadline the send is still simply in flight.
  await page.waitForTimeout(21_000);
  await expect(sendButton.locator('svg.animate-spin')).toBeVisible();
  await expect(column.getByText('Not sent')).toHaveCount(0);
  // The server answers at 24s: that is confirmation, so the message lands with no note at all.
  await expect(sendButton.locator('svg.animate-spin')).toHaveCount(0, { timeout: 15_000 });
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('slow to answer');
  await expect(column.getByText('Not sent')).toHaveCount(0);
});

test('a queued steer reads as queued, never as a doubtful send', async ({ page }) => {
  // A "slow" prompt keeps the mock busy for 12s, which is what makes the steer queue.
  await page.goto('/');
  const column = await openConversation(page, /Habit onboarding QA/, 'pi:hearth::10');
  const composer = column.locator('textarea');
  await composer.fill('slow work please');
  await composer.press('Enter');
  await page.waitForTimeout(600);
  await composer.fill('steer into the running turn');
  await composer.press('Alt+Enter');
  // The queued steer keeps its bubble with a factual note about when it lands, and the way to take
  // it back — never "Not sent", because the host is holding it.
  await expect(column.getByRole('status').filter({ hasText: 'Waiting for the turn to pause.' })).toBeVisible();
  await expect(column.getByRole('status').filter({ hasText: 'Not sent' })).toHaveCount(0);
  await expect(column.getByRole('button', { name: /Withdraw this message/ })).toBeVisible();
});
