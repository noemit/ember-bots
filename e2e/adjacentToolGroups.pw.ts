import { expect, test, type Page } from '@playwright/test';

// Intercept the bridge at installation, before startup/background reads can cache the real mock.
// These are Kiln wire entries (including empty assistant text), not renderer ChatMessages.
async function fixture(page: Page, mode: 'separators' | 'live' | 'virtual' = 'separators') {
  await page.addInitScript(({ mode }) => {
    type Entry = { id: number; kind: string; model: Record<string, unknown>[] };
    const entries: Entry[] = [];
    const assistant = (content: unknown[]) => ({ role: 'assistant', content, provider: 'faux-hearth', model: 'glm-5.3-flash', timestamp: Date.now(), stopReason: 'stop' });
    const append = (kind: string, model: Record<string, unknown>) => entries.push({ id: entries.length + 1, kind, model: [model] });
    const prose = (text: string) => append('pi.assistant', assistant([{ type: 'text', text }]));
    const user = (content: string) => append('pi.user', { role: 'user', content, timestamp: Date.now() });
    const call = (id: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: `echo ${id}` } });
    const result = (id: string, error = false, image = false) => append('pi.tool-result', {
      role: 'toolResult', toolCallId: id, toolName: 'bash', isError: error, details: error ? { diagnostics: [{ message: 'Command exited with code 1' }], exitCode: 1 } : undefined, timestamp: Date.now(),
      content: image ? [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }] : [{ type: 'text', text: error ? 'Command exited with code 1\nRetained diagnostic omega' : `Retained output ${id}` }],
    });
    const tool = (id: string, error = false, image = false) => {
      append('pi.assistant', assistant([{ type: 'text', text: '' }, ...(mode === 'virtual' && id === 'omega' ? [{ type: 'thinking', thinking: 'Hidden source navigation marker' }] : []), call(id)]));
      result(id, error, image);
    };
    user('Inspect the adjacent tool steps');
    if (mode === 'virtual') {
      for (let i = 0; i < 100; i++) prose(`Earlier answer ${i}`);
    }
    if (mode !== 'live') {
      tool('alpha'); tool('omega', true);
      prose('Prose is a meaningful separator');
      tool('after-prose');
      user('User is a meaningful separator');
      tool('before-thinking');
      append('pi.assistant', assistant([{ type: 'thinking', thinking: 'Visible reasoning separates these steps' }, call('thinking')]));
      result('thinking');
      tool('after-thinking');
      tool('picture', false, true);
      tool('after-picture');
      prose('Finished inspecting');
    }
    if (mode === 'live') append('pi.assistant', assistant([{ type: 'text', text: '' }, call('live-alpha')]));
    let settled = mode !== 'live';
    let bridge: typeof window.ember;
    const listeners: Array<(event: { instanceId: string; type: string; sessionId: string }) => void> = [];
    Object.assign(window, { settleAdjacentTools: () => {
      result('live-alpha');
      tool('live-beta');
      settled = true;
      for (const listener of listeners) listener({ instanceId: 'pi:hearth', type: 'pi:run_end', sessionId: '10' });
    } });
    Object.defineProperty(window, 'ember', {
      configurable: true,
      get: () => bridge,
      set: (value: typeof window.ember) => {
        bridge = value;
        const original = value.piRequest!.bind(value);
        void value.setSettings({ toolDisplay: 'collapsed', reasoningDisplay: mode === 'virtual' ? 'hidden' : 'expanded', expandToolCalls: false, hideToolCalls: false, showMessageDetails: false });
        const onEvent = value.onEvent?.bind(value);
        value.onEvent = (listener) => {
          listeners.push(listener);
          return onEvent?.(listener) ?? (() => {});
        };
        value.piRequest = async <T,>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
          const url = new URL(path, 'http://fixture');
          if (instance === 'pi:hearth' && url.pathname === '/conversations') {
            const response = await original<{ conversations: Array<Record<string, unknown>> }>(instance, path, init);
            return { ...response, data: { ...response.data, conversations: response.data.conversations.map(c => String(c.id) === '10' ? { ...c, busy: !settled } : c) } as T };
          }
          if (instance !== 'pi:hearth' || !/^\/conversations\/10(?:\/entries)?$/.test(url.pathname) || (init?.method && init.method !== 'GET')) return original<T>(instance, path, init);
          const live = settled ? {} : { run: { taskId: 1, inputs: [1] }, generation: { message: assistant([{ type: 'text', text: '' }, call('live-alpha')]) }, tools: [{ callId: 'live-alpha', name: 'bash', status: 'running' }] };
          const docs = { 'pi.live': live };
          if (url.pathname.endsWith('/entries')) {
            const since = Number(url.searchParams.get('since') ?? 0);
            const cursor = url.searchParams.get('cursor');
            const before = cursor ? Number(JSON.parse(cursor).before) : Infinity;
            const pool = entries.filter(e => e.id > since && e.id < before);
            const limit = Number(url.searchParams.get('limit') ?? 50);
            const page = pool.slice(-limit).reverse();
            return { ok: true, status: 200, data: { entries: page, docs, ...(pool.length > page.length ? { next: { before: page.at(-1)!.id } } : {}) } as T };
          }
          const response = await original<Record<string, unknown>>(instance, path, init);
          return { ...response, data: { ...response.data, entries, docs } as T };
        };
      },
    });
  }, { mode });
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  return page.locator('main[data-session-key="pi:hearth::10"]');
}

