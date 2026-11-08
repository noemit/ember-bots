import { expect, test, type Locator, type Page } from '@playwright/test';

const projectKey = 'directory:pi:hearth::/workspace/hearth';
const projectOverride = { color: '#d25b87', shapeName: 'cloud' };
const center = (page: Page) => page.getByRole('button', { name: 'Customize new bot appearance' });
const paints = (blob: Locator) => blob.locator('svg').first().locator('[fill], stop').evaluateAll(elements =>
  elements.filter(el => !el.closest('.blob-badge')).map(el => el.tagName === 'stop' ? getComputedStyle(el).stopColor : getComputedStyle(el).fill)
    .filter(color => !color.startsWith('url(')));
const snapshot = (page: Page) => page.evaluate(async () => {
  const settings = await window.ember.getSettings();
  const instances = await window.ember.listInstances() as { id: string }[];
  const response = await window.ember.piRequest!(instances[0].id, '/conversations');
  return { overrides: settings.avatarOverrides, style: settings.blobStyle,
    conversations: (response.data as { conversations: { id: number }[] }).conversations.map(c => c.id) };
});
const start = async (page: Page, query = '') => {
  await page.addInitScript(({ key, override }) => localStorage.setItem('ember-pi-read-state', JSON.stringify({
    blobStyle: 'buddy', avatarOverrides: { [key]: override },
  })), { key: projectKey, override: projectOverride });
  await page.goto(`/?noDock${query}`);
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(center(page)).toBeVisible();
  return snapshot(page);
};
const customize = async (page: Page, style = 'Mosaic', shape = 'crown') => {
  await center(page).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Customize appearance' });
  await dialog.getByRole('combobox', { name: 'Appearance scope' }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: 'This new bot', exact: true }).click();
  const styles = dialog.getByRole('group', { name: 'Bot style' });
  await expect(styles.getByRole('button')).toHaveText(['Buddy', 'Crystal', 'Mosaic', 'Lava']);
  await expect(dialog.getByRole('button', { name: 'Scribble', exact: true })).toHaveCount(0);
  await styles.getByRole('button', { name: style, exact: true }).click();
  await dialog.getByLabel('Custom bot color').fill('#158cba');
  await dialog.getByRole('button', { name: shape, exact: true }).click();
  const colors = await paints(dialog.locator(`.blob-${style.toLowerCase()}`).first());
  if (style === 'Mosaic') await page.screenshot({ path: '/tmp/ember-draft-appearance-picker.png' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => paints(center(page).locator('.blob'))).toEqual(colors);
  return colors;
};
const send = async (page: Page, text: string) => {
  await page.locator('textarea').first().fill(text);
  await page.locator('textarea').first().press('Enter');
};
const assertCreated = async (page: Page, before: Awaited<ReturnType<typeof snapshot>>, colors: string[], style = 'Mosaic', shape = 'crown') => {
  const column = page.locator('main[data-session-key]');
  await expect(column).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).conversations.length).toBe(before.conversations.length + 1);
  const key = await column.getAttribute('data-session-key');
  await expect.poll(async () => (await snapshot(page)).overrides?.[`session:${key}`]).toMatchObject({
    style: style.toLowerCase(), color: '#158cba', shapeName: shape,
  });
  const after = await snapshot(page);
  expect(after.style).toBe(before.style);
  for (const [key, value] of Object.entries(before.overrides ?? {})) expect(after.overrides?.[key]).toEqual(value);
  expect(Object.keys(after.overrides ?? {})).toHaveLength(Object.keys(before.overrides ?? {}).length + 1);
  const identity = page.locator('[data-composer-identity]').filter({ has: page.locator(`.blob-${style.toLowerCase()}`) }).first();
  await expect.poll(() => paints(identity.locator('.blob').first())).toEqual(colors);
  const title = await identity.locator('span[title]').last().innerText();
  // Leaving the chat moves the same identity from the composer dock into the rail.
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).first().click();
  const railBlob = page.locator('aside').getByRole('button', { name: new RegExp(title) }).locator(`.blob-${style.toLowerCase()}`);
  await expect(railBlob).toHaveCount(1);
  await expect.poll(() => paints(railBlob)).toEqual(colors);
  if (style === 'Mosaic') await expect(railBlob).toHaveAttribute('data-shape', shape);
};

