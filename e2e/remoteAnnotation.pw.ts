import { expect, test, type Page } from '@playwright/test';

const selectSource = async (page: Page) => {
  await page.evaluate(() => {
    const root = document.querySelector('main[data-session-key="pi:hearth::10"] [data-message-id="e2"] [data-quote-part-id="e2-1"]');
    if (!root) throw new Error('The fixture source part is missing');
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const phrase = 'step counter shows';
    while (nodes.nextNode()) {
      const node = nodes.currentNode as Text;
      const start = node.data.indexOf(phrase);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + phrase.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error('The fixture source phrase is missing');
  });
};

type Probe = { requestIds: string[]; forwarded: number; suppressEcho: boolean };
const probe = (page: Page) => page.evaluate(() => (window as unknown as { remoteAnnotationProbe: Probe }).remoteAnnotationProbe);

for (const forwardedBeforeTimeout of [false, true]) {
  test('remote annotation survives a gateway timeout ' + (forwardedBeforeTimeout ? 'after upstream placement' : 'before upstream placement'), async ({ page }) => {
    // Only the in-browser fixture is used. No live host, proxy or network configuration changes.
    await page.goto('/?noDock');
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
    const column = page.locator('main[data-session-key="pi:hearth::10"]');
    await expect(column.getByRole('log')).toContainText('step counter shows');
    await page.waitForTimeout(600);
    const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
    await main.fill('Keep my independent main draft');
    await page.evaluate(async (forwardFirst) => {
      const modulePath = '/src/lib/remoteLifecycle.ts';
      const lifecycle = await import(modulePath);
      lifecycle.installRemoteLifecycle();
      const original = window.ember.piRequest!;
      const state: Probe = { requestIds: [], forwarded: 0, suppressEcho: true };
      Object.assign(window, { remoteAnnotationProbe: state });
      window.ember.piRequest = async (endpointId, path, init) => {
        const url = new URL(path, window.location.origin);
        const body = init?.body as { type?: string; requestId?: string } | undefined;
        const submit = /\/conversations\/10\/(?:submit|submissions)$/.test(url.pathname) && init?.method === 'POST' && body?.type === 'input';
        if (submit) {
          state.requestIds.push(body?.requestId ?? '');
          if (state.requestIds.length === 1) {
            if (forwardFirst) { state.forwarded++; await original(endpointId, path, init); }
            throw Object.assign(new Error('Gateway timeout after forwarding may have placed the annotation'), { kind: 'unreachable', status: 504 });
          }
          state.suppressEcho = false;
          state.forwarded++;
        }
        // Delay REST evidence while testing the retained optimistic bubble. A real lost
        // connection may delay the echo even when the upstream already accepted the POST.
        if (state.requestIds.length && state.suppressEcho && /\/conversations\/10\/entries$/.test(url.pathname)) {
          throw Object.assign(new Error('The transcript is not reachable yet'), { kind: 'unreachable' });
        }
        return original(endpointId, path, init);
      };
    }, forwardedBeforeTimeout);
    await selectSource(page);
    const bar = column.getByRole('group', { name: 'Annotate selected text' });
    const editor = bar.getByRole('textbox');
    const send = bar.getByRole('button', { name: 'Send annotation with quote' });
    await editor.fill('Do not discard this source-linked annotation');
    await page.clock.install();
    await send.click();
    await expect(send).toBeEnabled();
    await expect(editor).toHaveValue('Do not discard this source-linked annotation');
    await expect(bar).toContainText('step counter shows');
    await expect(main).toHaveValue('Keep my independent main draft');
    await expect.poll(async () => (await probe(page)).requestIds.length).toBe(1);
    expect(await page.evaluate(async () => (await window.ember.getSettings()).quoteLinks)).toEqual([]);
    const sent = column.getByRole('article', { name: /^user message/ }).filter({ hasText: 'Do not discard this source-linked annotation' });
    await expect(sent).toHaveCount(1);

    // Advance through the uncertainty notice and polling/resume boundaries. None may replay
    // this POST or reinterpret it as a definite failure with a new-id Retry action.
    await page.clock.fastForward(26_000);
    await expect(sent).toContainText(/not confirmed/i);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.clock.fastForward(3_000);
    expect((await probe(page)).requestIds).toHaveLength(1);
    await expect(editor).toHaveValue('Do not discard this source-linked annotation');
    await expect(bar).toContainText('step counter shows');
    await expect(sent).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('remote-annotation-unconfirmed.png') });

    // Only an explicit click retries. The annotation reuses the same request id; the mock
    // deduplicates an already placed submission instead of creating a second conversation entry.
    await send.click();
    await expect(bar).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.ember.getSettings())).quoteLinks.length).toBe(1);
    const attempts = (await probe(page)).requestIds;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe('');
    expect(attempts[1]).toBe(attempts[0]);
    await expect(sent).toHaveCount(1);
    await expect(main).toHaveValue('Keep my independent main draft');
    const link = (await page.evaluate(() => window.ember.getSettings())).quoteLinks[0];
    expect(link.source.quote).toBe('step counter shows');
    expect(link.destination.kind).toBe('message');
    await expect(column.locator('[data-message-id="' + link.destination.id + '"]')).toContainText('Do not discard this source-linked annotation');
  });
}
