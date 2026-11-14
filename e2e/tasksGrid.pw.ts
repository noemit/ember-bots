import { expect, test } from '@playwright/test';

test('Tasks follow their container, preserve history and expose 44px controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/e2e/fixtures/tasks-grid.html');
  const pane = page.locator('#fixture-pane');
  const grid = pane.locator(':scope > [role="group"] > ul');
  const columns = () => grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  const completed = page.getByRole('button', { name: 'Completed 1', exact: true });
  await expect(completed).toHaveAttribute('aria-expanded', 'false');
  await completed.click();
  await expect(completed).toHaveAttribute('aria-expanded', 'true');
  const history = page.getByRole('group', { name: 'Completed tasks', exact: true });
  await expect(history.locator('[data-worker-status="done"] [data-tray-meta]')).toHaveText('Completed');
  const outcome = history.locator('details');
  await expect(outcome).not.toHaveAttribute('open');
  await expect(outcome.locator('dl')).toBeHidden();
  await outcome.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(outcome.locator('dl')).toBeVisible();
  for (const text of ['Screenshots captured', 'Synthetic fixture only', 'Device checks']) {
    await expect(outcome.locator('dl')).toContainText(text);
  }
  await page.screenshot({ path: testInfo.outputPath('tasks-outcome-details.png'), clip: { x: 0, y: 0, width: 1072, height: 365 } });
  await outcome.locator('summary').click();
  await expect(outcome.locator('dl')).toBeHidden();
  const previous = page.getByRole('button', { name: '+2 previous', exact: true });
  await previous.click();
  await expect(page.getByRole('list', { name: 'Previous worker chats' }).locator('[data-crew-brick]')).toHaveCount(2);
  await expect(pane.locator('[data-crew-brick]')).toHaveCount(12);
  await expect(pane.locator('[data-thread-depth="3"]')).toContainText('via Legacy parent');
  for (const [width, count] of [[390, 1], [420, 1], [480, 2], [720, 3], [1040, 4]]) {
    await pane.evaluate((node, width) => { node.style.width = width + 'px'; }, width);
    await expect.poll(columns).toBe(count);
    const siblingColumns = await grid.locator(':scope > [data-crew-brick]').evaluateAll((nodes) =>
      new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size);
    expect(siblingColumns).toBe(count);
    const padding = await pane.locator('[data-crew-brick]').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).paddingLeft));
    expect(new Set(padding).size).toBe(1); // legacy depth is context, never a narrow nested column
    // No viewport resize: a 420px split pane inside a wide window still has one column.
    const dimensions = await pane.locator('button:visible, summary:visible').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { name: button.getAttribute('aria-label') ?? button.textContent, w: rect.width, h: rect.height };
    }));
    for (const dimension of dimensions) {
      expect(Math.round(dimension.w * 100) / 100, String(dimension.name)).toBeGreaterThanOrEqual(44);
      expect(Math.round(dimension.h * 100) / 100, String(dimension.name)).toBeGreaterThanOrEqual(44);
    }
    const first = grid.locator(':scope > [data-crew-brick]').first();
    await first.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('tasks-' + width + '.png'), clip: { x: 0, y: 0, width: width + 32, height: 365 } });
    await history.getByRole('button', { name: 'Capture narrow pane screenshots', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('tasks-' + width + '-history.png'), clip: { x: 0, y: 0, width: width + 32, height: 365 } });
    expect(await grid.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  const yolo = pane.getByRole('button', { name: 'Turn off YOLO mode for Review provider connection recovery', exact: true });
  await yolo.focus();
  await expect(yolo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('button', { name: 'Turn on YOLO mode for Review provider connection recovery', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // Focus and actions use the existing callback, not any conversation API.
  const nested = pane.locator('[data-thread-depth="3"] button').first();
  await nested.focus();
  await expect(nested).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('output')).toHaveText('Legacy nested question still reachable');
  await completed.click();
  await expect(history).toBeHidden();
  await completed.focus();
  await page.keyboard.press('Enter');
  await expect(history).toBeVisible();
  await history.getByRole('button', { name: 'Capture narrow pane screenshots', exact: true }).click();
  await expect(page.locator('output')).toHaveText('Capture narrow pane screenshots');
});


test('Tasks fit a real 390px mobile viewport with no horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/fixtures/tasks-grid.html');
  const pane = page.locator('#fixture-pane');
  await pane.evaluate((node) => { node.style.width = '100%'; });
  const grid = pane.locator(':scope > [role="group"] > ul');
  await expect.poll(() => grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await pane.evaluate((node) => node.getBoundingClientRect().width)).toBe(358);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tasks-mobile-390.png') });
  const completed = pane.getByRole('button', { name: 'Completed 1', exact: true });
  await completed.click();
  const outcome = pane.locator('details');
  await outcome.locator('summary').click();
  await outcome.locator('dd').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('tasks-mobile-390-outcome.png') });
  for (const target of await pane.locator('button:visible, summary:visible').all()) {
    const box = await target.boundingBox();
    expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
  }
});


test('each cell contains long unbroken content at column boundaries, including larger text', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/e2e/fixtures/tasks-grid.html?stress');
  const pane = page.locator('#fixture-pane');
  await pane.getByRole('button', { name: 'Completed 1', exact: true }).click();
  await pane.locator('details summary').click();
  await pane.getByRole('button', { name: '+2 previous', exact: true }).click();
  await expect(pane.locator('[data-crew-brick]')).toHaveCount(12);
  for (const largerText of [false, true]) {
    if (largerText) await page.addStyleTag({ content: `
      [data-tray-preview] { font-size: 18.75px; line-height: 30px; }
      [data-tray-meta] { font-size: 15.75px; line-height: 24px; }
      details { font-size: 16.5px; line-height: 25px; }
    ` });
    for (const [width, columns] of [[479, 1], [480, 2], [719, 2], [720, 3], [959, 3], [960, 4]]) {
      await pane.evaluate((node, width) => { node.style.width = width + 'px'; }, width);
      await expect.poll(() => pane.locator(':scope > [role="group"] > ul').evaluate((node) =>
        getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(columns);
      const violations = await pane.locator('[data-crew-brick]').evaluateAll((bricks) => bricks.flatMap((brick) => {
        const cell = brick.getBoundingClientRect();
        return [...brick.querySelectorAll<HTMLElement>('button, summary, details, dl, dd, [data-tray-preview], [data-tray-meta]')].flatMap((element) => {
          const box = element.getBoundingClientRect();
          const label = (element.tagName + ': ' + element.textContent).slice(0, 100);
          // Per-cell checks catch overflow hidden by the outer scrolling grid. Title line
          // clamping is intentional vertically; no title/status/outcome may spill horizontally.
          const errors = [];
          if (box.left < cell.left - 1 || box.right > cell.right + 1) errors.push(label + ' crosses cell bounds');
          if (element.scrollWidth > element.clientWidth + 1) errors.push(label + ' clips horizontal content');
          if (element.matches('dd') && element.scrollHeight > element.clientHeight + 1) errors.push(label + ' clips outcome vertically');
          return errors;
        });
      }));
      expect(violations, String({ width, largerText })).toEqual([]);
      if (largerText && [480, 720, 960].includes(width)) {
        await pane.locator('details dd').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('tasks-long-outcome-large-text-' + width + '.png'), clip: { x: 0, y: 0, width: width + 32, height: 365 } });
      }
    }
  }
});
