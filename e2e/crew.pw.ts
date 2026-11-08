import { expect, test, type Page } from '@playwright/test';

/**
 * Coagent crews in the pi mock: a leader's workers are hidden from the rail, surfaced only in
 * the crew strip, openable in transient dialogs, and a worker's pending question rolls up to the
 * leader. The `[crew]` wake renders as a system card, not a user bubble.
 */

async function persistedWorkspace(page: Page) {
  return page.evaluate(async () => {
    const settings = await window.ember.getSettings();
    return { openSessions: settings.openSessions, activeSession: settings.activeSession };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the rail hides crew workers; the leader shows its crew strip', async ({ page }) => {
  // The workspace opens directly; the leader is always reachable from its rail row.
  await page.getByRole('button', { name: /Crew: auth refactor/ }).click();
  const rail = page.locator('aside');
  await expect(rail.getByRole('button', { name: /Crew: auth refactor/ }).first()).toBeVisible();
  // A worker row would start with the worker's own title; the leader's preview mentioning it is fine.
  await expect(rail.getByRole('button', { name: /^Parse config/ })).toHaveCount(0);
  await expect(rail.getByRole('button', { name: /^Migrate schema/ })).toHaveCount(0);

  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  await expect(column).toBeVisible();
  await expect(column.getByRole('button', { name: 'Parse config', exact: true })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Migrate schema', exact: true })).toBeVisible();
  // The parked worker's need shows as a badge in the strip.
  await expect(column.getByText('needs input')).toBeVisible();
});

test('an idle leader says it is waiting on its crew; an idle chat says nothing', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const status = leader.locator('[data-session-status]');
  // Idle here, busy below: the one state that used to look finished but was not.
  await expect(status).toHaveText('Waiting on 2 workers…');
  await expect(status).toHaveAttribute('aria-live', 'polite');
  // The status never takes the composer away: another thought can be sent at any time.
  await expect(leader.locator('textarea')).toBeEnabled();

  // A chat with no crew renders no status row at all (not an empty row).
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const habit = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(habit.getByRole('log', { name: 'Conversation' })).toBeVisible();
  await expect(habit.locator('[data-session-status]')).toHaveCount(0);
});

test('the [crew] wake renders as a Crew report card, not a user bubble', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const log = column.getByRole('log', { name: 'Conversation' });
  await expect(log.getByText('Crew report', { exact: true })).toBeVisible();
  await expect(log).toContainText('Parse config finished');
  // The raw bracket prefix is not shown as a user message.
  await expect(log.getByText(/^\[crew\]/)).toHaveCount(0);
});

test('a worker dialog leaves the main workspace and draft intact through Close and Escape', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.locator('textarea').fill('Keep this leader draft');
  await expect.poll(async () => (await persistedWorkspace(page)).activeSession).toBe('pi:hearth::16');
  const workspace = await persistedWorkspace(page);
  // A retained attribute distinguishes the original DOM node from a replacement with the same key.
  await leader.evaluate((node) => node.setAttribute('data-modal-retention-probe', 'original'));

  for (const dismissal of ['button', 'escape'] as const) {
    await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator('main[data-session-key="pi:hearth::17"]') });
    const worker = dialog.locator('main[data-session-key="pi:hearth::17"]');
    await expect(dialog).toBeVisible();
    await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Parse the config and report back.');
    await expect(worker.locator('textarea')).toBeEnabled();
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds !== null && Math.round(bounds.width) === 1200 && Math.round(bounds.height) === 900;
    }).toBe(true);
    if (dismissal === 'button') await page.screenshot({ path: testInfo.outputPath('thread-modal-desktop.png') });
    await expect(leader).toHaveAttribute('data-modal-retention-probe', 'original');
    await expect(leader.locator('textarea')).toHaveValue('Keep this leader draft');
    await expect.poll(() => persistedWorkspace(page)).toEqual(workspace);
    await expect(page.locator('[data-active-chat]')).toContainText('Crew: auth refactor');

    if (dismissal === 'escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(leader.getByRole('button', { name: 'Parse config', exact: true })).toBeFocused();
    await expect(leader).toBeVisible();
    await expect(leader).toHaveAttribute('data-modal-retention-probe', 'original');
    await expect(leader.locator('textarea')).toHaveValue('Keep this leader draft');
    await expect.poll(() => persistedWorkspace(page)).toEqual(workspace);
    await expect(page.locator('[data-rail-scroll]').getByRole('button', { name: /^Parse config/ })).toHaveCount(0);
  }
});

