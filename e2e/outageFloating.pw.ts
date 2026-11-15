import { expect, test, type Page } from '@playwright/test';

const toast = (page: Page) => page.getByTestId('instance-outage-toast');
async function hitTest(page: Page) {
  const button = toast(page).first().getByRole('button', { name: /Retry/ });
  await expect(button).toBeVisible();
  await expect.poll(() => button.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}

test('floating warnings survive real rail scrolling, width changes and mobile closure', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/?outage&noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expect(toast(page)).toBeVisible();
  const scroll = page.locator('[data-rail-scroll]');
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await hitTest(page);
  await expect(page.locator('aside [data-testid="instance-outage-toast"]')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/outage-evidence/normal-bottom.png' });
  await page.getByRole('button', { name: 'Widen the session list', exact: true }).click();
  await hitTest(page);
  await page.screenshot({ path: '/tmp/outage-evidence/wide.png' });
  await page.getByRole('button', { name: 'Collapse the session list', exact: true }).click();
  await hitTest(page);
  await page.screenshot({ path: '/tmp/outage-evidence/mini.png' });
  await toast(page).getByRole('button', { name: /Retry/ }).click();
  await expect(toast(page)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/outage-evidence/mobile-before.png' });
  await hitTest(page);
  await expect(page.getByRole('button', { name: 'Toggle sessions sidebar' })).toBeVisible();
  await page.screenshot({ path: '/tmp/outage-evidence/mobile-closed.png' });
  await page.getByRole('button', { name: 'Toggle sessions sidebar' }).click();
  await hitTest(page);
  await page.screenshot({ path: '/tmp/outage-evidence/mobile-open.png' });
});

test('unsupported and many hosts have bounded notices below Settings', async ({ page }) => {
  await page.goto('/?outage&noDock');
  await expect(toast(page)).toBeVisible();
  await page.evaluate(() => {
    const bridge = window.ember as unknown as { listInstances: () => Promise<unknown[]> };
    bridge.listInstances = async () => [
      { id: 'pi:hearth', label: 'Hearth', kind: 'pi', status: 'ready', attachable: true },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 'down' + i, label: 'Tower ' + i, kind: 'pi', status: 'unsupported', attachable: false })),
    ];
    window.dispatchEvent(new Event('online'));
  });
  await expect(toast(page)).toHaveCount(8);
  await expect(toast(page).first().getByRole('button', { name: /Stop warning/ })).toHaveCount(0);
  const stack = page.getByLabel('Connection warnings', { exact: true });
  expect(await stack.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: '/tmp/outage-evidence/multi-host.png' });
  await toast(page).first().getByRole('button', { name: /Connection settings/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await toast(page).first().evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + 20, r.y + 20));
  })).toBe(false);
  await page.screenshot({ path: '/tmp/outage-evidence/settings-above.png' });
});

test('notices leave approval controls clear and do not take focus on a poll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?outage&noDock');
  await page.getByRole('button', { name: 'Toggle sessions sidebar' }).click();
  await page.getByRole('button', { name: /Wire the pi mock/ }).first().click();
  const allow = page.getByRole('button', { name: 'Allow once', exact: true });
  await allow.scrollIntoViewIfNeeded();
  await expect(allow).toBeVisible();
  expect(await allow.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await allow.focus();
  await page.evaluate(() => {
    const status = document.querySelector('[aria-label="Connection notices"] [role="status"]')!;
    status.setAttribute('data-changes', '0');
    new MutationObserver(records => status.setAttribute('data-changes', String(Number(status.getAttribute('data-changes')) + records.length)))
      .observe(status, { childList: true, characterData: true, subtree: true });
    window.dispatchEvent(new Event('online'));
  });
  await expect(toast(page).getByRole('button', { name: /Retry/ })).toBeEnabled();
  await expect(allow).toBeFocused();
  await expect(page.locator('[aria-label="Connection notices"] [role="status"]')).toHaveAttribute('data-changes', '0');
  await hitTest(page);
  await page.screenshot({ path: '/tmp/outage-evidence/mobile-approval.png' });
  await allow.click();
  await expect(allow).toHaveCount(0);
});
