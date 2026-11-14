import { expect, test, type Page } from '@playwright/test';

async function settings(page: Page) {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
}
const add = (page: Page) => page.getByRole('region', { name: 'Add instance', exact: true });
async function remoteDraft(page: Page) {
  const area = add(page);
  await area.getByRole('button', { name: 'On another computer', exact: true }).click();
  await area.getByLabel('Instance name', { exact: true }).fill('Studio Mac');
  await area.getByLabel('Kiln URL', { exact: true }).fill('https://kiln.example.test');
  await area.getByLabel('Bearer token', { exact: true }).fill('synthetic-private-token');
  return area;
}

test('basic remote flow needs no network classification or advanced fields', async ({ page }) => {
  await settings(page);
  await expect(add(page).getByRole('button', { name: 'On this computer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const area = await remoteDraft(page);
  await expect(area.getByLabel('Cloudflare Access client ID')).toBeHidden();
  await expect(area.getByLabel('Bearer token', { exact: true })).toHaveCSS('-webkit-text-security', 'disc');
  await area.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(area.getByRole('status')).toContainText('Studio Mac answered as Kiln');
  await page.screenshot({ path: '/tmp/ember-instance-basic.png' });
  await area.getByRole('button', { name: 'Add instance', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Connected instances' })).toContainText('Studio Mac');
});

test('help and advanced Access credentials are progressive and removable', async ({ page }) => {
  await settings(page);
  const area = await remoteDraft(page);
  await area.getByText('Connection help', { exact: true }).click();
  await area.getByText('Cloudflare Tunnel', { exact: true }).click();
  await expect(area).toContainText('not Ember’s browser UI');
  await area.getByText('Advanced', { exact: true }).click();
  await area.getByLabel('Cloudflare Access client ID').fill('synthetic-client');
  await area.getByLabel('Cloudflare Access client secret').fill('synthetic-access-secret');
  await expect(area.getByLabel('Cloudflare Access client secret')).toHaveCSS('-webkit-text-security', 'disc');
  await page.screenshot({ path: '/tmp/ember-instance-advanced.png' });
  await area.getByRole('button', { name: 'Remove Access credentials' }).click();
  await expect(area.getByLabel('Cloudflare Access client ID')).toHaveValue('');
});

test('all structured diagnostics name the host and offer recovery, never raw secrets', async ({ page }) => {
  await settings(page);
  const area = await remoteDraft(page);
  for (const outcome of ['unreachable', 'auth-rejected', 'wrong-service', 'tls-error', 'timeout'] as const) {
    await page.evaluate(outcome => {
      window.ember.testPiEndpoint = async () => ({ outcome, host: 'Studio Mac', message: 'RAW synthetic-private-token synthetic-access-secret' });
    }, outcome);
    await area.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(area.getByRole('status')).toContainText('Studio Mac');
    await expect(area.getByRole('status')).toContainText('test again');
    await expect(area.getByRole('status')).not.toContainText('synthetic-');
  }
  await page.screenshot({ path: '/tmp/ember-instance-diagnostics.png' });
});

test('sharing requires enable then explicit reveal and clears details on disable', async ({ page }) => {
  await settings(page);
  const sharing = page.getByRole('region', { name: 'Share this Kiln', exact: true });
  await expect(sharing).toContainText('local only');
  await expect(sharing.getByLabel('Shared Kiln URL')).toHaveCount(0);
  await sharing.getByRole('button', { name: 'Enable remote Kiln access' }).click();
  await expect(sharing.getByLabel('Shared Kiln URL')).toHaveCount(0);
  await sharing.getByRole('button', { name: 'Reveal connection details' }).click();
  await expect(sharing.getByLabel('Shared Kiln URL')).toHaveValue('http://100.64.0.99:3003');
  await expect(sharing).toContainText('57821');
  await expect(sharing).toContainText('closing the window does not quit');
  await page.screenshot({ path: '/tmp/ember-instance-sharing.png' });
  await sharing.getByRole('button', { name: 'Turn off remote Kiln access' }).click();
  await expect(sharing.getByLabel('Shared Kiln URL')).toHaveCount(0);
});

test('remote browser cannot change host sharing or connection credentials', async ({ page }) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => !!window.ember?.getSettings);
  await page.evaluate(() => {
    delete window.ember.kilnSharing;
    delete window.ember.kilnSharingDetails;
    delete window.ember.testPiEndpoint;
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  await expect(add(page)).toContainText('remote browser cannot enable');
  await add(page).getByRole('button', { name: 'On another computer', exact: true }).click();
  await expect(add(page)).toContainText('Open Ember on the desktop');
  await expect(add(page).getByLabel('Bearer token')).toHaveCount(0);
});


test('a blocked but enabled share can still be turned off', async ({ page }) => {
  await page.goto('/?noDock');
  await page.waitForFunction(() => !!window.ember?.getSettings);
  await page.evaluate(() => {
    window.ember.kilnSharing = async action => action === 'disable'
      ? { state: 'off', enabled: false, message: 'This computer’s Kiln is local only.' }
      : { state: 'blocked', enabled: true, message: 'This computer’s sharing is enabled but Tailscale is unavailable. Turn off sharing below or restore the connection.' };
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  const sharing = page.getByRole('region', { name: 'Share this Kiln', exact: true });
  await sharing.getByRole('button', { name: 'Turn off remote Kiln access' }).click();
  await expect(sharing).toContainText('local only');
});
