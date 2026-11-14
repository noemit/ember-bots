import { expect as baseExpect, test, type Page } from '@playwright/test';

const expect = baseExpect.configure({ timeout: 30_000 });

const REQUEST = 'lets close the design gap';
const ANSWER = 'I fixed the login redirect because returning users were sent to the wrong page after signing in. The original destination is now restored.';
const HUMAN_TITLE = 'My carefully chosen investigation';

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(120_000);

/**
 * All traffic stays in mockPi. This adapter supplies a useful answer instead of its echo, but
 * leaves its real create/submit, streaming timers, events, entries and PATCH implementation intact.
 * mockPi intentionally forgets host conversations on reload; replaying this one conversation
 * before App boots models a durable host independently of the persisted renderer settings.
 */
async function installNamingHost(page: Page, answer: 'substantive' | 'ack' = 'substantive', seedWorker = false, slowTurn = false) {
  await page.addInitScript(({ answer, substantive, seedWorker, slowTurn, vagueRequest }) => {
    const HOST = 'title-refinement-host';
    const SETTINGS = 'title-refinement-settings';
    type Host = { id: string; title: string; prompts: string[] };
    type Wire = { title?: string; id?: number; content?: string };
    // Hold only mockPi's three slow-turn stages. Advancing explicitly makes the live/manual
    // assertions independent of a loaded CI machine racing through the twelve-second window.
    if (slowTurn) {
      const timeout = window.setTimeout.bind(window);
      const stages = new Map<number, () => void>();
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof handler === 'function' && [4800, 8400, 12000].includes(delay ?? 0)) {
          stages.set(delay!, () => handler(...args));
          return timeout(() => {}, 120_000);
        }
        return timeout(handler, delay, ...args);
      }) as typeof window.setTimeout;
      window.addEventListener('title-refinement-advance', event => {
        const through = (event as CustomEvent<number>).detail;
        for (const [at, stage] of stages) {
          if (at > through) continue;
          stages.delete(at);
          stage();
        }
      });
    }
    let installed: typeof window.ember;
    Object.defineProperty(window, 'ember', {
      configurable: true,
      get: () => installed,
      set: (bridge: typeof window.ember) => {
        installed = bridge;
        const request = bridge.piRequest!.bind(bridge);
        const getSettings = bridge.getSettings.bind(bridge);
        const listInstances = bridge.listInstances.bind(bridge);
        const setSettings = bridge.setSettings.bind(bridge);
        const readHost = (): Host | null => JSON.parse(sessionStorage.getItem(HOST) ?? 'null');
        const saveHost = (host: Host) => sessionStorage.setItem(HOST, JSON.stringify(host));
        if (!sessionStorage.getItem('title-refinement-answer')) sessionStorage.setItem('title-refinement-answer', answer);
        const replaceReply = (value: unknown): unknown => {
          if (value === vagueRequest + ' slow') return vagueRequest;
          if (typeof value === 'string' && value.startsWith('Echo from Hearth: ')) {
            return sessionStorage.getItem('title-refinement-answer') === 'ack' ? 'On it.' : substantive;
          }
          if (Array.isArray(value)) return value.map(replaceReply);
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceReply(item)]));
          return value;
        };
        let boot: Promise<void> | undefined;
        bridge.getSettings = async () => {
          boot ??= (async () => {
            const host = readHost();
            if (!host) {
              if (seedWorker) {
                await request('pi:hearth', '/conversations/17/abort', { method: 'POST' });
                await request('pi:hearth', '/conversations/17/submit', { method: 'POST', body: { content: vagueRequest } });
                await new Promise(resolve => setTimeout(resolve, 650));
                await setSettings({ automaticTitleSeeds: { 'pi:hearth::17': 'Parse config' } });
              }
              return;
            }
            // Simulate the host's durable conversation, not App's naming/eligibility policy.
            const created = await request('pi:hearth', '/conversations', { method: 'POST', body: { title: host.title, cwd: '/workspace/hearth' } });
            host.id = String((created.data as Wire).id);
            saveHost(host);
            for (const prompt of host.prompts) {
              await request('pi:hearth', `/conversations/${host.id}/submit`, { method: 'POST', body: { content: prompt } });
              await new Promise(resolve => setTimeout(resolve, 650));
            }
            await setSettings({ ...JSON.parse(sessionStorage.getItem(SETTINGS) ?? '{}'), openSessions: [`pi:hearth::${host.id}`], activeSession: `pi:hearth::${host.id}` });
          })();
          await boot;
          return getSettings();
        };
        // App loads instances and settings concurrently; expose the host only after restoration.
        bridge.listInstances = async () => {
          await bridge.getSettings();
          return listInstances();
        };
        bridge.setSettings = async patch => {
          const result = await setSettings(patch);
          sessionStorage.setItem(SETTINGS, JSON.stringify({ automaticTitleSeeds: result.automaticTitleSeeds }));
          return result;
        };
        bridge.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
          const method = init?.method ?? 'GET';
          const data = init?.body as Wire | undefined;
          // Select mockPi's long streaming window without making "slow" part of naming evidence.
          const slowSubmit = slowTurn && path.endsWith('/submit') && typeof data?.content === 'string';
          const result = await request<T>(instance, path, slowSubmit ? { ...init, body: { ...data, content: data.content + ' slow' } } : init);
          let host = readHost();
          if (method === 'POST' && path === '/conversations' && result.ok) {
            host = { id: String((result.data as Wire).id), title: data?.title ?? '', prompts: [] };
            saveHost(host);
          }
          if (method === 'PATCH' && result.ok && data?.title) {
            if (host && path === `/conversations/${host.id}`) {
              host.title = data.title;
              saveHost(host);
            }
            const writes: string[] = JSON.parse(sessionStorage.getItem('title-refinement-writes') ?? '[]');
            sessionStorage.setItem('title-refinement-writes', JSON.stringify([...writes, data.title]));
          }
          if (host && path === `/conversations/${host.id}/submit` && method === 'POST' && result.ok && typeof data?.content === 'string') {
            host.prompts.push(data.content);
            saveHost(host);
          }
          // Only this test's new conversation gets scripted prose. Existing fixtures stay intact.
          return (host && path.startsWith(`/conversations/${host.id}`)) || (seedWorker && path.startsWith('/conversations/17'))
            ? { ...result, data: replaceReply(result.data) as T } : result;
        };
      },
    });
  }, { answer, substantive: ANSWER, seedWorker, slowTurn, vagueRequest: REQUEST });
}

