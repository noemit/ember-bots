import { expect, test } from '@playwright/test';

test('unfinished outcomes stay visible, expose evidence and source, and never count as Completed', async ({ page }, testInfo) => {
  await page.goto('/?fixture=task-outcomes&noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const tasks = leader.getByRole('tab', { name: /Tasks/ });
  await expect(tasks).toBeVisible();
  if (await tasks.getAttribute('aria-selected') !== 'true' || !await leader.locator('[data-task-id="96:1"]').isVisible()) await tasks.click();
  await expect(tasks).toContainText('4 active');
  await expect(tasks.locator('[title]')).toHaveAttribute('title', /3 unfinished/);
  await expect(leader.getByRole('button', { name: 'Completed 1', exact: true })).toBeVisible();
  const readMarks = () => page.evaluate(async () => (await window.ember.getSettings()).readMarks);
  const before = await readMarks();
  for (const [id, label] of [[96, 'Blocked'], [97, 'Incomplete'], [98, 'Handoff needed']] as const) {
    const row = leader.locator(`[data-task-id="${id}:1"]`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toContainText(label);
    await expect(row).toContainText('worker paused');
    const detail = row.locator('details');
    await detail.locator('summary').click();
    await expect(detail).toContainText('Next steps');
    await expect(detail).toContainText('full verification remains');
    await page.screenshot({ path: testInfo.outputPath(`task-${id}-outcome.png`) });
    await row.getByRole('button', { name: /Review|Finish/ }).first().click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator(`main[data-session-key="pi:hearth::${id}"]`) });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('log', { name: 'Conversation' })).toContainText('No success claimed');
    await expect(leader).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  expect(await readMarks()).toEqual(before);
  await leader.getByRole('button', { name: 'Completed 1', exact: true }).click();
  const completed = leader.getByRole('group', { name: 'Completed tasks', exact: true });
  await expect(completed).not.toContainText('Finish navigation');
  await expect(completed).not.toContainText('Review animation');
  // Only explicit reassignment restores activity; old outcome content is not the new assignment.
  await page.evaluate(async () => {
    const path = '/src/dev/mockPi.ts';
    const { mockInternals } = await import(/* @vite-ignore */ path);
    mockInternals.setTask(97, { id: '97:2', title: 'Verify revised navigation', status: 'working' });
  });
  await expect(leader.locator('[data-task-id="97:2"]')).toContainText('Working');
  await expect(tasks).toContainText('5 active');
  await expect(tasks.locator('[title]')).toHaveAttribute('title', /2 unfinished/);
});
