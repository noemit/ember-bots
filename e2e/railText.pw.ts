import { expect, test, type Locator, type Page } from '@playwright/test';

const longName = 'Patient Gardener reviewing the entire onboarding conversation and its follow-up accessibility recommendations';
const longPreview = 'Review the updated onboarding flow carefully and keep the helpful details visible while checking the final keyboard navigation and screen reader announcements.';

async function fixture(page: Page, options: { group?: boolean; compact?: boolean; empty?: boolean } = {}) {
  await page.route(/\/src\/dev\/mockPi\.ts(?:\?|$)/, async route => {
    const response = await route.fetch();
    const script = `\nconst railTextFixture = mockInternals.conversations.find(c => c.id === 10);\nrailTextFixture.title = ${JSON.stringify(longName)};\nfor (const entry of railTextFixture.entries) for (const message of entry.model ?? []) { if (Array.isArray(message.content)) for (const part of message.content) { if (part.type === 'text') part.text = ${JSON.stringify(longPreview)}; } }\nsettings.compactRail = ${Boolean(options.compact)};\n${options.empty ? `railTextFixture.title = 'VeryLongUnbrokenBotName'.repeat(12); railTextFixture.entries = [{ id: 99, kind: 'pi.assistant', model: [{role:'assistant', content:[], timestamp: Date.now() - 3600000}] }];` : ''}\n${options.group ? `settings.sessionGroups = [{id:'rail-text-group', name:'Review team', keys:['pi:hearth::10','pi:hearth::11']}];` : ''}\n`;
    await route.fulfill({ response, body: await response.text() + script });
  });
  await page.goto('/?noDock');
}

async function twoLines(locator: Locator) {
  await expect(locator).toBeVisible();
  const dimensions = await locator.evaluate(el => ({ height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), width: el.clientWidth, scroll: el.scrollWidth }));
  expect(dimensions.height).toBeGreaterThan(dimensions.line * 1.5);
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.line * 2 + 1);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
}

async function timestampBelowTitle(row: Locator) {
  const title = await row.locator('[data-session-title]').boundingBox();
  const time = await row.locator('[data-session-time]').boundingBox();
  expect(time!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
  expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const preview = row.getByTestId('session-preview');
  if (await preview.count()) {
    const description = (await preview.boundingBox())!;
    expect(Math.abs(description.y + description.height - time!.y - time!.height)).toBeLessThan(2);
    expect(description.x + description.width).toBeLessThanOrEqual(time!.x + 1);
  }
}

for (const compact of [false, true]) {
  test(`rail wraps names and previews without action collisions (compact ${compact})`, async ({ page }) => {
    await fixture(page, { compact });
    const row = page.getByTestId('session-rail').getByRole('button').filter({ has: page.locator('[data-session-title]', { hasText: longName }) });
    await expect(row).toBeVisible();
    await twoLines(row.locator('[data-session-title]'));
    await timestampBelowTitle(row);
    if (!compact) await twoLines(row.getByTestId('session-preview'));
    await page.waitForTimeout(800);
    const timeOffset = async () => (await row.locator('[data-session-time]').boundingBox())!.y - (await row.boundingBox())!.y;
    const beforeHover = await timeOffset();
    await row.hover();
    await expect.poll(async () => Math.abs(await timeOffset() - beforeHover)).toBeLessThan(1);
    await twoLines(row.locator('[data-session-title]'));
    await timestampBelowTitle(row);
    const actions = await row.locator('..').locator('[data-rail-actions]').boundingBox();
    const titleBox = await row.locator('[data-session-title]').boundingBox();
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(titleBox!.y + 1);
    await page.screenshot({ path: `/tmp/ember-rail-text-normal-${compact}.png` });
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('session-rail')).toHaveCSS('width', '760px');
    await timestampBelowTitle(row);
    const preview = row.getByTestId('session-preview');
    if (await preview.count()) expect(await preview.evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1)).toBe(true);
    await page.screenshot({ path: `/tmp/ember-rail-text-wide-${compact}.png` });
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('[data-mini-session="pi:hearth::10"]')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+b');
    await row.click();
    const dock = page.locator('[data-active-chat]');
    await expect(dock).toContainText(longName);
    await twoLines(dock.locator('[data-composer-title]'));
    const dockTitle = await dock.locator('[data-composer-title]').boundingBox();
    const dockActions = await dock.locator('[data-composer-identity-actions]').boundingBox();
    expect(dockTitle!.x + dockTitle!.width).toBeLessThanOrEqual(dockActions!.x + 1);
    const composer = page.locator('main[data-session-key="pi:hearth::10"] textarea');
    for (let i = 0; i < 2; i++) {
      await composer.fill('A longer draft\n'.repeat(9));
      await composer.fill('Short');
    }
    await page.waitForTimeout(800);
    const bounds = await dock.boundingBox();
    const identity = await dock.locator('[data-composer-identity]').boundingBox();
    expect(identity!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(identity!.y + identity!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    await page.setViewportSize({ width: 430, height: 900 });
    await page.waitForTimeout(800);
    await twoLines(page.locator('[data-composer-title]'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ember-rail-text-mobile-${compact}.png` });
  });
}

test('group member names and descriptions wrap within the rail', async ({ page }) => {
  await fixture(page, { group: true });
  const member = page.locator('button').filter({ has: page.locator('[data-group-member-title]', { hasText: longName }) });
  await expect(member).toBeVisible();
  await twoLines(member.locator('[data-session-title]'));
  await twoLines(member.getByTestId('session-preview'));
  await timestampBelowTitle(member);
  await page.screenshot({ path: '/tmp/ember-rail-text-group.png' });
});

test('unbroken names wrap and missing descriptions keep a separate timestamp line', async ({ page }) => {
  await fixture(page, { empty: true });
  const row = page.getByTestId('session-rail').getByRole('button').filter({ has: page.locator('[data-session-title]', { hasText: 'VeryLongUnbrokenBotName' }) });
  await twoLines(row.locator('[data-session-title]'));
  await expect(row.getByTestId('session-preview')).toHaveCount(0);
  await expect(row.locator('[data-session-time]')).toBeVisible();
  await timestampBelowTitle(row);
});
