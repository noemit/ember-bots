import { expect, test } from '@playwright/test';

const assignments = (page: import('@playwright/test').Page) => page.evaluate(async () => (await window.ember.getSettings()).avatarAssignments);

const startBot = async (page: import('@playwright/test').Page, index: number) => {
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'New bot project' })).toBeVisible();
  const draft = page.locator('main').filter({ has: page.getByRole('button', { name: 'New bot project' }) });
  const before = await draft.locator('.blob svg path[fill^="var(--blob-"]').first().getAttribute('fill');
  await page.locator('textarea').first().fill('Build a distinct bot ' + index);
  await page.locator('textarea').first().press('Enter');
  await expect.poll(async () => Object.keys(await assignments(page)).length).toBe(index + 1);
  await expect(page.getByRole('button', { name: 'New bot project' })).toHaveCount(0);
  if (before) await expect(page.locator('[data-active-chat] .blob svg path[fill^="var(--blob-"]').first()).toHaveAttribute('fill', before);
};

test('new bots in the same folder get distinct durable defaults without recolouring old bots', async ({ page }) => {
  test.setTimeout(90_000); // Six complete UI creations, including the mock's streaming replies.
  await page.goto('/?noDock');
  await expect(page.locator('[data-active-chat]')).toBeVisible();
  expect(await assignments(page)).toEqual({});
  for (let i = 0; i < 6; i++) await startBot(page, i);
  const stored = await assignments(page);
  expect(new Set(Object.values(stored).map(entry => entry.colorIndex)).size).toBe(6);
  expect(new Set(Object.values(stored).map(entry => entry.shapeSeed)).size).toBe(6);
  await page.keyboard.press('ControlOrMeta+b');
  await page.screenshot({ path: '/tmp/ember-distinct-bots.png', animations: 'disabled' });
  await page.reload();
  await expect(page.locator('[data-active-chat]')).toBeVisible();
  expect(await assignments(page)).toEqual(stored);
});

test('an explicit shared folder colour remains shared, even for newly allocated bots', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ember-pi-read-state', JSON.stringify({
    avatarOverrides: { 'directory:pi:hearth::/workspace/hearth': { color: '#551eb3', shapeName: 'cloud' } },
    instanceDefaults: { 'pi:hearth': { directory: '/workspace/hearth' } },
  })));
  await page.goto('/?noDock');
  await expect(page.locator('[data-active-chat]')).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'New bot project' })).toBeVisible();
    await page.locator('textarea').first().fill('Keep my chosen purple ' + i);
    await page.locator('textarea').first().press('Enter');
    await expect.poll(async () => Object.keys(await assignments(page)).length).toBe(i + 1);
    await expect(page.locator('[data-active-chat] .blob svg path[fill="#551eb3"]')).not.toHaveCount(0);
  }
  expect((await page.evaluate(async () => (await window.ember.getSettings()).avatarOverrides))['directory:pi:hearth::/workspace/hearth']).toEqual({ color: '#551eb3', shapeName: 'cloud' });
});

test('overlapping creates reserve different identities before either host reply arrives', async ({ page }) => {
  await page.goto('/?noDock&slowCreate');
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'New bot project' })).toBeVisible();
    await page.locator('textarea').first().fill('Reserve a distinct identity ' + i);
    await page.locator('textarea').first().press('Enter');
    await expect(page.getByText(/Starting this session on/).first()).toBeVisible();
  }
  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());
  await expect.poll(async () => Object.keys(await assignments(page)).length, { timeout: 15_000 }).toBe(2);
  const saved = Object.values(await assignments(page));
  expect(saved[0].colorIndex).not.toBe(saved[1].colorIndex);
  expect(saved[0].shapeSeed).not.toBe(saved[1].shapeSeed);
});

test('only the promoted bot gets an assignment, never its worker thread', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Migrate schema', exact: true }).click();
  await page.locator('main[data-session-key="pi:hearth::18"]').getByRole('button', { name: 'Promote to peer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Promote worker to peer' });
  await dialog.getByLabel('Name', { exact: true }).fill('Distinct promoted bot');
  await dialog.getByRole('button', { name: 'Promote', exact: true }).click();
  await expect.poll(async () => Object.keys(await assignments(page)).length).toBe(1);
  const key = await page.locator('main[data-session-key]').first().getAttribute('data-session-key');
  const stored = await assignments(page);
  expect(Object.keys(stored)).toEqual([key]);
  expect(stored['pi:hearth::18']).toBeUndefined();
});

test('bots started outside Ember get assignments after the complete baseline, but restored history does not', async ({ page }) => {
  await page.goto('/?noDock');
  await expect(page.locator('[data-active-chat]')).toBeVisible();
  expect(await assignments(page)).toEqual({});
  const ids = await page.evaluate(async () => {
    const ids: number[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await window.ember.piRequest!<{ id: number }>('pi:hearth', '/conversations', {
        method: 'POST', body: { title: 'External bot ' + index, cwd: '/workspace/hearth' },
      });
      if (!result.ok) throw new Error('Mock refused external creation');
      ids.push(result.data.id);
      await window.ember.piRequest!('pi:hearth', '/conversations/' + result.data.id, { method: 'PATCH', body: {} });
    }
    return ids;
  });
  await expect.poll(async () => Object.keys(await assignments(page)).length).toBe(3);
  const saved = await assignments(page);
  expect(new Set(ids.map(id => saved['pi:hearth::' + id].colorIndex)).size).toBe(3);
  await page.evaluate(async () => {
    await window.ember.piRequest!('pi:hearth', '/conversations/14', { method: 'PATCH', body: { archived: null } });
    await window.ember.piRequest!('pi:hearth', '/conversations/14/submit', { method: 'POST', body: { content: 'Restore this older bot' } });
  });
  await expect(page.locator('aside').getByText('Old thumbnail notes', { exact: true }).first()).toBeVisible();
  expect(await assignments(page)).toEqual(saved);
});