for (const [style, shape] of [['Buddy', 'cloud'], ['Crystal', 'prism'], ['Mosaic', 'crown'], ['Lava', 'peanut']]) {
  test(`${style}: draft appearance stays local until send and follows the created bot`, async ({ page }) => {
    const before = await start(page);
    const colors = await customize(page, style, shape);
    expect(await snapshot(page)).toEqual(before);
    if (style === 'Mosaic') await page.screenshot({ path: '/tmp/ember-draft-appearance-preview.png' });
    await send(page, `appearance ${style.toLowerCase()}`);
    await assertCreated(page, before, colors, style, shape);
    if (style === 'Mosaic') await page.screenshot({ path: '/tmp/ember-draft-appearance-created.png' });
  });
}

test('a failed create retains its frozen appearance on retry', async ({ page }) => {
  const before = await start(page, '&failCreate');
  const colors = await customize(page);
  await send(page, 'retry this appearance');
  const failure = page.getByRole('status').filter({ hasText: "didn't start this session" });
  await expect(failure).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await failure.getByRole('button', { name: 'Try again' }).click();
  await assertCreated(page, before, colors);
});

test('closing the picker or cancelling a draft never changes the next draft', async ({ page }) => {
  const before = await start(page);
  const original = await paints(center(page).locator('.blob'));
  await center(page).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('group', { name: 'Bot style' }).getByRole('button', { name: 'Mosaic' }).click();
  await dialog.getByLabel('Custom bot color').fill('#158cba');
  await page.keyboard.press('Escape');
  await expect.poll(() => paints(center(page).locator('.blob'))).toEqual(original);
  await customize(page);
  await page.getByRole('button', { name: 'Cancel new bot' }).click();
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(center(page).locator('.blob-buddy')).toBeVisible();
  await expect.poll(() => paints(center(page).locator('.blob'))).toEqual(original);
  expect(await snapshot(page)).toEqual(before);
});

test('a slow create keeps its appearance when it completes away from the draft', async ({ page }) => {
  const before = await start(page, '&slowCreate');
  const colors = await customize(page);
  await send(page, 'appearance in background');
  await expect(page.getByText(/Starting this session on/)).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.locator('aside').getByRole('button', { name: /Screenshot review/ }).first().click();
  const reading = page.locator('main[data-session-key]');
  const key = await reading.getAttribute('data-session-key');
  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());
  await expect(page.getByText(/Started “.*” on ember-harness \(mock\)\./)).toBeVisible();
  await expect(reading).toHaveAttribute('data-session-key', key!);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await assertCreated(page, before, colors);
});

// Shape coordinates, not SVG ids or animation phases: automatic Crystal/Lava geometry is seeded.
const geometry = (blob: Locator) => blob.locator('svg').first().locator('path, circle, ellipse').evaluateAll(elements =>
  elements.filter(el => !el.closest('.blob-badge')).map(el =>
    ['d', 'cx', 'cy', 'r', 'rx', 'ry'].map(attribute => el.getAttribute(attribute))));

for (const style of ['Crystal', 'Lava']) {
  test(`${style}: choosing only a style freezes automatic geometry through creation`, async ({ page }) => {
    const before = await start(page);
    await center(page).focus();
    await page.keyboard.press('Space');
    const dialog = page.getByRole('dialog', { name: 'Customize appearance' });
    await dialog.getByRole('group', { name: 'Bot style' }).getByRole('button', { name: style }).click();
    const selector = `.blob-${style.toLowerCase()}`;
    const preview = dialog.locator(selector).first();
    const shape = await geometry(preview);
    const colors = await paints(preview);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => geometry(center(page).locator(selector))).toEqual(shape);
    await expect.poll(() => paints(center(page).locator(selector))).toEqual(colors);
    expect(await snapshot(page)).toEqual(before);
    await send(page, `automatic ${style.toLowerCase()} identity`);
    await expect(page.locator('main[data-session-key]')).toBeVisible();
    const saved = page.locator('[data-composer-identity]').locator(selector).first();
    await expect.poll(() => geometry(saved)).toEqual(shape);
    await expect.poll(() => paints(saved)).toEqual(colors);
  });
}
