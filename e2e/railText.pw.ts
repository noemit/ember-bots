import { expect, test, type Locator, type Page } from '@playwright/test';

const longName = 'Patient Gardener reviewing the entire onboarding conversation and its follow-up accessibility recommendations';
const longPreview = 'Review the updated onboarding flow carefully and keep the helpful details visible while checking the final keyboard navigation and screen reader announcements.';
// Intentionally needs more than two lines: a line-clamp-2 is not a full folder name.
const folder = 'VeryLongUnbrokenFolderName'.repeat(8);
const project = 'ConfiguredProjectWithAnUnbrokenName'.repeat(6);
const multiProject = 'MultiSessionProjectWithAnUnbrokenName'.repeat(6);
const pathTitle = `/second-parent/${folder}`;

async function fixture(page: Page, options: { group?: boolean; compact?: boolean; empty?: boolean } = {}) {
  await page.route(/\/src\/dev\/mockPi\.ts(?:\?|$)/, async route => {
    const response = await route.fetch();
    const script = `
const railTextFixture = mockInternals.conversations.find(c => c.id === 10);
railTextFixture.title = ${JSON.stringify(longName)};
railTextFixture.cwd = ${JSON.stringify('/first-parent/' + folder)};
for (const entry of railTextFixture.entries) for (const message of entry.model ?? []) {
  if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === 'text') part.text = ${JSON.stringify(longPreview)};
  }
}
mockInternals.conversations.find(c => c.id === 11).cwd = ${JSON.stringify('/workspace/' + project)};
mockInternals.conversations.find(c => c.id === 11).title = 'Distinct configured single session';
mockInternals.conversations.find(c => c.id === 12).cwd = ${JSON.stringify('/second-parent/' + folder)};
mockInternals.conversations.find(c => c.id === 12).title = ${JSON.stringify(pathTitle)};
for (const id of [13, 14]) {
  const c = mockInternals.conversations.find(c => c.id === id);
  c.cwd = ${JSON.stringify('/workspace/' + multiProject)};
  c.title = 'Distinct multi session ' + id;
  delete c.archived;
}
mockFolders['/workspace'].push(${JSON.stringify(project)}, ${JSON.stringify(multiProject)});
settings.compactRail = ${Boolean(options.compact)};
settings.openSessions = ['pi:hearth::15']; settings.activeSession = 'pi:hearth::15';
${options.empty ? `railTextFixture.entries = [{ id: 99, kind: 'pi.assistant', model: [{role:'assistant', content:[], timestamp: Date.now() - 3600000}] }];` : ''}
${options.group ? `settings.sessionGroups = [{id:'rail-text-group', name:'Review team', keys:['pi:hearth::10','pi:hearth::11']}];` : ''}
`;
    await route.fulfill({ response, body: await response.text() + script });
  });
  await page.goto('/?noDock');
}

const rail = (page: Page) => page.getByTestId('session-rail');
const rowFor = (page: Page, title: string) => rail(page).locator('button, [role="button"]:not([aria-label^="Open group"])').filter({ has: page.locator('[data-session-title]', { hasText: title }) });

/** Check actual text glyph rectangles, not just the wrapper's (possibly clipped) dimensions. */
async function fullText(locator: Locator, text: string, multiline = false) {
  await expect(locator).toHaveText(text);
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    const clips: string[] = [];
    for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor);
      const box = ancestor.getBoundingClientRect();
      if (lines.some(line =>
        (/hidden|clip|auto|scroll/.test(css.overflowX) && (line.left < box.left - 1 || line.right > box.right + 1)) ||
        (/hidden|clip|auto|scroll/.test(css.overflowY) && (line.top < box.top - 1 || line.bottom > box.bottom + 1)))) {
        clips.push(ancestor.tagName + '.' + ancestor.className);
      }
    }
    return { height: rect.height, line: parseFloat(style.lineHeight), width: el.clientWidth, scroll: el.scrollWidth,
      overflowWrap: style.overflowWrap, clamp: style.webkitLineClamp, ellipsis: style.textOverflow,
      outside: lines.some(line => line.left < rect.left - 1 || line.right > rect.right + 1 || line.top < rect.top - 1 || line.bottom > rect.bottom + 1), clips };
  });
  expect(geometry.overflowWrap).toBe('anywhere');
  expect(geometry.clamp).toMatch(/^(none|0)$/);
  expect(geometry.ellipsis).not.toBe('ellipsis');
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.outside, 'text glyphs must fit the folder element').toBe(false);
  expect(geometry.clips, 'no ancestor may clip any folder text').toEqual([]);
  if (multiline) expect(geometry.height).toBeGreaterThan(geometry.line * 2.5);
}

