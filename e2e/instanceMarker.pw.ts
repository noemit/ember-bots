import { expect, test, type Locator, type Page } from '@playwright/test';

const markerIndex = 2;
async function markedFixture(page: Page, marked = true) {
  await page.addInitScript(({ marked, markerIndex }) => {
    localStorage.setItem('ember-pi-read-state', JSON.stringify({ instanceDefaults: marked ? { 'pi:hearth': { markerColor: markerIndex } } : {} }));
  }, { marked, markerIndex });
  await page.goto('/?noDock');
}
async function expectedColor(page: Page) {
  return page.evaluate(index => {
    const probe = document.createElement('span');
    probe.style.color = `var(--instance-marker-${index})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, markerIndex);
}
async function expectNamedMarker(name: Locator, color: string) {
  await expect(name).toBeVisible();
  await expect(name).toHaveCSS('text-decoration-line', 'underline');
  await expect(name).toHaveCSS('text-decoration-color', color);
  await expect(name).toHaveCSS('text-decoration-thickness', '2px');
}
async function expectCompactMarker(scope: Locator, color: string) {
  const marker = scope.locator('[data-instance-marker]');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveCSS('background-color', color);
  await expect(marker).not.toHaveAttribute('data-column-underline');
  const box = (await marker.boundingBox())!;
  expect(box.width).toBeGreaterThan(8);
  expect(box.height).toBeGreaterThanOrEqual(2);
}

test('configured instance underline survives selection, dock handovers, hover and all rail widths', async ({ page }) => {
  await markedFixture(page);
  const row = page.getByTestId('session-rail').getByRole('button', { name: /Habit onboarding QA/ });
  await expect(row).toBeVisible();
  const color = await expectedColor(page);
  await expectNamedMarker(row.locator('[data-session-title]'), color);
  await row.hover();
  await expectNamedMarker(row.locator('[data-session-title]'), color);
  await row.click();
  const dock = page.locator('[data-active-chat="pi:hearth::10"]');
  await expectNamedMarker(dock.locator('[data-composer-name]'), color);
  await dock.hover();
  await expectNamedMarker(dock.locator('[data-composer-name]'), color);
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/ember-instance-marker-normal.png' });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('session-rail')).toHaveCSS('width', '760px');
  await expectNamedMarker(dock.locator('[data-composer-name]'), color);
  await page.screenshot({ path: '/tmp/ember-instance-marker-wide.png' });
  await page.keyboard.press('ControlOrMeta+b');
  await expectCompactMarker(dock, color);
  const other = page.locator('[data-mini-session="pi:hearth::11"]');
  await expectCompactMarker(other, color);
  await other.click();
  await expectCompactMarker(page.locator('[data-active-chat="pi:hearth::11"]'), color);
  await expectCompactMarker(page.locator('[data-mini-session="pi:hearth::10"]'), color);
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/ember-instance-marker-mini.png' });
  await page.keyboard.press('ControlOrMeta+b');
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(700);
  await expectNamedMarker(page.locator('[data-composer-name]'), color);
  await page.screenshot({ path: '/tmp/ember-instance-marker-mobile.png' });
});

test('unconfigured instance stays unmarked after selection and in mini dock', async ({ page }) => {
  await markedFixture(page, false);
  await page.getByTestId('session-rail').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const dock = page.locator('[data-active-chat="pi:hearth::10"]');
  await expect(dock.locator('[data-composer-name]')).toHaveCSS('text-decoration-line', 'none');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(dock.locator('[data-instance-marker]')).toHaveCount(0);
});

test('split-view instance markers remain distinct from active-column underlines', async ({ page }) => {
  await markedFixture(page);
  await expect(page.locator('[data-active-chat]')).toContainText('Crew: auth refactor');
  const color = await expectedColor(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await expectNamedMarker(page.locator('main[data-session-key="pi:hearth::16"] [data-composer-name]'), color);
  await expectNamedMarker(page.locator('[data-active-chat] [data-composer-name]'), color);
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+b');
  const openOther = page.locator('[data-mini-session="pi:hearth::16"]');
  await expectCompactMarker(openOther, color);
  await expect(openOther.locator('[data-column-underline]')).toBeVisible();
  const marker = (await openOther.locator('[data-instance-marker]').boundingBox())!;
  const active = (await openOther.locator('[data-column-underline]').boundingBox())!;
  expect(marker.y + marker.height).toBeLessThanOrEqual(active.y);
  await expect(openOther.locator('[data-column-underline]')).not.toHaveCSS('background-color', color);
});
