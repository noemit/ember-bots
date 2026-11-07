import type {} from '../src/types';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Runs the app produced by electron-builder, including its own bundled Kiln.
// Never substitutes a checkout binary: a wrong resource filename must fail this check.
test('the packaged app starts its bundled Kiln in a fresh profile', async () => {
  const executable = process.env.EMBER_PACKAGED_EXECUTABLE;
  test.skip(!executable, 'Set EMBER_PACKAGED_EXECUTABLE to the built app.');
  const profile = await mkdtemp(join(tmpdir(), 'ember-packaged-'));
  const env = { ...process.env, EMBER_DATA_DIR: profile, OPENCHAMBER_DATA_DIR: join(profile, 'openchamber') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EMBER_BUNDLED_HARNESS;
  const app = await electron.launch({ executablePath: resolve(executable!), env });
  let pid: number | undefined;
  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('onboarding')).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Setting up Ember Bots' })).toBeVisible();
    await expect.poll(() => window.evaluate(async () => (await window.ember.getSettings()).localHarnessState?.kind), { timeout: 30000 }).toBe('started');
    pid = JSON.parse(await readFile(join(profile, 'ember-harness.lock'), 'utf8')).pid;
    const endpoint = await window.evaluate(async () => (await window.ember.getSettings()).piEndpoints.find(e => e.id === 'pi:local')!);
    const response = await fetch(`${endpoint.url}/health`, { headers: { authorization: `Bearer ${endpoint.token}` } });
    expect(response.ok).toBe(true);
    if (process.env.EMBER_VERIFY_OPENAI_LOGIN === '1') {
      await window.getByRole('button', { name: /Choose an AI/ }).click();
      await window.getByRole('button', { name: 'OpenAI (ChatGPT Plus/Pro)', exact: true }).click();
      await expect(window.getByRole('button', { name: /Copy code/ })).toBeVisible({ timeout: 30000 });
      await window.screenshot({ path: test.info().outputPath('packaged-openai-signin.png') });
      await window.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await window.getByRole('button', { name: /First agent/ }).click();
    await window.getByRole('button', { name: 'Choose workspace' }).click();
    await expect(window.getByRole('button', { name: 'Use this workspace' })).toBeEnabled();
    await window.getByRole('button', { name: 'Use this workspace' }).click();
    await window.screenshot({ path: test.info().outputPath('packaged-setup.png') });
  } finally {
    await app.close();
    if (pid) await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    await rm(profile, { recursive: true, force: true });
  }
});