async function createVagueChat(page: Page) {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'New bot project' })).toBeVisible();
  const composer = page.locator('textarea').first();
  await composer.fill(REQUEST);
  await composer.press('Enter');
  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  const key = (await column.getAttribute('data-session-key'))!;
  const seed = await page.evaluate(async key => (await window.ember.getSettings()).automaticTitleSeeds?.[key], key);
  expect(seed, 'create must explicitly enrol the automatic title').toBeTruthy();
  return { column, key, seed: seed! };
}

const advanceTurn = (page: Page, through: number) => page.evaluate(through => window.dispatchEvent(new CustomEvent('title-refinement-advance', { detail: through })), through);
const writes = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('title-refinement-writes') ?? '[]') as string[]);
const eligibility = (page: Page, key: string) => page.evaluate(async key => (await window.ember.getSettings()).automaticTitleSeeds?.[key], key);

// No exact generated character/placeholder requirement: the improvement must name the real topic.
test('a vague new chat gains the completed answer’s topic, never its live preview', async ({ page }, testInfo) => {
  await installNamingHost(page, 'substantive', false, true);
  const { column, key, seed } = await createVagueChat(page);
  await expect(column.getByRole('button', { name: /Stop/ })).toBeVisible();
  await advanceTurn(page, 8400);
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText(ANSWER, { timeout: 30_000 });
  // The same useful prose is already visible at 70% of the mock turn, before it is durable.
  await expect(column.getByRole('button', { name: /Stop/ })).toBeVisible();
  expect(await writes(page)).toEqual([]);
  expect(await eligibility(page, key)).toBe(seed);
  await page.screenshot({ path: testInfo.outputPath('live-answer-keeps-seed.png') });
  await advanceTurn(page, 12000);
  await expect(column.getByRole('button', { name: /Stop/ })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => writes(page)).toHaveLength(1);
  const [refined] = await writes(page);
  expect(refined).toMatch(/login/i);
  expect(refined).not.toBe(seed);
  await expect(column.locator('header')).toContainText(refined);
  await expect.poll(() => eligibility(page, key)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('settled-answer-refines-title.png') });
});

test('an acknowledgement keeps eligibility across restart; the settled useful answer refines once', async ({ page }) => {
  await installNamingHost(page, 'ack');
  const { column, key, seed } = await createVagueChat(page);
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('On it.');
  await expect(column.getByRole('button', { name: /Stop/ })).toHaveCount(0);
  expect(await writes(page)).toEqual([]);
  expect(await eligibility(page, key)).toBe(seed);
  await page.evaluate(() => sessionStorage.setItem('title-refinement-answer', 'substantive'));
  await page.reload();
  const restored = page.locator(`main[data-session-key="${key}"]`);
  await expect(restored.getByRole('log', { name: 'Conversation' })).toContainText(ANSWER, { timeout: 20_000 });
  await expect.poll(() => writes(page)).toHaveLength(1);
  expect((await writes(page))[0]).toMatch(/login/i);
  await expect.poll(() => eligibility(page, key)).toBeUndefined();
  await page.reload();
  await expect(restored.locator('header')).toContainText((await writes(page))[0]);
  expect(await writes(page)).toHaveLength(1);
});

test('a human rename during the pending answer survives settlement and restart', async ({ page }) => {
  await installNamingHost(page, 'substantive', false, true);
  const { column, key, seed } = await createVagueChat(page);
  await expect(column.getByRole('button', { name: /Stop/ })).toBeVisible();
  await page.locator('[data-active-chat]').getByText(seed, { exact: true }).dblclick();
  const rename = page.getByRole('textbox', { name: 'Rename session' });
  await rename.fill(HUMAN_TITLE);
  await rename.press('Enter');
  await expect(column.locator('header')).toContainText(HUMAN_TITLE);
  await expect.poll(() => eligibility(page, key)).toBeUndefined();
  await advanceTurn(page, 12000);
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText(ANSWER, { timeout: 30_000 });
  await expect(column.getByRole('button', { name: /Stop/ })).toHaveCount(0, { timeout: 30_000 });
  expect(await writes(page)).toEqual([HUMAN_TITLE]);
  await page.reload();
  await expect(column.locator('header')).toContainText(HUMAN_TITLE);
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText(ANSWER);
  expect(await writes(page)).toEqual([HUMAN_TITLE]);
});

test('even a mistakenly persisted seed cannot rename a worker with a useful answer', async ({ page }) => {
  await installNamingHost(page, 'substantive', true);
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('button', { name: '+1 previous', exact: true }).click();
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.getByRole('dialog').locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText(ANSWER);
  await expect(worker.locator('header')).toContainText('Parse config');
  await expect.poll(() => eligibility(page, 'pi:hearth::17')).toBeUndefined();
  expect(await writes(page)).toEqual([]);
});
