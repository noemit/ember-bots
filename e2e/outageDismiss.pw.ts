import { expect, test, type Page } from '@playwright/test';

/**
 * A host that is down has to be answerable, not just announced.
 *
 * The rail's outage row is the whole truth about a dead host ("Not answering", its last-known
 * sessions still listed below), and it has no other surface: one blip — a laptop that slept, a
 * Hearth restarting — used to leave it above every session for good, with no way to say "I know".
 *
 * `?outage` gives the pi mock a second endpoint that is down; nothing else in the mock produces an
 * unreachable host. The rules under test are the ones the feature turns on: dismissing hides the
 * warning and nothing else, an answering host clears the dismissal (so the next outage warns), and
 * an explicit reprobe is "asking again", so it un-hides what was dismissed.
 */

const silentRow = (page: Page) => page.locator('aside [data-testid="rail-silent-instance"]');

test.beforeEach(async ({ page }) => {
  await page.goto('/?outage&noDock');
  // The rail only exists in the workspace, so open a conversation first.
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(page.locator('main[data-session-key="pi:hearth::10"]')).toBeVisible();
});

test('a down host is named, says what the list below it is, and offers both Retry and Dismiss', async ({ page }) => {
  const row = silentRow(page);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Studio Mac');
  await expect(row).toContainText('Not answering');
  // The sentence never claims the sessions were deleted, and Dismiss is reachable by name.
  await expect(row).toContainText(/not listed|asleep or off the network/i);
  await expect(row.getByRole('button', { name: 'Retry Studio Mac' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Stop warning about Studio Mac' })).toBeVisible();
  // The top bar keeps telling the truth about the host count even before anything is dismissed.
  await expect(page.getByRole('button', { name: 'Instances', exact: true })).toContainText('1/2');
});

test('dismissing hides the warning, leaves the sessions, and offers Undo', async ({ page }) => {
  await silentRow(page).getByRole('button', { name: 'Stop warning about Studio Mac' }).click();
  await expect(silentRow(page)).toHaveCount(0);
  // Nothing else moved: the other host's sessions are exactly where they were.
  await expect(page.locator('aside')).toContainText('Remote access hardening');
  await expect(page.locator('aside')).toContainText('Habit onboarding QA');
  // Dismissal is a statement about the warning, not a claim that the host is back.
  await expect(page.getByRole('button', { name: 'Instances', exact: true })).toContainText('1/2');

  const notice = page.getByRole('status').filter({ hasText: 'No more warnings about Studio Mac' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(silentRow(page)).toHaveCount(1);
});

test('reprobing is asking again, so it brings a dismissed warning back', async ({ page }) => {
  await silentRow(page).getByRole('button', { name: 'Stop warning about Studio Mac' }).click();
  await expect(silentRow(page)).toHaveCount(0);

  // The row is gone, so the only route left is the Instances menu — and it has to work, or a
  // dismissal would be a dead end with no way back short of restarting the app.
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Reprobe instances/ }).click();
  await expect(silentRow(page)).toHaveCount(1);
});

test('an answering host clears the dismissal, so the next outage warns again', async ({ page }) => {
  await silentRow(page).getByRole('button', { name: 'Stop warning about Studio Mac' }).click();
  await expect(silentRow(page)).toHaveCount(0);

  /**
   * The host answers, and nobody touches the rail: a restored network is the app's own "look
   * again" (`online` reprobes), and a healthy host is the only thing allowed to clear a dismissal
   * — otherwise a dismissal would silence every future outage on that host.
   */
  const report = async (status: 'ready' | 'unreachable') => {
    await page.evaluate((next) => {
      const bridge = window.ember as unknown as { listInstances: () => Promise<unknown[]> };
      bridge.listInstances = async () => [
        { id: 'pi:hearth', label: 'Hearth (mock)', kind: 'pi', url: 'http://127.0.0.1:3002', status: 'ready', attachable: true },
        { id: 'pi:studio', label: 'Studio Mac', kind: 'pi', url: 'http://127.0.0.1:3009', status: next, attachable: next === 'ready' },
      ];
      window.dispatchEvent(new Event('online'));
    }, status);
  };

  await report('ready');
  await expect(page.getByRole('button', { name: 'Instances', exact: true })).toContainText('2/2');
  // Still nothing to warn about while it is up — the point is what happens next.
  await expect(silentRow(page)).toHaveCount(0);

  await report('unreachable');
  await expect(page.getByRole('button', { name: 'Instances', exact: true })).toContainText('1/2');
  await expect(silentRow(page)).toHaveCount(1);
});
