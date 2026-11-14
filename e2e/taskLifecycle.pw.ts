import { expect, test } from '@playwright/test';

for (const narrow of [false, true]) {
  test(`Tasks keeps explicit outcomes and accessible Done source chats (${narrow ? 'narrow' : 'desktop'})`, async ({ page }, testInfo) => {
    await page.goto('/?fixture=task-lifecycle&noDock');
    await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
    if (narrow) await page.setViewportSize({ width: 700, height: 900 });
    const leader = page.locator('main[data-session-key="pi:hearth::16"]');
    const tasks = leader.getByRole('tab', { name: /Tasks/ });
    await expect(tasks).toBeVisible();
    await expect(tasks).toContainText('active');
    if (await tasks.getAttribute('aria-selected') !== 'true' || !await leader.getByRole('button', { name: 'Parse config outcome', exact: true }).isVisible()) await tasks.click();
    await expect(leader.getByRole('button', { name: 'Parse config outcome', exact: true })).toBeVisible();
    await expect(leader.locator('[data-task-id="17:1"]')).toContainText('Working');
    await expect(leader.locator('[data-task-id="18:1"]')).toContainText('Waiting for you');
    const idle = leader.locator('[data-task-id="91:1"]');
    await expect(idle).toContainText('Waiting');
    await expect(idle).not.toContainText('Waiting for you');
    await expect(leader.locator('[data-task-id="92:1"]')).toContainText('Stopped');
    await expect(leader.locator('[data-task-id="93:1"]')).toContainText('Blocked');
    await expect(leader.locator('[data-task-id="95:1"]')).toContainText('Failed');
    await expect(leader.locator('[data-task-id="95:1"]')).not.toContainText('Stopped');
    const done = leader.getByRole('button', { name: 'Done 1', exact: true });
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(leader.getByRole('button', { name: 'Publish migration guide', exact: true })).toHaveCount(0);
    await done.focus();
    await page.keyboard.press('Enter');
    await expect(done).toHaveAttribute('aria-expanded', 'true');
    const doneGroup = leader.getByRole('group', { name: 'Done tasks', exact: true });
    await expect(doneGroup).toContainText('not coordinator verification');
    const source = doneGroup.getByRole('button', { name: 'Publish migration guide', exact: true });
    await expect(source).toHaveAttribute('title', /Open source chat.*Done/);
    await expect(doneGroup).toContainText('Evidence: docs/migration.md');
    await expect(doneGroup).toContainText('Remaining: Manual review remains.');
    await source.scrollIntoViewIfNeeded();
    await expect(source).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('tasks-done-expanded.png') });
    await source.click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator('main[data-session-key="pi:hearth::90"]') });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('log', { name: 'Conversation' })).toContainText('Final reply exists');
    await page.keyboard.press('Escape');
    await expect(source).toBeFocused();
    await done.click();
    await expect(done).toHaveAttribute('aria-expanded', 'false');
    await expect(source).toHaveCount(0);
    await expect(idle).toBeVisible();
    const previous = leader.getByRole('button', { name: /previous/ });
    await previous.click();
    await expect(leader.getByRole('button', { name: 'Legacy finished chat', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('tasks-shelf.png') });
    await tasks.click();
    await expect(leader.getByRole('button', { name: 'Parse config outcome', exact: true })).toHaveCount(0);
    await tasks.click();
    await expect(leader.getByRole('button', { name: 'Parse config outcome', exact: true })).toBeVisible();
    // An open source chat must survive completion; folding its row must not close the result.
    await leader.getByRole('button', { name: 'Check final reply without completion', exact: true }).click();
    const completingDialog = page.getByRole('dialog').filter({ has: page.locator('main[data-session-key="pi:hearth::91"]') });
    await expect(completingDialog).toBeVisible();
    // Completing an assignment changes the shelf via a view hint, not a final reply or idle poll.
    await page.evaluate(async () => {
      const path = '/src/dev/mockPi.ts';
      const { mockInternals } = await import(/* @vite-ignore */ path);
      mockInternals.setTask(91, {
        id: '91:1', title: 'Check final reply without completion', status: 'done',
        completion: { task: '91:1', requestId: 'complete-91', at: Date.now(), summary: 'Explicitly complete now', evidence: 'Unit checks pass', remaining: 'Review remains' },
      });
    });
    await expect(completingDialog).toBeVisible();
    await expect(leader.locator('[data-task-id="91:1"]')).toHaveCount(0);
    await expect(completingDialog.getByRole('log', { name: 'Conversation' })).toContainText('Final reply exists');
    await page.keyboard.press('Escape');
    await expect(leader.getByRole('button', { name: 'Done 2', exact: true })).toBeVisible();
    await expect(idle).toHaveCount(0);
    // Reopening creates another assignment identity and returns it to active, without human-needed copy.
    await page.evaluate(async () => {
      const path = '/src/dev/mockPi.ts';
      const { mockInternals } = await import(/* @vite-ignore */ path);
      mockInternals.setTask(91, { id: '91:2', title: 'Review revised outcome', status: 'waiting' });
    });
    await expect(leader.locator('[data-task-id="91:2"]')).toContainText('Waiting');
    await expect(leader.locator('[data-task-id="91:2"]')).not.toContainText('Waiting for you');
    await expect(leader.getByRole('button', { name: 'Done 1', exact: true })).toBeVisible();
  });
}