test('adjacent empty-text tool steps share one count without absorbing visible separators or images', async ({ page }, testInfo) => {
  const column = await fixture(page);
  const history = column.getByRole('log', { name: 'Conversation' });
  const combined = history.getByRole('button', { name: 'Used 2 tools', exact: true }).first();
  await expect(history.getByRole('button', { name: 'Used 2 tools', exact: true })).toHaveCount(2);
  await combined.click();
  await expect(combined).toHaveAttribute('aria-expanded', 'true');
  await history.getByRole('button', { name: 'bash × 2', exact: true }).click();
  for (const id of ['alpha', 'omega']) {
    await history.getByRole('button', { name: new RegExp(`echo ${id}`) }).click();
  }
  await expect(history.getByText('Retained output alpha', { exact: true })).toBeVisible();
  await expect(history.getByText(/Retained diagnostic omega/)).toBeVisible();
  await expect(history.getByText('Command exited with code 1', { exact: true })).toBeVisible();
  // Visible reasoning precedes these two calls, so it anchors their rollup rather than separating them.
  const thinkingRow = history.getByRole('article').filter({ hasText: 'Visible reasoning separates these steps' });
  await expect(thinkingRow.getByRole('button', { name: 'Used 2 tools', exact: true })).toBeVisible();
  await expect(thinkingRow.getByRole('button', { name: 'Used 1 tool', exact: true })).toHaveCount(0);
  await thinkingRow.getByRole('button', { name: 'Used 2 tools', exact: true }).click();
  await thinkingRow.getByRole('button', { name: 'bash × 2', exact: true }).click();
  for (const id of ['thinking', 'after-thinking']) {
    await expect(thinkingRow.getByRole('button', { name: new RegExp(`echo ${id}`) })).toBeVisible();
  }
  await expect(history.getByRole('button', { name: 'Used 1 tool', exact: true })).toHaveCount(3);
  for (const text of ['Prose is a meaningful separator', 'User is a meaningful separator', 'Visible reasoning separates these steps']) {
    await expect(history.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(history.locator('img')).toHaveCount(1);
  await history.locator('img').scrollIntoViewIfNeeded();
  await expect(history.locator('img')).toBeVisible();
  await combined.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('adjacent-tools-expanded.png') });
  await testInfo.attach('Merged calls retain output and failure details', { path: testInfo.outputPath('adjacent-tools-expanded.png'), contentType: 'image/png' });
  // Nested tool groups must use available transcript width, not shrink to the rollup label.
  expect(await history.getByText('Retained output alpha', { exact: true }).evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(500);
});

test('list and hidden view modes keep their existing tool presentation', async ({ page }) => {
  const column = await fixture(page);
  const history = column.getByRole('log', { name: 'Conversation' });
  await expect(history.getByRole('button', { name: 'Used 2 tools', exact: true }).first()).toBeVisible();
  await column.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(history.getByRole('button', { name: /Used \d+ tools?/ })).toHaveCount(0);
  for (const id of ['alpha', 'omega']) await expect(history.getByRole('button', { name: new RegExp(`echo ${id}`) })).toBeVisible();
  await column.getByRole('button', { name: 'View options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show tool use', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(history.getByRole('button', { name: /echo alpha|echo omega/ })).toHaveCount(0);
  await expect(history.locator('img')).toHaveCount(1);
  await expect(history.getByText('Prose is a meaningful separator', { exact: true })).toBeVisible();
});

test('an expanded live rollup stays expanded when its call settles into adjacent entries', async ({ page }) => {
  const column = await fixture(page, 'live');
  const history = column.getByRole('log', { name: 'Conversation' });
  const live = history.getByRole('button', { name: /Using tool \(1\)/ });
  await expect(live).toBeVisible();
  await live.click();
  await expect(live).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => (window as unknown as { settleAdjacentTools: () => void }).settleAdjacentTools());
  const settled = history.getByRole('button', { name: 'Used 2 tools', exact: true });
  await expect(settled).toBeVisible();
  await expect(settled).toHaveAttribute('aria-expanded', 'true');
  await history.getByRole('button', { name: 'bash × 2', exact: true }).click();
  await expect(history.getByRole('button', { name: /echo live-alpha/ })).toBeVisible();
  await expect(history.getByRole('button', { name: /echo live-beta/ })).toBeVisible();
  await expect(live).toHaveCount(0);
});

test('search jumps to a later source step inside a virtualized merged rollup', async ({ page }) => {
  const column = await fixture(page, 'virtual');
  const history = column.getByRole('log', { name: 'Conversation' });
  await expect(history.getByText('Finished inspecting', { exact: true })).toBeVisible();
  // Hold the row's click-to-read grace period so it settles after find navigation.
  await page.evaluate(() => {
    const originalSet = window.setTimeout.bind(window);
    const originalClear = window.clearTimeout.bind(window);
    const pending = new Map<number, () => void>();
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 300 || typeof callback !== 'function') return originalSet(callback, delay, ...args);
      const id = originalSet(() => {}, 60000);
      pending.set(id, () => callback(...args));
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = (id?: number) => { if (id !== undefined) pending.delete(id); originalClear(id); };
    Object.assign(window, { __releaseAdjacentReadGrace: () => {
      window.setTimeout = originalSet;
      window.clearTimeout = originalClear;
      const callbacks = [...pending.entries()];
      pending.clear();
      for (const [id, callback] of callbacks) { originalClear(id); callback(); }
      return callbacks.length;
    }});
  });
  const clickedId = await history.locator('..').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(bounds.left + 40, bounds.top + 40)?.closest('[data-message-id]')?.getAttribute('data-message-id');
  });
  expect(clickedId).toBeTruthy();
  expect(clickedId).not.toBe('e102');
  await history.locator('..').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('ControlOrMeta+f');
  await column.getByRole('textbox', { name: 'Find in conversation' }).fill('Hidden source navigation marker');
  const combined = history.getByRole('button', { name: 'Used 2 tools', exact: true }).first();
  await expect(combined).toBeVisible();
  // Revisit the match after virtual measurement; the transient highlight expires after five seconds.
  await column.getByRole('textbox', { name: 'Find in conversation' }).press('Enter');
  const target = history.locator('[data-message-id="e102"]');
  await expect(target).toHaveAttribute('data-highlighted', 'true');
  expect(await page.evaluate(() => (window as unknown as { __releaseAdjacentReadGrace: () => number }).__releaseAdjacentReadGrace())).toBe(1);
  // The earlier click acknowledges its own reply, not the merged search target e102.
  await expect(history.locator(`[data-message-id="${clickedId}"]`)).toHaveAttribute('data-read-highlighted', 'true');
  await expect(target).toHaveAttribute('data-highlighted', 'true');
  await expect(history.locator('[data-highlighted="true"]')).toContainText('Used 2 tools');
  expect(await history.locator('[data-index]').count()).toBeLessThan(100);
});
