import { expect, test, type Locator, type Page } from '@playwright/test';

const rail = (page: Page) => page.getByTestId('session-rail');
const rowFor = (page: Page, title: string) =>
  rail(page)
    .locator('button')
    .filter({ has: page.locator('[data-session-title]', { hasText: title }) })
    .first();

async function fixture(page: Page, compact: boolean) {
  await page.route(/\/src\/dev\/mockPi\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const script = `
settings.compactRail = ${compact};
settings.snoozedSessions = ['pi:hearth::11'];
settings.sessionGroups = [{ id: 'align-group', name: 'Alignment team', keys: ['pi:hearth::13', 'pi:hearth::16'] }];
settings.openSessions = ['pi:hearth::15'];
settings.activeSession = 'pi:hearth::15';
`;
    await route.fulfill({ response, body: (await response.text()) + script });
  });
  await page.goto('/?noDock');
}

async function expectRowGeometry(row: Locator, expectedSize: number) {
  await row.scrollIntoViewIfNeeded();
  await expect(row.locator('.blob').first()).toHaveCSS('width', `${expectedSize}px`);
  await row.hover();
  const root = row.locator('..');
  const actions = (await root.locator('[data-rail-actions]').boundingBox())!;
  const heading = (await row.locator('[data-rail-folder]').boundingBox())!;
  expect(
    actions.y + actions.height,
    'hover actions stay in their band above the folder heading',
  ).toBeLessThanOrEqual(heading.y + 1);

  const wrapper = (await row.locator('[data-session-key]').boundingBox())!;
  const blob = (await row.locator('.blob').first().boundingBox())!;
  const text = (await row.locator('[data-rail-text]').boundingBox())!;
  expect(Math.round(blob.width)).toBe(expectedSize);
  expect(Math.round(blob.height)).toBe(expectedSize);
  expect(Math.round(wrapper.height)).toBe(expectedSize);

  const textCenterY = text.y + text.height / 2;
  const wrapperCenterY = wrapper.y + wrapper.height / 2;
  const blobCenterY = blob.y + blob.height / 2;
  expect(
    Math.abs(wrapperCenterY - textCenterY),
    `wrapper center (${wrapperCenterY}) must match text center (${textCenterY}) within 2px`,
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(blobCenterY - textCenterY),
    `blob center (${blobCenterY}) must match text center (${textCenterY}) within 2px`,
  ).toBeLessThanOrEqual(2);
}

for (const compact of [false, true]) {
  test(`session rows stay vertically centered across all blob sizes (compact ${compact})`, async ({ page }) => {
    test.setTimeout(90_000);
    await fixture(page, compact);
    await expect(rowFor(page, 'Habit onboarding QA')).toBeVisible();

    const sizes = [
      ['Standard', compact ? 40 : 55],
      ['Large', compact ? 50 : 69],
      ['Extra large', compact ? 60 : 83],
    ] as const;

    for (const [label, expectedPixels] of sizes) {
      if (label !== 'Standard') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
        await page.getByRole('button', { name: `${label} avatars`, exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }

      // Standard short row + row with Needs input badge
      await expectRowGeometry(rowFor(page, 'Habit onboarding QA'), expectedPixels);
      await expectRowGeometry(rowFor(page, 'Wire the pi mock'), expectedPixels);

      // Snoozed session row inside the collapsible Snoozed region
      const snoozedToggle = page.getByRole('region', { name: 'Snoozed sessions' }).getByRole('button', { name: /^Snoozed 1/ });
      if ((await snoozedToggle.getAttribute('aria-expanded')) === 'false') {
        await snoozedToggle.click();
      }
      await expectRowGeometry(rowFor(page, 'Remote access hardening'), expectedPixels);

      // GroupRow member row (bare small blob + text column)
      const member = rowFor(page, 'Dataset shortlist');
      await member.scrollIntoViewIfNeeded();
      const memberCenterDiff = await member.evaluate((el) => {
        const blobEl = el.querySelector('.blob')!;
        const blob = blobEl.getBoundingClientRect();
        const wrapper = blobEl.closest('span.relative')!.getBoundingClientRect();
        const text = el.querySelector('[data-group-member-title]')!.parentElement!.getBoundingClientRect();
        return {
          wrapperDiff: Math.abs(wrapper.y + wrapper.height / 2 - (text.y + text.height / 2)),
          blobDiff: Math.abs(blob.y + blob.height / 2 - (text.y + text.height / 2)),
        };
      });
      expect(memberCenterDiff.wrapperDiff).toBeLessThanOrEqual(2);
      expect(memberCenterDiff.blobDiff).toBeLessThanOrEqual(2);

      // Docked ComposerIdentity (blob centered beside text stack)
      const dock = page.locator('[data-composer-identity]');
      await expect(dock).toBeVisible();
      const dockCenterDiff = await dock.evaluate((el) => {
        const blob = el.querySelector('.blob')!.getBoundingClientRect();
        const title = el.querySelector('[data-composer-title]')!.parentElement!.getBoundingClientRect();
        return Math.abs(blob.y + blob.height / 2 - (title.y + title.height / 2));
      });
      expect(dockCenterDiff).toBeLessThanOrEqual(2);

      if (label === 'Standard') {
        await page.screenshot({ path: `/tmp/ember-rail-alignment-${compact ? 'compact' : 'normal'}.png` });
      }
    }
  });
}
