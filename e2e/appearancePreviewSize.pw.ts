import { expect, test, type Page } from '@playwright/test';

const primary = (page: Page) => page.getByTestId('appearance-primary-preview').locator('.blob').first();

async function expectPreviewSize(page: Page, size: number) {
  const blob = primary(page);
  await expect(blob).toHaveCSS('width', `${size}px`);
  await expect(blob).toHaveCSS('height', `${size}px`);
  await expect.poll(() => blob.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const element = node as HTMLElement;
    return { width: rect.width, height: rect.height, layoutWidth: element.offsetWidth, layoutHeight: element.offsetHeight };
  })).toEqual({ width: size, height: size, layoutWidth: size, layoutHeight: size });
  // Rendering at 56px and visually scaling it is not the requested size change.
  await expect(blob).toHaveCSS('transform', 'none');
  const thumbnails = page.getByRole('dialog').locator('button .blob');
  await expect.poll(() => thumbnails.count()).toBeGreaterThan(1);
  expect(await thumbnails.evaluateAll(nodes => nodes.every(node => {
    const rect = node.getBoundingClientRect();
    return rect.width === 30 && rect.height === 30 && (node as HTMLElement).offsetWidth === 30;
  }))).toBe(true);
}

async function expectPointerTracking(page: Page) {
  const blob = primary(page);
  await blob.hover({ trial: true });
  const box = (await blob.boundingBox())!;
  await page.mouse.move(Math.round(box.x + box.width / 2 + 22), Math.round(box.y + box.height / 2 - 14));
  await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
  await expect.poll(() => blob.locator('.blob-pupil').evaluateAll(nodes => nodes.length === 2 && nodes.every(node => {
    const matrix = (node as SVGGElement).transform.baseVal.consolidate()?.matrix;
    return matrix && matrix.e > 0 && matrix.f < 0;
  }))).toBe(true);
}

test('appearance preview uses each configured rail size while shape thumbnails stay compact', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  for (const [label, size] of [['Standard', 55], ['Large', 69], ['Extra large', 83]] as const) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: `${label} avatars`, exact: true }).click();
    await page.keyboard.press('Escape');
    const dock = page.locator('[data-active-chat]');
    await expect(dock.locator('.blob').first()).toHaveCSS('width', `${size}px`);
    await dock.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
    await expectPreviewSize(page, size);
    if (size !== 83) await page.keyboard.press('Escape');
  }

  await page.screenshot({ path: '/tmp/ember-appearance-size-desktop.png' });
  // Keep the largest preview open while switching to a narrow viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectPreviewSize(page, 83);
  const geometry = await primary(page).evaluate(node => {
    const box = node.getBoundingClientRect();
    const dialog = node.closest('[role="dialog"]')!.getBoundingClientRect();
    let fitsClips = true;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) fitsClips &&= box.left >= rect.left && box.right <= rect.right;
      if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) fitsClips &&= box.top >= rect.top && box.bottom <= rect.bottom;
    }
    return {
      fitsClips,
      dialogFits: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
      pageFits: document.documentElement.scrollWidth <= innerWidth,
    };
  });
  expect(geometry).toEqual({ fitsClips: true, dialogFits: true, pageFits: true });
  await expectPointerTracking(page);
  await page.screenshot({ path: '/tmp/ember-appearance-size-mobile.png' });
});

test('an open appearance picker reacts to live size context changes without replacing its preview or draft', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Replace only the dev gallery entry in this browser. Real AvatarPicker, its portal and the
  // production size context remain intact; no fixture route or controls enter production code.
  await page.route('**/src/dev/blobGalleryMain.tsx*', async route => {
    const original = await (await route.fetch()).text();
    const react = original.match(/["']([^"']*\/react\.js(?:\?[^"']*)?)["']/)?.[1];
    const reactDom = original.match(/["']([^"']*\/react-dom_client\.js(?:\?[^"']*)?)["']/)?.[1];
    if (!react || !reactDom) throw new Error('Vite did not expose the gallery React module imports for the browser fixture.');
    await route.fulfill({ contentType: 'text/javascript', body: `
      import React from ${JSON.stringify(react)};
      import ReactDOM from ${JSON.stringify(reactDom)};
      import AvatarPicker from '/src/components/AvatarPicker.tsx';
      import { AvatarSizeContext } from '/src/blob/size.tsx';
      import { seedIdentity } from '/src/blob/seed.ts';
      import { applyTheme } from '/src/themes.ts';
      import '/src/styles.css';
      const identity = seedIdentity('preview-size-fixture');
      const scopes = [{ key: 'session', label: 'This session', kind: 'session' }];
      const resolvePreview = (_scope, override) => ({ ...identity, ...override });
      function Fixture() {
        const [size, setSize] = React.useState('standard');
        React.useEffect(() => {
          applyTheme('stone');
          const changeSize = event => {
            if (!event.altKey) return;
            const size = { '1': 'standard', '2': 'large', '3': 'extra-large' }[event.key];
            if (size) { event.preventDefault(); setSize(size); }
          };
          window.addEventListener('keydown', changeSize);
          return () => window.removeEventListener('keydown', changeSize);
        }, []);
        return React.createElement(AvatarSizeContext.Provider, { value: size },
          React.createElement(AvatarPicker, {
            open: true, title: 'Live size preview — Alt+1 / Alt+2 / Alt+3', style: 'buddy', theme: 'stone',
            identity, scopes, overrides: {}, resolvePreview, onSave: () => {}, onOpenChange: () => {},
          }));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    ` });
  });
  await page.goto('/blob-gallery.html');
  await expectPreviewSize(page, 55);
  await primary(page).evaluate(node => { (node as HTMLElement).dataset.samePreview = 'retained'; });
  await page.getByLabel('Custom bot color').fill('#a858c8');
  for (const [key, size] of [['2', 69], ['3', 83], ['1', 55]] as const) {
    await page.keyboard.press(`Alt+${key}`);
    await expectPreviewSize(page, size);
    await expect(primary(page)).toHaveAttribute('data-same-preview', 'retained');
    await expect(page.getByLabel('Custom bot color')).toHaveValue('#a858c8');
    await expectPointerTracking(page);
  }
});
