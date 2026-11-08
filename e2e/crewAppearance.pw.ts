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
  await expect(identity).toHaveAttribute('data-mood', 'busy');
  await expect(leader.locator('[data-session-status]')).toHaveText('Waiting on 1 worker…');
  for (const style of ['Buddy', 'Crystal', 'Mosaic', 'Lava', 'Scribble']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(style) }).click();
    await page.keyboard.press('Escape');
    await expect(identity).toHaveAttribute('data-mood', 'busy');
    await expect(leader.getByRole('textbox', { name: 'Message your bot' })).toBeEnabled();
    await expect(leader.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(leader.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0);
  }
  const stopped = await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/conversations/17/abort', { method: 'POST' }));
  expect(stopped.ok).toBe(true);
  await expect(identity).toHaveAttribute('data-mood', /^(idle|unread)$/);
});
