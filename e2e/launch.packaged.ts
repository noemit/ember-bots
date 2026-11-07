import type {} from '../src/types';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the app produced by electron-builder, including its own bundled Kiln.
// Never substitutes a checkout binary: a wrong resource filename must fail this check.
test('the packaged app starts its bundled Kiln in a fresh profile', async () => {
  const executable = process.env.EMBER_PACKAGED_EXECUTABLE;
  test.skip(!executable, 'Set EMBER_PACKAGED_EXECUTABLE to the built app.');
  const profile = await mkdtemp(join(tmpdir(), 'ember-packaged-'));
  await mkdir(join(profile, 'workspace', 'Existing project'), { recursive: true });
  const workspace = await realpath(join(profile, 'workspace'));
  const env = { ...process.env, EMBER_DATA_DIR: profile, OPENCHAMBER_DATA_DIR: join(profile, 'openchamber') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EMBER_BUNDLED_HARNESS;
  const app = await electron.launch({ executablePath: resolve(executable!), env });
  let pid: number | undefined;
  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('onboarding')).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Setting up Ember Bots' })).toBeVisible();
    const headingRow = window.getByRole('heading', { name: 'Setting up Ember Bots' }).locator('..');
    await expect(headingRow).toHaveCSS('padding-top', '26px');
    await expect(headingRow).toHaveCSS('padding-bottom', '26px');
    await expect.poll(() => window.evaluate(async () => (await window.ember.getSettings()).localHarnessState?.kind), { timeout: 30000 }).toBe('started');
    pid = JSON.parse(await readFile(join(profile, 'ember-harness.lock'), 'utf8')).pid;
    const endpoint = await window.evaluate(async () => (await window.ember.getSettings()).piEndpoints.find(e => e.id === 'pi:local')!);
    const response = await fetch(`${endpoint.url}/health`, { headers: { authorization: `Bearer ${endpoint.token}` } });
    expect(response.ok).toBe(true);
    await window.getByRole('button', { name: /Where to run Kiln/ }).click();
    await expect(window.getByText('Kiln is running on this computer and Ember has its token.', { exact: true })).toBeVisible();
    if (process.env.EMBER_VERIFY_OPENAI_LOGIN === '1') {
      await window.getByRole('button', { name: /Choose an AI/ }).click();
      await window.getByRole('button', { name: 'OpenAI (ChatGPT Plus/Pro)', exact: true }).click();
      await expect(window.getByRole('button', { name: /Copy code/ })).toBeVisible({ timeout: 30000 });
      await expect(window.getByRole('heading', { name: 'Sign in to OpenAI (ChatGPT Plus/Pro)', exact: true })).toBeVisible();
      const link = window.getByRole('link', { name: 'Open auth.openai.com' });
      await expect(link).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
      await window.screenshot({ path: test.info().outputPath('packaged-openai-signin.png') });
      await window.getByRole('button', { name: 'Cancel', exact: true }).click();
      const cancelled = await window.evaluate(() => window.ember.piRequest!<{ status: string }>('pi:local', '/providers/openai-codex/login'));
      expect(cancelled.data.status).toBe('failed');
    }
    await window.getByRole('button', { name: /First agent/ }).click();
    await expect(window.getByTestId('onboarding').getByRole('button', { name: 'New agent', exact: true })).toBeDisabled();
    await window.getByRole('button', { name: 'Choose workspace' }).click();
    await window.getByRole('button', { name: 'Enter a folder path' }).click();
    await window.getByRole('textbox', { name: 'Folder path' }).fill(workspace);
    await window.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(window.getByRole('option', { name: 'Existing project', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'New folder', exact: false }).click();
    await window.getByRole('textbox', { name: 'New folder name' }).fill('Cancelled');
    await window.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await stat(join(workspace, 'Cancelled')).catch(() => null)).toBeNull();
    await window.getByRole('button', { name: 'New folder', exact: false }).click();
    await window.getByRole('textbox', { name: 'New folder name' }).fill('Existing project');
    await window.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(window.getByRole('dialog', { name: 'Choose your workspace', exact: true }).getByRole('alert')).toContainText('Try another name');
    await window.getByRole('textbox', { name: 'New folder name' }).fill('New workspace');
    await window.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(window.getByText('No subfolders here. You can use this folder.', { exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Use this workspace' }).click();
    expect((await stat(join(workspace, 'New workspace'))).isDirectory()).toBe(true);
    await expect.poll(() => window.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.workspaceDirectory))
      .toBe(join(workspace, 'New workspace'));
    await expect(window.getByTestId('onboarding').getByRole('button', { name: 'New agent', exact: true })).toBeEnabled();
    await window.screenshot({ path: test.info().outputPath('packaged-setup.png') });
    await window.evaluate(() => window.ember.setSettings({ theme: 'graphite' }));
    await window.reload();
    await window.getByRole('button', { name: /First agent/ }).click();
    await expect(window.getByRole('button', { name: 'Choose workspace' })).toHaveText('New workspace');
    await window.screenshot({ path: test.info().outputPath('packaged-setup-dark.png') });
  } finally {
    await app.close();
    if (pid) await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    await rm(profile, { recursive: true, force: true });
  }
});
