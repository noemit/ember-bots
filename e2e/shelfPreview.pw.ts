import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const longText = 'Review the shelf preview without losing the rest of this message. '.repeat(18)
  + '\nFinal instruction: preserve the complete source text in the reading dialog.';

async function openChat(page: Page, leader = false) {
  await page.goto('/?staleBusy');
  await page.locator('aside').getByRole('button', { name: leader ? /Crew: auth refactor/ : /Remote access hardening/ }).first().click();
  const column = page.locator(`main[data-session-key="pi:hearth::${leader ? 16 : 11}"]`);
  await expect(column.locator('textarea')).toBeEnabled();
  return column;
}
async function enqueue(column: Locator, text: string) {
  await column.locator('textarea').fill(text);
  await column.locator('textarea').press('Enter');
  await expect(column.getByRole('button', { name: 'Cancel queued message: ' + text.slice(0, 60), exact: true })).toBeEnabled();
}
async function note(column: Locator, text: string) {
  await column.locator('textarea').fill(text);
  await column.getByRole('button', { name: 'Save as note', exact: true }).click();
  await expect(column.getByRole('button', { name: 'Read note: ' + text.slice(0, 60), exact: true })).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + '.png');
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}
const queueRows = (column: Locator) => column.getByRole('list', { name: 'Queued messages' }).locator(':scope > li');
async function noHorizontalOverflow(locator: Locator) {
  await expect.poll(() => locator.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
}

test('two-line previews keep full read-only text and metadata below without list numbers', async ({ page }, info) => {
  const column = await openChat(page);
  await enqueue(column, longText);
  await enqueue(column, 'A second preview makes the quiet separator visible.');
  const row = queueRows(column).first();
  const read = row.getByRole('button', { name: /^Read queued message:/ });
  await expect(read).toContainText(longText);
  // Measure the rendered preview, not its retained source text.
  const preview = read.locator('[class*="line-clamp-2"]');
  await expect(preview).toHaveCount(1);
  await expect.poll(() => preview.evaluate(el => {
    const style = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().height / Number.parseFloat(style.lineHeight));
  })).toBe(2);
  expect(await row.evaluate(el => getComputedStyle(el.parentElement!).listStyleType)).toBe('none');
  expect(await row.evaluate(el => Number.parseFloat(getComputedStyle(el).borderBottomWidth))).toBe(1);
  const model = row.getByText(/faux-hearth/).first();
  await expect(model).toBeVisible();
  const textBounds = (await preview.boundingBox())!;
  expect((await model.boundingBox())!.y).toBeGreaterThanOrEqual(textBounds.y + textBounds.height - 1);
  await row.hover();
  await screenshot(page, info, 'desktop-shelf-actions');
  await read.click();
  const dialog = page.getByRole('dialog', { name: 'Queued message', exact: true });
  await expect(dialog.locator('pre')).toHaveText(longText);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  await screenshot(page, info, 'desktop-shelf-reading');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(queueRows(column)).toHaveCount(2);
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('Final instruction:');
});