test('the worker dialog fits a narrow viewport with its composer and Close control visible', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Parse config', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const bounds = await dialog.boundingBox();
    return bounds !== null && bounds.x >= 0 && bounds.y >= 0
      && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844;
  }).toBe(true);
  await expect(dialog.locator('textarea')).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('thread-modal-mobile.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('an open worker dialog refreshes host output and accepts a new message', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.getByTestId('thread-session-modal').locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Parsing the config now…');
  // Mutate the mock host, not App state: the modal must participate in event-driven reads.
  const stopped = await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/conversations/17/abort', { method: 'POST' }));
  expect(stopped.ok).toBe(true);
  await worker.getByRole('button', { name: 'Used 1 tool', exact: true }).click();
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText(/aborted|interrupted/i);
  await worker.getByRole('textbox', { name: 'Message the agent' }).fill('Verify modal delivery');
  await worker.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Echo from Hearth: Verify modal delivery');
  await worker.locator('input[type="file"]').setInputFiles({
    name: 'thread.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64'),
  });
  await worker.getByRole('textbox', { name: 'Message the agent' }).fill('Review this image');
  await worker.getByRole('button', { name: 'Send', exact: true }).click();
  await worker.getByRole('log', { name: 'Conversation' }).locator('img').first().click();
  const viewer = page.getByRole('dialog', { name: /^Image:/ });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(viewer.getByRole('button', { name: /Zoom level 125 percent/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.getByTestId('thread-session-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('thread-session-modal')).toHaveCount(0);
  await expect.poll(async () => (await persistedWorkspace(page)).activeSession).toBe('pi:hearth::16');
});

test('an already promoted worker links to its peer, and the peer shows in the rail', async ({ page }) => {
  // `?promoted` seeds a worker whose `promotedTo` points at its peer fork.
  await page.goto('/?promoted');
  // The workspace opens directly; the leader is always reachable from its rail row.
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const rail = page.locator('aside');
  // The peer is an ordinary session, so the rail lists it; the worker stays hidden by kind.
  await expect(rail.getByRole('button', { name: /Harness improver/ }).first()).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Harness audit/ })).toHaveCount(0);
  await expect(leader.getByRole('button', { name: 'Harness audit', exact: true })).toBeVisible();
  // The row is a peer link, not a live worker: it carries the `peer` badge instead of a status.
  await expect(leader.getByText('peer', { exact: true })).toBeVisible();
  await leader.getByRole('button', { name: 'Harness audit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main[data-session-key="pi:hearth::20"]')).toBeVisible();
  await expect.poll(async () => (await persistedWorkspace(page)).activeSession).toBe('pi:hearth::20');
});

test('the directory lists every spawned session automatically', async ({ page }) => {
  await expect(page.locator('aside')).toBeVisible();
  // Since Hearth 0.38.0 a spawned session is registered under its title in the same commit, so the
  // directory has names without anyone promoting anything — the state that used to be empty.
  const names = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      ember: { piRequest: (id: string, path: string, init?: { method: string; body: unknown }) => Promise<{ ok: boolean; data: unknown }> };
    }).ember;
    const response = await bridge.piRequest('pi:hearth', '/directory');
    return ((response.data as { agents?: Array<{ name: string; kind?: string }> }).agents ?? []).map(
      (agent) => `${agent.name}:${agent.kind ?? 'session'}`
    );
  });
  // The workers of the fixture crew, under their titles — the sessions an agent started...
  expect(names).toContain('Parse config:worker');
  expect(names).toContain('Migrate schema:worker');
  // ...and the peers a person pinned, still merged in from the same registry the promote route writes.
  expect(names).toContain('Archivist:peer');
});

test('the mock promote wire forks a peer, and refuses busy or duplicate promotions', async ({ page }) => {
  await expect(page.locator('aside')).toBeVisible();
  // The dialog flow below needs the app to wire `onPromote`; this pins the wire contract itself.
  const result = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      ember: { piRequest: (id: string, path: string, init: { method: string; body: unknown }) => Promise<{ ok: boolean; status: number; data: unknown }> };
    }).ember;
    const promote = (conversationId: string, body: unknown) =>
      bridge.piRequest('pi:hearth', `/conversations/${conversationId}/promote`, { method: 'POST', body });
    const busy = await promote('17', { name: 'Nope' }); // Parse config is running.
    const notWorker = await promote('16', { name: 'Nope' }); // The leader is not a worker.
    const ok = await promote('18', { name: 'Direct peer', pinned: true }); // Migrate schema is idle.
    // A name another conversation already answers to: every spawned session registers itself now,
    // so the worker's own title is taken — which is the duplicate this pins.
    const duplicate = await promote('18', { name: 'Migrate schema' });
    const summary = ok.data as { kind?: string; title?: string; lead?: { conversationId: number } };
    return {
      busy: busy.status,
      notWorker: notWorker.status,
      ok: ok.status,
      okKind: summary.kind,
      okTitle: summary.title,
      keptLead: summary.lead?.conversationId,
      duplicate: duplicate.status,
    };
  });
  expect(result.busy).toBe(409);
  expect(result.notWorker).toBe(400);
  expect(result.ok).toBe(201);
  expect(result.okKind).toBe('peer');
  expect(result.okTitle).toBe('Direct peer');
  expect(result.keptLead).toBe(16);
  expect(result.duplicate).toBe(400);
});

test('promoting an idle worker from its header opens the peer in the rail', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  // Migrate schema is idle (it just parked a question), so Hearth accepts the promotion.
  await leader.getByRole('button', { name: 'Migrate schema', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::18"]');
  await expect(worker).toBeVisible();

  await worker.getByRole('button', { name: 'Promote to peer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Promote worker to peer' });
  await expect(dialog.getByRole('heading', { name: 'Promote worker to peer' })).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Schema guardian');
  await dialog.getByRole('button', { name: 'Promote', exact: true }).click();

  const rail = page.locator('aside');
  await expect(rail.getByRole('button', { name: /Schema guardian/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(rail.getByRole('button', { name: /^Migrate schema/ })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('main[data-session-key="pi:hearth::18"]')).toHaveCount(0);
  await expect(page.locator('[data-active-chat]')).toContainText('Schema guardian');
});

test('a worker running at "off" reasoning is not reported as an unavailable level', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Parsing the config now…');

  // `off` sets no provider parameter, so Hearth omits it from the model's thinkingLevelMap. It is
  // still the level workers are started at, and it must not block the composer.
  await expect(worker.getByText(/is unavailable/)).toHaveCount(0);
  await expect(worker.getByText(/Your draft is kept/)).toHaveCount(0);

  await worker.getByRole('button', { name: 'Choose model' }).click();
  await expect(page.locator('[role="dialog"] [aria-label="Reasoning level"]')).toContainText('off');
});
