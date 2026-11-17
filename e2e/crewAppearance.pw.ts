import { expect, test } from '@playwright/test';

test('every style shows crew work without taking over the leader’s idle composer', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const identity = page.locator('[data-composer-identity] .blob');
  // A blocked worker takes precedence over the other worker's running turn.
  await expect(identity).toHaveAttribute('data-mood', 'question');
  const reply = await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/questions/18/worker-question/reply', {
    method: 'POST', body: { answer: 'No' },
  }));
  expect(reply.ok).toBe(true);
  await expect(identity).toHaveAttribute('data-mood', /^(busy|thinking)$/);
  await expect(leader.locator('[data-session-status]')).toHaveText('Tackling 1 task.');
  // Scribble is preserved as a stored preference, but no longer offered as a production style.
  for (const style of ['Buddy', 'Crystal', 'Mosaic', 'Lava']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(style) }).click();
    await page.keyboard.press('Escape');
    await expect(identity).toHaveAttribute('data-mood', /^(busy|thinking)$/);
    await expect(leader.getByRole('textbox', { name: 'Message your bot' })).toBeEnabled();
    await expect(leader.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(leader.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0);
  }
  const stopped = await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/conversations/17/abort', { method: 'POST' }));
  expect(stopped.ok).toBe(true);
  await expect(identity).toHaveAttribute('data-mood', /^(idle|unread)$/);
});


test('shared rail/composer phases keep the same DOM and idle availability, then settle immediately', async ({ page }, testInfo) => {
  test.setTimeout(100_000);
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: /Mosaic/ }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    (window as unknown as { crewReads: string[] }).crewReads = [];
    window.ember.piRequest = (host, path, init) => {
      if (/\/conversations\/(17|18)\/entries/.test(path)) (window as unknown as { crewReads: string[] }).crewReads.push(path);
      return original(host, path, init);
    };
  });
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/questions/18/worker-question/reply', {
    method: 'POST', body: { answer: 'No' },
  }));
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const composer = page.locator('[data-active-chat="pi:hearth::16"] .blob');
  await expect(composer).toHaveAttribute('data-mood', /^(busy|thinking)$/);
  // Keep the crew root in the rail while another chat owns the composer.
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const rail = page.getByRole('button', { name: /Crew: auth refactor/ }).first().locator('.blob');
  await expect(rail).toHaveAttribute('data-mood', /^(busy|thinking)$/);
  await rail.evaluate(node => { (window as unknown as { crewNode: Element }).crewNode = node; });
  const phases = new Set<string>();
  for (let i = 0; i < 22; i++) {
    const phase = (await rail.getAttribute('data-mood'))!;
    if (!phases.has(phase)) await page.screenshot({ path: testInfo.outputPath('rail-' + phase + '.png') });
    phases.add(phase);
    expect(await rail.evaluate(node => node === (window as unknown as { crewNode: Element }).crewNode)).toBe(true);
    await page.waitForTimeout(1000);
  }
  expect([...phases].sort()).toEqual(['busy', 'thinking']);
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await expect(leader.locator('[data-session-status]')).toHaveText('Tackling 1 task.');
  await expect(leader.locator('[data-session-status] > span').first()).toHaveClass(/bg-success/);
  const composerNode = await composer.elementHandle();
  const composerPhases = new Set<string>();
  for (let i = 0; i < 22; i++) {
    const phase = (await composer.getAttribute('data-mood'))!;
    if (!composerPhases.has(phase)) await page.screenshot({ path: testInfo.outputPath('composer-' + phase + '.png') });
    composerPhases.add(phase);
    expect(await composer.evaluate((node, original) => node === original, composerNode)).toBe(true);
    await expect(leader.getByRole('textbox', { name: 'Message your bot' })).toBeEnabled();
    await expect(leader.getByRole('button', { name: /^(Stop|Stop generating)$/ })).toHaveCount(0);
    await page.waitForTimeout(1000);
  }
  expect([...composerPhases].sort()).toEqual(['busy', 'thinking']);
  // Background summaries may warm bounded tails; animation never opens full worker history.
  const reads = await page.evaluate(() => (window as unknown as { crewReads: string[] }).crewReads);
  expect(reads.filter(path => Number(new URL(path, 'http://mock').searchParams.get('limit')) >= 100)).toEqual([]);
  await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/conversations/17/abort', { method: 'POST' }));
  await expect(composer).toHaveAttribute('data-mood', /^(idle|unread)$/);
  await page.waitForTimeout(25000);
  await expect(composer).toHaveAttribute('data-mood', /^(idle|unread)$/);
});

test('reduced motion is stable; hidden documents pause the shared clock', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/questions/18/worker-question/reply', {
    method: 'POST', body: { answer: 'No' },
  }));
  const identity = page.locator('[data-active-chat="pi:hearth::16"] .blob');
  await expect(identity).toHaveAttribute('data-mood', /^(busy|thinking)$/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(identity).toHaveAttribute('data-mood', 'busy');
  for (let i = 0; i < 22; i++) {
    await page.clock.runFor(1000);
    await expect(identity).toHaveAttribute('data-mood', 'busy');
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const phase = await identity.getAttribute('data-mood');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let i = 0; i < 22; i++) {
    await page.clock.runFor(1000);
    await expect(identity).toHaveAttribute('data-mood', phase!);
  }
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const phases = new Set<string>();
  for (let i = 0; i < 22; i++) {
    phases.add((await identity.getAttribute('data-mood'))!);
    await page.clock.runFor(1000);
  }
  expect([...phases].sort()).toEqual(['busy', 'thinking']);
});