async function hierarchy(row: Locator, folderName: string, titleText: string, mustExceedTwoLines = true) {
  const heading = row.locator('[data-rail-folder]');
  const title = row.locator('[data-session-title]');
  await row.scrollIntoViewIfNeeded();
  await fullText(heading, folderName, mustExceedTwoLines);
  await expect(title).toHaveText(titleText);
  const folderBox = (await heading.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  expect(folderBox.y + folderBox.height).toBeLessThanOrEqual(titleBox.y + 1);
  expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

async function timestampBelowTitle(row: Locator) {
  const title = (await row.locator('[data-session-title]').boundingBox())!;
  const time = (await row.locator('[data-session-time]').boundingBox())!;
  expect(time.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
}

async function blobCenteredWithText(row: Locator) {
  const wrapper = (await row.locator('[data-session-key]').boundingBox())!;
  const blob = (await row.locator('.blob').first().boundingBox())!;
  const text = (await row.locator('[data-rail-text]').boundingBox())!;
  const textCenter = text.y + text.height / 2;
  expect(Math.abs(wrapper.y + wrapper.height / 2 - textCenter)).toBeLessThanOrEqual(2);
  expect(Math.abs(blob.y + blob.height / 2 - textCenter)).toBeLessThanOrEqual(2);
}

for (const compact of [false, true]) {
  test(`full folder above distinct session; descriptions only wide (compact ${compact})`, async ({ page }) => {
    await fixture(page, { compact });
    const row = rowFor(page, longName);
    await hierarchy(row, folder, longName);
    await expect(row.getByTestId('session-preview')).toHaveCount(0);
    await timestampBelowTitle(row);
    await row.hover();
    await hierarchy(row, folder, longName);
    const actions = (await row.locator('..').locator('[data-rail-actions]').boundingBox())!;
    const heading = (await row.locator('[data-rail-folder]').boundingBox())!;
    expect(actions.y + actions.height, 'hover actions stay in their band above the complete folder').toBeLessThanOrEqual(heading.y + 1);
    await blobCenteredWithText(row);
    await page.screenshot({ path: `/tmp/ember-rail-text-normal-${compact}.png` });
    await page.keyboard.press('ControlOrMeta+b');
    await expect(rail(page)).toHaveCSS('width', '760px');
    await hierarchy(row, folder, longName, false);
    await expect(row.getByTestId('session-preview')).toBeVisible();
    await expect(row.getByTestId('session-preview')).toContainText('Review the updated onboarding');
    await timestampBelowTitle(row);
    await blobCenteredWithText(row);
    await page.screenshot({ path: `/tmp/ember-rail-text-wide-${compact}.png` });
    await page.keyboard.press('ControlOrMeta+b');
    const icon = page.locator('[data-mini-session="pi:hearth::10"]');
    await expect(icon).toBeVisible();
    await expect(icon.locator('[data-session-title], [data-rail-folder], [data-testid="session-preview"]')).toHaveCount(0);
    await icon.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText(longName);
    await expect(tooltip).toContainText('Review the updated onboarding');
    await page.screenshot({ path: `/tmp/ember-rail-text-mini-${compact}.png` });
  });
}

test('configured single project keeps its session title; multi project heading stays complete', async ({ page }) => {
  // Kiln directories intentionally stay standalone in App; configured project cards are legacy-only.
  await page.route(/\/src\/dev\/mockLegacy\.ts(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
settings.sessionGroups = [];
settings.openSessions = ['local::ses_a8']; settings.activeSession = 'local::ses_a8';
projects.local = [
  {id:'single', path:'/workspace/single', label:${JSON.stringify(project)}},
  {id:'multi', path:'/workspace/multi', label:${JSON.stringify(multiProject)}}
];
for (const [id, directory, title] of [
  ['ses_a2', '/workspace/single', 'Distinct configured single session'],
  ['ses_a1', '/workspace/multi', 'Distinct multi session 13'],
  ['ses_a3', '/workspace/multi', 'Distinct multi session 14']
]) Object.assign(sessions.local.find(c => c.id === id), { directory, title });
` });
  });
  await page.goto('/?legacy&noDock');
  await hierarchy(rowFor(page, 'Distinct configured single session'), project, 'Distinct configured single session');
  const card = rail(page).getByRole('button', { name: `Open ${multiProject}`, exact: true });
  await card.scrollIntoViewIfNeeded();
  await fullText(card.getByText(multiProject, { exact: true }), multiProject, true);
  await expect(card).toContainText('Distinct multi session 13');
  await expect(card).toContainText('Distinct multi session 14');
  await page.screenshot({ path: '/tmp/ember-rail-text-projects.png' });
  await rowFor(page, 'Distinct configured single session').click();
  await page.locator('main[data-session-key="local::ses_a2"] header').getByRole('button', { name: 'Hide session', exact: true }).click();
  await page.getByRole('button', { name: 'Hidden sessions', exact: true }).click();
  const hidden = page.getByRole('dialog', { name: 'Hidden sessions', exact: true });
  const hiddenRow = hidden.getByRole('button').filter({ has: page.locator('[data-session-title]', { hasText: 'Distinct configured single session' }) });
  await hierarchy(hiddenRow, project, 'Distinct configured single session');
  await expect(hiddenRow.getByTestId('session-preview')).toBeVisible();
  await page.screenshot({ path: '/tmp/ember-rail-text-hidden-dialog.png' });
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Search sessions…').fill(project);
  await page.getByRole('button', { name: 'Search hidden sessions', exact: true }).click();
  const hiddenSearchRow = rowFor(page, 'Distinct configured single session');
  await hierarchy(hiddenSearchRow, project, 'Distinct configured single session');
  await expect(hiddenSearchRow.getByTestId('session-preview')).toHaveCount(0);
  await expect(hiddenSearchRow.locator('[data-rail-folder]')).toHaveAttribute('title', '/workspace/single');
  await page.screenshot({ path: '/tmp/ember-rail-text-hidden-search.png' });
});

test('duplicate basenames and path-shaped session titles remain separate in search and Snoozed', async ({ page }) => {
  await fixture(page);
  await page.getByPlaceholder('Search sessions…').fill(folder);
  await hierarchy(rowFor(page, longName), folder, longName);
  await hierarchy(rowFor(page, pathTitle), folder, pathTitle);
  await expect(rowFor(page, pathTitle).locator('[data-rail-folder]')).toHaveAttribute('title', '/second-parent/' + folder);
  await page.getByPlaceholder('Search sessions…').fill('');
  await rowFor(page, longName).click();
  await page.locator('main[data-session-key="pi:hearth::10"]').getByRole('button', { name: 'Snooze session', exact: true }).click();
  await rowFor(page, pathTitle).click();
  const snoozed = page.getByRole('region', { name: 'Snoozed sessions' });
  await snoozed.getByRole('button', { name: /^Snoozed 1/ }).click();
  await hierarchy(snoozed.getByRole('button').filter({ has: page.locator('[data-session-title]', { hasText: longName }) }), folder, longName);
  await page.screenshot({ path: '/tmp/ember-rail-text-snoozed.png' });
});

test('group members keep full folder hierarchy and hide normal previews', async ({ page }) => {
  await fixture(page, { group: true });
  const member = rowFor(page, longName);
  await hierarchy(member, folder, longName);
  await expect(member.getByTestId('session-preview')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+b');
  await hierarchy(member, folder, longName, false);
  await expect(member.getByTestId('session-preview')).toBeVisible();
  await page.screenshot({ path: '/tmp/ember-rail-text-group.png' });
});

test('dock retains complete folder and composer geometry through growth and mobile', async ({ page }) => {
  await fixture(page, { empty: true });
  const row = rowFor(page, longName);
  await hierarchy(row, folder, longName);
  await expect(row.getByTestId('session-preview')).toHaveCount(0);
  await timestampBelowTitle(row);
  await row.click();
  const dock = page.locator('[data-active-chat="pi:hearth::10"]');
  await fullText(dock.locator('[data-rail-folder]'), folder, true);
  const title = dock.locator('[data-composer-title]');
  await expect(title).toHaveText(longName);
  const composer = page.locator('main[data-session-key="pi:hearth::10"] textarea');
  for (let i = 0; i < 2; i++) {
    await composer.fill('A longer draft\n'.repeat(9));
    await composer.fill('Short');
  }
  await expect.poll(async () => {
    const band = (await dock.boundingBox())!;
    const identity = (await dock.locator('[data-composer-identity]').boundingBox())!;
    return identity.y >= band.y - 1 && identity.y + identity.height <= band.y + band.height + 1;
  }).toBe(true);
  const titleBox = (await title.boundingBox())!;
  const actions = (await dock.locator('[data-composer-identity-actions]').boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(actions.x + 1);
  await page.screenshot({ path: '/tmp/ember-rail-text-dock.png' });
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(page.locator('[data-composer-title]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Toggle sessions sidebar', exact: true }).click();
  // Open mobile sidebar keeps the same real row geometry, without the desktop dock.
  await hierarchy(rowFor(page, 'Distinct configured single session'), project, 'Distinct configured single session');
  await page.screenshot({ path: '/tmp/ember-rail-text-mobile.png' });
});
