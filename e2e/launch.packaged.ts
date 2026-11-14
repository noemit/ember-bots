import type {} from '../src/types';
import { isolatedNativeEnvironment } from './fixtures/nativeEnvironment';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:http';

// Runs the app produced by electron-builder, including its own bundled Kiln.
// Never substitutes a checkout binary: a wrong resource filename must fail this check.
//
// The setup wizard's steps are welcome → connection → token → providers → first-agent → privacy.
// On `first-agent` the only control is Continue, held disabled until a workspace and a default model
// are both chosen; the workspace itself comes from the inline picker (no separate dialog), and the
// folder actions inside it are the ones this test drives. Paths are compared through `join`, never
// string literals with "/" in them, because this also runs on `D:\a\...`.
test('the packaged app starts its bundled Kiln in a fresh profile', async () => {
  const executable = process.env.EMBER_PACKAGED_EXECUTABLE;
  test.skip(!executable, 'Set EMBER_PACKAGED_EXECUTABLE to the built app.');
  const profile = await mkdtemp(join(tmpdir(), 'ember-packaged-'));
  const workspaceRoot = join(profile, 'workspace');
  await mkdir(join(workspaceRoot, 'Existing project'), { recursive: true });
  const workspace = await realpath(workspaceRoot);
  const runtimeRequests: string[] = [];
  const runtimes = createServer((request, response) => {
    runtimeRequests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ models: [], data: [] }));
  });
  await new Promise<void>((done) => runtimes.listen(0, '127.0.0.1', done));
  const address = runtimes.address();
  if (!address || typeof address === 'string') throw new Error('No local-runtime fixture port');
  const runtimeUrl = `http://127.0.0.1:${address.port}`;
  const env: Record<string, string> = {
    ...isolatedNativeEnvironment(profile), EMBER_DATA_DIR: profile,
    EMBER_HOME: profile, HEARTH_HOME: profile, HEARTH_WORKSPACE: workspace,
    APPDATA: join(profile, 'appdata'), LOCALAPPDATA: join(profile, 'localappdata'),
    OLLAMA_HOST: runtimeUrl, LMSTUDIO_BASE_URL: runtimeUrl,
  };
  await mkdir(env.OPENCHAMBER_DATA_DIR, { recursive: true });
  await mkdir(env.APPDATA, { recursive: true });
  await mkdir(env.LOCALAPPDATA, { recursive: true });
  // No user hosts or desktopLocalPort: the only endpoint is the bundled Kiln on a fresh port.
  await writeFile(join(env.OPENCHAMBER_DATA_DIR, 'settings.json'), JSON.stringify({ desktopHosts: [] }));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let pid: number | undefined;
  try {
    app = await electron.launch({ executablePath: resolve(executable!), env });
    const window = await app.firstWindow();
    await window.screenshot({ path: test.info().outputPath('packaged-first-window.png') });
    await expect(window.getByTestId('onboarding')).toBeVisible();
    await expect(window.getByRole('heading', { name: 'Setting up Ember Bots' })).toBeVisible();
    await expect.poll(() => window.evaluate(async () => (await window.ember.getUpdateState!())?.phase)).toBe('disabled');
    const updateState = await window.evaluate(() => window.ember.getUpdateState!());
    expect(updateState.supported).toBe(false);
    expect(updateState.currentVersion).toBe('1.23.0');
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
    // Live sign-in is intentionally absent; the compiled OAuth fixture is tested separately.

    // ---- First bot: the workspace picker, and the Continue it unblocks ------------------------
    await window.getByRole('button', { name: /First bot/ }).click();
    const continueButton = window.getByTestId('onboarding').getByRole('button', { name: /^Continue$/ });
    // No workspace yet, so the step cannot be finished. This is the assertion the old `New bot`
    // button carried, moved to the control that now gates the step.
    await expect(continueButton).toBeDisabled();
    await expect(window.getByRole('heading', { name: 'Where does your work live?' })).toBeVisible();

    await window.getByRole('button', { name: 'Choose workspace', exact: true }).click();
    const picker = window.getByRole('dialog', { name: 'Choose your workspace', exact: true });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Enter a path…', exact: true }).click();
    await picker.getByRole('textbox', { name: 'Existing folder path' }).fill(workspace);
    await picker.getByRole('button', { name: 'Open path', exact: true }).click();

    // The subfolder that already exists is offered as a destination.
    const existing = picker.getByRole('button', { name: /Open folder .*Existing project/ });
    await expect(existing).toBeVisible();

    // Cancelling a new folder leaves the disk untouched.
    await picker.getByRole('button', { name: /^New folder…$/ }).click();
    await picker.getByRole('textbox', { name: 'New folder name' }).fill('Cancelled');
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await stat(join(workspace, 'Cancelled')).catch(() => null)).toBeNull();

    // An existing name is refused before submission; the folder is never overwritten.
    await picker.getByRole('button', { name: /^New folder…$/ }).click();
    await picker.getByRole('textbox', { name: 'New folder name' }).fill('Existing project');
    await expect(picker.getByRole('button', { name: 'Create folder', exact: true })).toBeDisabled();
    const refusal = picker.getByRole('alert');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('already exists');
    await expect(refusal).toContainText('use another name');

    // A new name works, navigates into it, and is persisted as the workspace.
    await picker.getByRole('textbox', { name: 'New folder name' }).fill('New workspace');
    await picker.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(picker.getByText('No subfolders here. Choose this folder, or go up to explore another.', { exact: true })).toBeVisible();
    await picker.getByRole('button', { name: 'Choose this workspace', exact: true }).click();
    await expect(picker).toHaveCount(0);
    const created = join(workspace, 'New workspace');
    expect((await stat(created)).isDirectory()).toBe(true);
    await expect.poll(() => window.evaluate(async () => (await window.ember.getSettings()).instanceDefaults['pi:local']?.workspaceDirectory))
      .toBe(created);
    // The chosen folder is what the step shows back.
    await expect(window.getByTestId('onboarding').getByText(created, { exact: true })).toBeVisible();
    await window.screenshot({ path: test.info().outputPath('packaged-setup.png') });

    // Continue also needs a default model — the old `New bot` button did too, through "Choose an AI"
    // — and this profile has none: the step says which step to visit rather than looking broken.
    await expect(window.getByTestId('onboarding').getByText('Open Choose an AI and select a default model before starting your first bot.', { exact: true })).toBeVisible();

    // ---- The choice survives a relaunch ------------------------------------------------------
    await window.evaluate(() => window.ember.setSettings({ theme: 'graphite' }));
    await window.reload();
    await window.getByRole('button', { name: /First bot/ }).click();
    await expect(window.getByRole('button', { name: 'Choose workspace', exact: true })).toHaveText(basename(created));
    await expect(window.getByTestId('onboarding').getByText(created, { exact: true })).toBeVisible();
    expect(isAbsolute(created)).toBe(true);
    // Nothing was lost and nothing was restarted: the workspace is still the answer, and the button
    // still waits on the model that this profile never chose.
    await expect(window.getByTestId('onboarding').getByRole('button', { name: /^Continue$/ })).toBeDisabled();
    await window.screenshot({ path: test.info().outputPath('packaged-setup-dark.png') });
  } finally {
    try {
      await app?.close();
      if (pid) await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    } finally {
      runtimes.closeAllConnections();
      await new Promise<void>((done) => runtimes.close(() => done()));
      if (process.env.EMBER_PACKAGED_PROFILE_RECEIPT) {
        await writeFile(process.env.EMBER_PACKAGED_PROFILE_RECEIPT, JSON.stringify({ profile, pid }));
      }
    }
    expect(runtimeRequests.length).toBeGreaterThan(0);
    expect(runtimeRequests.every((entry) => entry === 'GET /api/tags' || entry === 'GET /v1/models')).toBe(true);
    if (!process.env.EMBER_PACKAGED_PROFILE_RECEIPT) await rm(profile, { recursive: true, force: true });
  }
});
