import { expect, test } from '@playwright/test';

/**
 * Coagent crews in the pi mock: a leader's workers are hidden from the rail, surfaced only in
 * the crew strip, openable as transient columns, and a worker's pending question rolls up to the
 * leader. The `[crew]` wake renders as a system card, not a user bubble.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the rail hides crew workers; the leader shows its crew strip', async ({ page }) => {
  // Home has no rail: the leader is opened from its card, which is what puts the rail on screen.
  await page.getByRole('button', { name: 'Crew: auth refactor', exact: true }).click();
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

test('opening a worker from the strip opens a transient column, still out of the rail', async ({ page }) => {
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker).toBeVisible();
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Parse the config and report back.');
  await expect(page.locator('aside').getByRole('button', { name: /^Parse config/ })).toHaveCount(0);
});

test('an already promoted worker links to its peer, and the peer shows in the rail', async ({ page }) => {
  // `?promoted` seeds a worker whose `promotedTo` points at its peer fork.
  await page.goto('/?promoted');
  // Home has no rail: the leader is opened from its card, which is what puts the rail on screen.
  await page.getByRole('button', { name: 'Crew: auth refactor', exact: true }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const rail = page.locator('aside');
  // The peer is an ordinary session, so the rail lists it; the worker stays hidden by kind.
  await expect(rail.getByRole('button', { name: /Harness improver/ }).first()).toBeVisible();
  await expect(rail.getByRole('button', { name: /^Harness audit/ })).toHaveCount(0);
  await expect(leader.getByRole('button', { name: 'Harness audit', exact: true })).toBeVisible();
  // The row is a peer link, not a live worker: it carries the `peer` badge instead of a status.
  await expect(leader.getByText('peer', { exact: true })).toBeVisible();
});

test('the directory lists every spawned session automatically', async ({ page }) => {
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
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Promote worker to peer' })).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Schema guardian');
  await dialog.getByRole('button', { name: 'Promote', exact: true }).click();

  const rail = page.locator('aside');
  await expect(rail.getByRole('button', { name: /Schema guardian/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(rail.getByRole('button', { name: /^Migrate schema/ })).toHaveCount(0);
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
  await expect(page.getByRole('dialog').locator('[aria-label="Reasoning level"]')).toContainText('off');
});
