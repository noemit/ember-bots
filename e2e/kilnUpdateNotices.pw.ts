import { expect, test, type Page } from '@playwright/test';
import { version as bundled } from '../packages/kiln/package.json';
import type { EmberSettings, Instance } from '../src/types';

test.use({ serviceWorkers: 'block' });

const old = '0.1.0';
const newer = `${Number(bundled.split('.')[0]) + 1}.0.0`;
const host = (id: string, label: string, version: string, status: Instance['status'] = 'ready'): Instance => ({
  id: `pi:${id}`, label, version, kind: 'pi', url: `https://${id}.invalid`, status, attachable: status === 'ready',
});

/** Only the fixture's *next probe* sees the changed version, not an already-rendered row. */
declare global {
  interface Window {
    kilnNoticeFixture: { reportVersion: (id: string, version: string) => void; forbidden: string[] };
  }
}

async function start(page: Page, baseURL: string, hosts: Instance[]) {
  const origin = new URL(baseURL);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(origin.hostname);
  const blocked: string[] = [];
  const context = page.context();
  await context.route('**/*', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin.origin && /^(GET|HEAD)$/.test(req.method()) && !/^\/(hearth-live|remote)\b/.test(url.pathname)) return route.continue();
    blocked.push(`${req.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  // Vite's own hot-reload socket stays on this dev server. No sockets to hosts or other services.
  await context.routeWebSocket(url => url.host !== origin.host || url.pathname !== '/', socket => {
    blocked.push(`WebSocket ${socket.url()}`);
    socket.close();
  });

  await page.addInitScript(initial => {
    let reported = initial, snapshot = initial;
    const forbidden: string[] = [];
    const deny = (call: string): never => { forbidden.push(call); throw new Error(`Read-only fixture: ${call}`); };
    window.kilnNoticeFixture = {
      forbidden,
      reportVersion: (id, version) => { reported = reported.map(i => i.id === id ? { ...i, version } : i); },
    };
    let bridge: typeof window.ember;
    Object.defineProperty(window, 'ember', {
      configurable: true, get: () => bridge,
      set: (mock: typeof window.ember) => {
        const piEndpoints = initial.map(({ id, label, url }) => ({ id, label, url: url!, token: 'fixture-only' }));
        const configured = (settings: EmberSettings) => ({ ...settings, piEndpoints });
        bridge = {
          ...mock,
          getSettings: async () => configured(await mock.getSettings()),
          setSettings: async patch => {
            if ('piEndpoints' in patch) deny('write connection settings');
            if (patch.dismissedOutages?.length === 0) forbidden.push('cleared dismissed outages');
            return configured(await mock.setSettings(patch));
          },
          listInstances: async (refresh = true) => {
            if (refresh) snapshot = reported;
            return structuredClone(snapshot);
          },
          piRequest: async <T,>(id: string, path: string, init?: { method?: string; body?: unknown }) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') deny(`${id}: ${method} ${path}`);
            // Empty hosts have no sessions or scheduled runs for unrelated background work to mutate.
            if (path === '/conversations') return { ok: true, status: 200, data: { conversations: [] } as T };
            if (path === '/scheduled-tasks') return { ok: true, status: 200, data: { tasks: [] } as T };
            return mock.piRequest!<T>(id, path, init);
          },
          request: async (id, method, path) => deny(`${id}: ${method} ${path}`), // No OpenChamber hosts here.
          updateAction: async action => deny(`desktop update: ${action}`),
          retryLocalHarness: async () => deny('restart local Kiln'),
          localHarnessToken: options => options?.rotate ? deny('rotate and restart local Kiln') : mock.localHarnessToken!(options),
          kilnSharing: action => action !== 'inspect' ? deny(`change sharing: ${action}`) : mock.kilnSharing!(action),
          openExternal: async target => deny(`open external: ${target}`),
        };
      },
    });
  }, hosts);
  await page.goto('/?noDock&updater=idle'); // The distinct Ember desktop updater is present, not a mock Kiln installer.
  return async () => {
    expect([...blocked, ...await page.evaluate(() => window.kilnNoticeFixture.forbidden)]).toEqual([]);
  };
}

const instancesButton = (page: Page) => page.getByRole('button', { name: 'Instances', exact: true });
const menuHost = (page: Page, label: string) => page.getByRole('menuitemcheckbox').filter({ hasText: label });
async function openComparisonFromMenu(page: Page) {
  await page.getByRole('menuitem', { name: 'Instance settings', exact: true }).click();
  return page.getByRole('region', { name: 'Kiln updates', exact: true });
}

test('only the older remote Kiln gets a notice; checking after a manual upgrade clears it', async ({ page, baseURL }) => {
  const verifyReadOnly = await start(page, baseURL!, [host('studio', 'Studio', old), host('tower', 'Tower', newer), host('local', 'Bundled host', old)]);
  const instances = instancesButton(page);
  await expect(instances.getByText(/update recommended/i)).toBeVisible();
  await instances.click();
  const flagged = page.getByRole('menuitemcheckbox').filter({ hasText: /update recommended/i });
  await expect(flagged).toHaveCount(1);
  await expect(flagged).toContainText('Studio');
  await expect(menuHost(page, 'Bundled host')).toBeVisible(); // Present in Instances, not a remote update candidate.

  const updates = await openComparisonFromMenu(page);
  const rows = updates.getByRole('listitem');
  const studio = rows.filter({ hasText: 'Studio' });
  const tower = rows.filter({ hasText: 'Tower' });
  await expect(rows).toHaveCount(2);
  await expect(updates).toContainText(`includes Kiln ${bundled}`);
  await expect(studio).toContainText(old);
  await expect(studio).toContainText(/update recommended/i);
  await expect(tower).toContainText(newer);
  await expect(tower).toContainText(/newer than/i);
  const instructions = updates.getByText(/redeploy.*container/i);
  await instructions.scrollIntoViewIfNeeded();
  await expect(instructions).toBeInViewport();
  await expect(instructions).toContainText(/on that host.*Ember app.*standalone Tinder/i);
  await expect(updates.getByRole('button', { name: /install|restart|download|^update\b/i })).toHaveCount(0);

  const upgraded = `${bundled}+reprobed.2`;
  await page.evaluate(v => window.kilnNoticeFixture.reportVersion('pi:studio', v), upgraded);
  await updates.getByRole('button', { name: 'Refresh versions' }).click();
  await expect(studio).toContainText(upgraded); // Only a fresh probe could supply the new build metadata.
  await expect(studio).toContainText(/matches the included Kiln/i);
  await expect(tower).toContainText(/newer than/i);
  await expect(updates).not.toContainText(/update recommended/i);
  await page.keyboard.press('Escape');
  await expect(instances).toBeVisible();
  await expect(instances).not.toContainText(/update recommended/i);
  await instances.click();
  await expect(menuHost(page, 'Studio')).toContainText(upgraded);
  await expect(flagged).toHaveCount(0);
  await verifyReadOnly();
});

test('unknown and offline hosts get no recommendation; refreshing keeps a dismissed outage quiet', async ({ page, baseURL }) => {
  const verifyReadOnly = await start(page, baseURL!, [host('studio', 'Studio', 'cafef00d'), host('tower', 'Tower', old, 'unreachable')]);
  const instances = instancesButton(page);
  await expect(instances).toContainText('1/2'); // Wait for discovery before asserting absence.
  await expect(instances).not.toContainText(/update recommended/i);
  const dismiss = page.getByRole('button', { name: 'Stop warning about Tower' });
  await dismiss.click();
  const savedDismissals = () => page.evaluate(async () => (await window.ember.getSettings()).dismissedOutages);
  await expect.poll(savedDismissals).toEqual(['pi:tower']);
  await instances.click();
  await expect(menuHost(page, 'Tower')).toBeDisabled();
  const updates = await openComparisonFromMenu(page);
  const studio = updates.getByRole('listitem').filter({ hasText: 'Studio' });
  await expect(studio).toContainText(/compare versions.*on this host/i);
  await expect(updates.getByRole('listitem').filter({ hasText: 'Tower' })).toContainText(/version unavailable.*connection/i);
  await expect(updates).not.toContainText(/update recommended/i);

  // Witness a completed reprobe (not a no-op button) while Tower remains unavailable.
  await page.evaluate(() => window.kilnNoticeFixture.reportVersion('pi:studio', 'baadf00d'));
  await updates.getByRole('button', { name: 'Refresh versions' }).click();
  await expect(studio).toContainText('baadf00d');
  await page.keyboard.press('Escape');
  await expect(instances).toBeVisible();
  await expect(dismiss).toHaveCount(0);
  expect(await savedDismissals()).toEqual(['pi:tower']);
  await verifyReadOnly();
});
