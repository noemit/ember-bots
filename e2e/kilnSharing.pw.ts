import { expect, test } from '@playwright/test';

test('Add connection asks where, keeps help optional, tests a draft and saves desktop gate credentials', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    window.ember.testPiEndpoint = async endpoint => ({ outcome: 'ready', host: endpoint.label, message: 'Synthetic readiness report' });
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  const area = page.getByRole('region', { name: 'Add connection', exact: true });
  await expect(area.getByRole('group', { name: 'Where is Kiln running?' })).toBeVisible();
  await expect(area.getByRole('textbox', { name: 'Kiln URL', exact: true })).toHaveCount(0);
  await area.getByRole('button', { name: 'On another computer or container', exact: true }).click();
  await area.getByLabel('Computer or container name', { exact: true }).fill('Test Tower');
  await area.getByLabel('Kiln URL', { exact: true }).fill('https://kiln.example.test');
  await area.getByLabel('Bearer token', { exact: true }).fill('synthetic-kiln-token');
  await expect(area.getByLabel('Cloudflare Access client secret')).toBeHidden();
  await area.getByText('Advanced', { exact: true }).click();
  await area.getByLabel('Cloudflare Access client ID').fill('synthetic-access-id');
  await area.getByLabel('Cloudflare Access client secret').fill('synthetic-access-secret');
  await expect(area.getByLabel('Cloudflare Access client secret')).toHaveCSS('-webkit-text-security', 'disc');
  await area.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(area.getByRole('status')).toContainText('Test Tower');
  await expect(area.getByRole('status')).toContainText('accepted the token');
  await area.getByRole('button', { name: 'Add connection', exact: true }).click();
  // This is the in-memory dev fixture; real desktop secrets remain OS-encrypted and masked.
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).piEndpoints.find(e => e.label === 'Test Tower')?.access?.clientSecret)).toBe('synthetic-access-secret');
  await page.screenshot({ path: '/tmp/ember-kiln-sharing-add.png', fullPage: true });
});

test('safe one-click sharing keeps main’s explicit enable and separate credential reveal flow', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    let enabled = false;
    (window as unknown as { sharingCalls: string[] }).sharingCalls = [];
    window.ember.kilnSharing = async action => {
      (window as unknown as { sharingCalls: string[] }).sharingCalls.push(action);
      if (action === 'enable') enabled = true;
      if (action === 'disable') enabled = false;
      return { state: enabled ? 'ready' : 'off', enabled, canChange: true, message: 'Mocked conditional Tailscale update. Test from the other computer.', ...(enabled ? { url: 'http://100.72.1.9:3002' } : {}), instructions: 'tailscale serve status --json' };
    };
    window.ember.kilnSharingDetails = async () => enabled ? { url: 'http://100.72.1.9:3002', token: 'synthetic-only' } : null;
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  await page.getByRole('tab', { name: 'Remote access', exact: true }).click();
  const area = page.getByRole('region', { name: 'Share this Kiln' });
  await expect(area).toContainText('included Kiln stops when you quit Ember');
  await expect(area).toContainText('57821');
  await expect(area.getByRole('button', { name: 'Enable remote Kiln access', exact: true })).toBeVisible();
  expect((await page.evaluate(() => (window as unknown as { sharingCalls: string[] }).sharingCalls)).every(action => action === 'inspect')).toBe(true);
  await area.getByRole('button', { name: 'Enable remote Kiln access', exact: true }).click();
  await expect(area.getByLabel('Shared Kiln URL')).toHaveCount(0);
  expect((await page.evaluate(() => (window as unknown as { sharingCalls: string[] }).sharingCalls)).filter(action => action !== 'inspect')).toEqual(['enable']);
  await area.getByRole('button', { name: 'Reveal connection details', exact: true }).click();
  await expect(area.getByLabel('Shared Kiln URL')).toHaveValue('http://100.72.1.9:3002');
  await page.screenshot({ path: '/tmp/ember-kiln-sharing-host.png', fullPage: true });
  await area.getByRole('button', { name: 'Turn off remote Kiln access', exact: true }).click();
  await expect(area.getByLabel('Shared Kiln URL')).toHaveCount(0);
  expect((await page.evaluate(() => (window as unknown as { sharingCalls: string[] }).sharingCalls)).filter(action => action !== 'inspect')).toEqual(['enable', 'disable']);
});

test('unsupported platform cannot offer mutation controls and keeps recovery and manual commands visible', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    window.ember.kilnSharing = async () => ({ state: 'blocked', enabled: false, canChange: false, message: 'Tailscale native authentication is not supported here. Review the commands on this host; Ember will not use unsafe CLI writes.', instructions: 'tailscale serve status --json' });
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  await page.getByRole('tab', { name: 'Remote access', exact: true }).click();
  const area = page.getByRole('region', { name: 'Share this Kiln' });
  await area.getByRole('button', { name: 'Check sharing', exact: true }).click();
  await expect(area).toContainText('will not use unsafe CLI writes');
  await expect(area.getByRole('button', { name: /Enable remote Kiln access|Turn off remote Kiln access/ })).toHaveCount(0);
  await area.locator('summary', { hasText: 'Reviewed Tailscale commands' }).click();
  await expect(area.getByRole('button', { name: 'Copy commands' })).toBeVisible();
});

test('browser remote capability never invites endpoint secret entry or editing', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.ember?.piRequest));
  await page.evaluate(() => {
    window.ember.capabilities = { dockIcon: false, endpointManagement: false };
    delete window.ember.testPiEndpoint;
    delete window.ember.kilnSharing;
    delete window.ember.kilnSharingDetails;
    delete window.ember.localHarnessToken;
  });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  const area = page.getByRole('region', { name: 'Add connection', exact: true });
  await area.getByRole('button', { name: 'On another computer or container', exact: true }).click();
  await expect(area).toContainText('Open Ember on the desktop');
  await expect(area.getByRole('textbox', { name: /Bearer token|Cloudflare Access/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit ember-harness/ })).toHaveCount(0);
});
