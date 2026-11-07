import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/types';

type LoginProbe = { complete: boolean; starts: number; polls: number; cancels: number; releaseOld?: () => void };

const openLogin = async (page: Page, scenario: 'lost' | 'stale') => {
  await page.goto('/?fixture=onboarding');
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await page.evaluate((scenario) => {
    const original = window.ember.piRequest!;
    const probe: LoginProbe = { complete: false, starts: 0, polls: 0, cancels: 0 };
    (window as Window & { loginProbe: LoginProbe }).loginProbe = probe;
    const pending = { status: 'pending', events: [{ type: 'device_code', userCode: 'TEST-CODE', verificationUri: 'https://auth.openai.com/codex/device' }] };
    window.ember.piRequest = async (endpoint, path, init) => {
      const reply = (data: unknown, status = 200) => ({ ok: status === 200, status, data: data as never });
      if (path === '/providers') return reply({ providers: [{ id: 'openai-codex', name: 'OpenAI Codex (legacy)', credential: null,
        signIn: { label: 'OpenAI (ChatGPT Plus/Pro)' } }] });
      if (path === '/providers/openai-codex/login') {
        if (init?.method === 'POST') {
          probe.starts++;
          if (scenario === 'stale' && probe.starts === 1) return new Promise(resolve => {
            probe.releaseOld = () => resolve(reply({ status: 'failed', events: [], error: 'Superseded attempt' }));
          });
          return reply(pending);
        }
        if (init?.method === 'DELETE') { probe.cancels++; return reply({ cancelled: true }); }
        probe.polls++;
        return probe.complete ? reply({ status: 'complete', events: [], credentialType: 'oauth' })
          : scenario === 'lost' ? reply({ error: 'No login in progress' }, 404) : reply(pending);
      }
      return original(endpoint, path, init);
    };
  }, scenario);
  await page.getByRole('button', { name: /Choose an AI/ }).click();
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click();
  await page.getByRole('button', { name: 'OpenAI (ChatGPT Plus/Pro)', exact: true }).click();
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Sign in to OpenAI (ChatGPT Plus/Pro)', exact: true }) });
};

test('a lost sign-in is not success; retry waits for explicit completion', async ({ page }) => {
  const dialog = await openLogin(page, 'lost');
  await expect(dialog.getByRole('alert')).toContainText('cannot confirm');
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Confirm instance default', includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => { (window as Window & { loginProbe: LoginProbe }).loginProbe.complete = true; });
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await dialog.getByText('If OpenAI won’t accept the code', { exact: true }).click();
  await expect(dialog).toContainText('ChatGPT security settings');
  await expect(dialog.getByText('OpenAI (ChatGPT Plus/Pro) is connected.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('region', { name: 'Confirm instance default' })).toHaveCount(1);
});

test('a superseded start cannot overwrite the current code or start another poll loop', async ({ page }) => {
  const dialog = await openLogin(page, 'stale');
  // StrictMode mounts twice. Delay the first response until its successor has a device code.
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await page.evaluate(() => { (window as Window & { loginProbe: LoginProbe }).loginProbe.releaseOld?.(); });
  await expect.poll(() => page.evaluate(() => (window as Window & { loginProbe: LoginProbe }).loginProbe.polls)).toBeGreaterThan(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { loginProbe: LoginProbe }).loginProbe.cancels)).toBe(1);
});