test('full tab bar and keyboard toggles preserve inactive selection semantics', async ({ page }, info) => {
  const column = await openChat(page, true);
  await enqueue(column, 'Queued keyboard check');
  await note(column, 'Saved keyboard check');
  const shelf = column.getByRole('group', { name: 'Composer trays', exact: true });
  await expect(shelf.getByRole('tab')).toHaveCount(3);
  const queue = shelf.getByRole('tab', { name: /^Queue/ });
  const notes = shelf.getByRole('tab', { name: /^For later/ });
  const threads = shelf.getByRole('tab', { name: /^Threads/ });
  await queue.click();
  await expect(queue).toHaveAttribute('aria-expanded', 'true');
  await queue.press('ArrowRight');
  await expect(notes).toBeFocused();
  await expect(queue).toHaveAttribute('aria-selected', 'true');
  await notes.press('End');
  await expect(threads).toBeFocused();
  await threads.press('Home');
  await expect(queue).toBeFocused();
  await queue.press('ArrowLeft');
  await expect(threads).toBeFocused();
  await threads.press('Enter');
  await expect(threads).toHaveAttribute('aria-selected', 'true');
  await expect(shelf.getByRole('tabpanel', { name: 'Threads' })).toBeVisible();
  await threads.press('Space');
  await expect(threads).toHaveAttribute('aria-expanded', 'false');
  await expect(shelf.getByRole('tabpanel')).toHaveCount(0);
  // The inactive tab must open only once: bubbling must not fold it again.
  await notes.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'true');
  await expect(shelf.getByRole('tabpanel', { name: 'For later' })).toBeVisible();
  const bar = shelf.getByRole('button', { name: /tab bar/i });
  await bar.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  await bar.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'true');
  await notes.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'false');
  await notes.click();
  await expect(notes).toHaveAttribute('aria-expanded', 'true');
  await threads.click();
  await expect(shelf.locator('[data-crew-brick] .blob')).toHaveCount(0);
  await expect(shelf.getByRole('button', { name: 'Migrate schema', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    window.ember.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/auto-accept')) sessionStorage.setItem('shelf-yolo-request', JSON.stringify({ instance, path, ...init }));
      return original<T>(instance, path, init);
    };
  });
  await shelf.getByRole('button', { name: 'Turn on YOLO mode for Parse config', exact: true }).click();
  const yoloEvidence = await page.evaluate(async () => ({
    request: JSON.parse(sessionStorage.getItem('shelf-yolo-request') ?? 'null'),
    host: (await window.ember.piRequest!<{ conversations: Array<{ id: number; autoAccept: boolean }> }>('pi:hearth', '/conversations')).data.conversations.find(item => item.id === 17),
  }));
  expect(yoloEvidence.request).toMatchObject({ path: '/conversations/17/auto-accept', body: { enabled: true } });
  expect(yoloEvidence.host?.autoAccept).toBe(true);
  await info.attach('worker-yolo-wire', { body: JSON.stringify(yoloEvidence, null, 2), contentType: 'application/json' });
  const yolo = shelf.getByRole('button', { name: 'Turn off YOLO mode for Parse config', exact: true });
  await expect(yolo).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, info, 'desktop-thread-rows');
  await yolo.click();
  await expect(shelf.getByRole('button', { name: 'Turn on YOLO mode for Parse config', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('a single tab retains its count and disappears when its final item is removed', async ({ page }) => {
  const column = await openChat(page);
  await expect(column.getByRole('group', { name: 'Composer trays', exact: true })).toHaveCount(0);
  await enqueue(column, 'Only queued item');
  await expect(column.getByRole('tab')).toHaveCount(1);
  await expect(column.getByRole('tab')).toContainText(/Queue\s*1/);
  await column.getByRole('button', { name: 'Cancel queued message: Only queued item', exact: true }).click();
  await expect(column.getByRole('group', { name: 'Composer trays', exact: true })).toHaveCount(0);
});

test('queue reorder, merge, park and send remain reachable through preview rows', async ({ page }) => {
  const column = await openChat(page);
  for (const text of ['First action message', 'Second action message', 'Third action message']) await enqueue(column, text);
  await column.getByRole('button', { name: 'Move queued message up: Second action message', exact: true }).click();
  await expect(queueRows(column).first()).toContainText('Second action message');
  await column.getByRole('button', { name: 'More actions for queued message: First action message', exact: true }).click();
  await page.getByRole('menuitem', { name: /Merge into the one above/ }).click();
  await expect(queueRows(column)).toHaveCount(2);
  await expect(queueRows(column).first()).toContainText('Second action message');
  await expect(queueRows(column).first()).toContainText('First action message');
  await queueRows(column).first().getByRole('button', { name: /^More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Park it as a note', exact: true }).click();
  await expect(column.getByRole('button', { name: /^Read note: Second action message/ })).toBeVisible();
  await column.getByRole('tab', { name: /^Queue/ }).click();
  await expect(queueRows(column)).toHaveCount(1);
  await column.getByRole('button', { name: 'Send queued message now: Third action message', exact: true }).click();
  await expect(column.getByRole('tab', { name: /^Queue/ })).toHaveCount(0);
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Third action message');
});

test('notes read in full, append to a retained composer draft, send and delete', async ({ page }) => {
  const column = await openChat(page);
  await note(column, longText);
  await column.getByRole('button', { name: /^Read note:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Note for later', exact: true });
  await expect(dialog.locator('pre')).toHaveText(longText);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await column.locator('textarea').fill('Existing composer draft');
  await column.getByRole('button', { name: /^Edit note in composer:/ }).click();
  await expect(column.locator('textarea')).toHaveValue('Existing composer draft\n\n' + longText);
  await expect(column.getByRole('tab', { name: /^For later/ })).toHaveCount(0);
  await expect(column.locator('textarea')).toBeFocused();
  await note(column, 'Delete this saved thought');
  await column.getByRole('button', { name: 'Delete note: Delete this saved thought', exact: true }).click();
  await expect(column.getByRole('tab', { name: /^For later/ })).toHaveCount(0);
  await note(column, 'Send this saved thought');
  await column.getByRole('button', { name: 'Read note: Send this saved thought', exact: true }).click();
  await page.getByRole('dialog', { name: 'Note for later', exact: true }).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect(column.getByRole('tab', { name: /^For later/ })).toHaveCount(0);
  await expect(column.getByRole('button', { name: 'Read queued message: Send this saved thought', exact: true })).toBeVisible();
  await expect(queueRows(column)).toHaveCount(1);
});

test('mobile previews and actions fit the column and full reading dialog stays usable', async ({ page }, info) => {
  const column = await openChat(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await enqueue(column, longText);
  const row = queueRows(column).first();
  // No hover: phone-width actions must already be opaque and inside the viewport.
  const edit = row.getByRole('button', { name: /^Edit queued message:/ });
  await expect(edit).toBeInViewport();
  await expect.poll(() => edit.evaluate(el => {
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  })).toBe(1);
  await noHorizontalOverflow(page.locator('html'));
  await noHorizontalOverflow(column);
  await noHorizontalOverflow(column.getByRole('group', { name: 'Composer trays', exact: true }));
  await screenshot(page, info, 'mobile-shelf-actions');
  await row.getByRole('button', { name: /^Read queued message:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Queued message', exact: true });
  await expect(dialog.locator('pre')).toHaveText(longText);
  await noHorizontalOverflow(dialog);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true }).first()).toBeInViewport();
  await screenshot(page, info, 'mobile-shelf-reading');
});

test('pending edits preserve text through enqueue failure and retry without unsafe actions', async ({ page }) => {
  const column = await openChat(page);
  await enqueue(column, 'Existing follow-up');
  // Hold one real bridge submission, then refuse it. The renderer owns the optimistic/error rows.
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    let intercept = true;
    window.ember.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (intercept && path.endsWith('/submit') && init?.method === 'POST') {
        intercept = false;
        await new Promise<void>(resolve => Object.assign(window, { refuseShelfSubmission: resolve }));
        return { ok: false, status: 503, data: { error: 'Kiln could not queue this message. Retry or cancel it.' } as T };
      }
      return original<T>(instance, path, init);
    };
  });
  await column.locator('textarea').fill('Pending text before edit');
  await column.locator('textarea').press('Enter');
  let pending = queueRows(column).filter({ hasText: 'Pending text before edit' });
  await expect(pending).toContainText('queueing');
  await expect(pending.getByRole('button', { name: /^Send queued message now:/ })).toHaveCount(0);
  await expect(pending.getByRole('button', { name: /^Move queued message/ })).toHaveCount(0);
  await expect(pending.getByRole('button', { name: /^Cancel queued message:/ })).toBeHidden();
  await expect(pending.getByRole('button', { name: /^More actions/ })).toHaveCount(0);
  await pending.getByRole('button', { name: /^Read queued message:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Queued message', exact: true }).getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await pending.getByRole('button', { name: /^Edit queued message:/ }).click();
  const editor = page.getByRole('dialog', { name: 'Edit queued message', exact: true });
  await expect(editor.getByRole('button', { name: 'Queued message model', exact: true })).toBeDisabled();
  await editor.getByRole('textbox', { name: 'Queued message text', exact: true }).fill('Retained pending edit');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  pending = queueRows(column).filter({ hasText: 'Retained pending edit' });
  await expect(pending).toContainText('queueing');
  await page.evaluate(() => (window as unknown as { refuseShelfSubmission: () => void }).refuseShelfSubmission());
  await expect(pending.getByRole('button', { name: /^Retry queueing/ })).toBeEnabled();
  await pending.hover();
  await expect(pending.locator('[data-tray-error]')).toBeVisible();
  await expect(pending.locator('[data-tray-error]')).toContainText(/queue|Kiln/i);
  await expect(column.getByRole('tab', { name: /^Queue/ })).toHaveAccessibleName(/needs your attention/);
  await pending.getByRole('button', { name: /^Retry queueing/ }).click();
  await expect(column.getByRole('button', { name: 'Cancel queued message: Retained pending edit', exact: true })).toBeEnabled();
  await expect(queueRows(column)).toHaveCount(2);
  await expect(column.locator('[data-tray-error]')).toHaveCount(0);
});

test('held steers remain withdrawable but cannot be edited, sent again, parked or merged', async ({ page }) => {
  const leader = await openChat(page, true);
  await leader.getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.getByTestId('thread-session-modal').locator('main[data-session-key="pi:hearth::17"]');
  await expect(worker).toBeVisible();
  const submitted = await page.evaluate(() => window.ember.piRequest!('pi:hearth', '/conversations/17/submit', {
    method: 'POST', body: { content: 'Hold this worker direction', whenBusy: 'steer' },
  }));
  expect(submitted.ok).toBe(true);
  const row = queueRows(worker).filter({ hasText: 'Hold this worker direction' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('status', { name: 'Waiting for the turn to pause', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: /^Edit queued|^Send queued|^More actions/ })).toHaveCount(0);
  await row.getByRole('button', { name: /^Withdraw the message waiting/ }).click();
  await expect(row).toHaveCount(0);
  await expect(worker.getByRole('tab', { name: /^Queue/ })).toHaveCount(0);
});
