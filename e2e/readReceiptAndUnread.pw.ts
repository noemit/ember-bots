/**
 * Browser evidence for the read receipt's lifetime and the reply context menu's "Mark as unread".
 *
 * Plain clicking an assistant reply already acknowledged it (`e2e/messageReadClick.pw.ts`). Two
 * things were wrong with the receipt, and one thing was missing:
 *
 *   - the receipt sat on screen for a flat 5s, reset whenever the pointer left, so it lingered in
 *     front of the transcript long after the reader moved on, and a keyboard user got no hold at all;
 *   - nothing could take an acknowledgement back from the reply side;
 *   - a reply's Copy and Reply lived only in a hover gutter.
 *
 * The timeline is the part worth pinning, and a real clock makes it untestable: every assertion here
 * runs against `page.clock`, so "gone at 5s" means exactly that rather than "gone whenever CI got
 * round to looking". `pauseAt` arms the clock, each `runFor` is the only thing that advances it, and
 * hovering/focusing are real pointer and keyboard events so the component's own handlers decide.
 *
 * The watermark rule for "Mark as unread" is a pure-function property (see `tests/readState.test.ts`).
 * What is checked here is that the menu, the settings write, the column's unread machinery and the
 * receipt all agree with it in the running app, in the fixture whose leader (`pi:hearth::16`) has
 * crew behind it and therefore the most to get wrong.
 */
import { expect, test, type Page } from '@playwright/test';

/** The mock keeps read state (and nothing else) in localStorage, so a reload behaves like a relaunch. */
const readMarks = (page: Page) => page.evaluate(() => window.ember.getSettings().then((s) => s.readMarks));

/** `pi:hearth::16`, the crew leader: two finished assistant replies (e91, e93) and a crew report. */
const openCrewLeader = async (page: Page) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  return page.locator('main[data-session-key="pi:hearth::16"]');
};

/**
 * Arms the page clock *before* the interaction being timed.
 *
 * `install` replaces `Date`/`setTimeout`, then `pauseAt` stops time a second past now so a receipt
 * that appears on the next frame is not already behind the paused instant. Nothing advances until a
 * `runFor`, which is what makes the assertions exact.
 */
const pauseClock = async (page: Page) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
};

/** The receipt's own element: the pill under the transcript, not any other `role="status"` line. */
const receipt = (column: ReturnType<Page['locator']>) => column.locator('[data-read-toast]');

/**
 * Advances the paused clock in 100ms steps until the receipt is gone, and reports how long it took.
 *
 * A plain loop rather than `expect.poll`: poll's retry interval is a *real* timer, so under a paused
 * page clock its attempts interleave unpredictably with the `runFor` calls that actually advance the
 * receipt's own timeout. Stepping the clock by hand is the deterministic version of the same check,
 * and the returned figure is the assertion's subject rather than an accident of scheduling.
 */
const runUntilReceiptGone = async (page: Page, pill: ReturnType<Page['locator']>, budgetMs = 6_000) => {
  for (let elapsed = 0; elapsed < budgetMs; elapsed += 100) {
    await page.clock.runFor(100);
    if ((await pill.count()) === 0) return elapsed + 100;
  }
  return budgetMs;
};

test.describe('the "Marked read" receipt', () => {
  test('a click shows it for about a second, and it is gone by 1100ms', async ({ page }, testInfo) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    await expect(reply.getByRole('button', { name: 'Mark this message as read' })).toBeVisible();
    await pauseClock(page);

    await reply.locator('p').click();
    // The click waits out a short selection grace, so it is acknowledged without a frame of waiting.
    await page.clock.runFor(400);
    const pill = receipt(column);
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Marked read');

    // Still there at 600ms — this is the "long enough to notice" half of the promise.
    await page.clock.runFor(200);
    await expect(pill).toBeVisible();
    await testInfo.attach('receipt-visible', { body: await column.screenshot(), contentType: 'image/png' });

    // ...and gone by 1100ms, without anything having touched it: 200ms were already spent above.
    expect(await runUntilReceiptGone(page, pill) + 200).toBeLessThanOrEqual(1_100);
    // The reply was acknowledged: its own dot is gone (the fixture's other unread reply keeps its).
    await expect(reply.locator('[data-unread-dot]')).toHaveCount(0);
    await expect(column.locator('[data-message-id="e91"] [data-unread-dot]')).toHaveCount(1);
  });

  test('hovering holds it to 5s from appearance, not 5s from the last hover', async ({ page }, testInfo) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e91"]');
    await pauseClock(page);

    await reply.locator('p').click();
    await page.clock.runFor(400);
    const pill = receipt(column);
    await expect(pill).toBeVisible();

    // Point at it: the deadline moves to the cap, measured from when it appeared.
    await pill.hover();
    await page.clock.runFor(1_600);
    await expect(pill).toBeVisible();
    await testInfo.attach('receipt-held', { body: await page.screenshot(), contentType: 'image/png' });

    // Past the plain second by now, and past a fresh second too — only the cap can still be running.
    await page.clock.runFor(2_900);
    await expect(pill).toBeVisible();

    // The cap is absolute: hovered or not, it goes at 5s — and not before.
    await expect(pill).toBeVisible();
    await page.clock.runFor(300);
    await expect(pill).toBeVisible();
    expect(await runUntilReceiptGone(page, pill)).toBeGreaterThan(0);
    await expect(pill).toHaveCount(0);
  });

  test('leaving before the cap dismisses it promptly', async ({ page }) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    await pauseClock(page);

    await reply.locator('p').click();
    await page.clock.runFor(400);
    const pill = receipt(column);
    await expect(pill).toBeVisible();
    await pill.hover();
    await page.clock.runFor(1_000);
    await expect(pill).toBeVisible();

    // Move off: the short grace runs, then it is gone — well before the 1s a fresh receipt would take.
    await column.locator('[aria-label="Conversation history"]').hover({ position: { x: 5, y: 5 } });
    await expect(pill).toBeVisible();
    await page.clock.runFor(300);
    await expect(pill).toHaveCount(0);
  });

  test('keyboard focus holds it exactly like hover, and leaving dismisses promptly', async ({ page }) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    await pauseClock(page);

    await reply.locator('p').click();
    await page.clock.runFor(400);
    const pill = receipt(column);
    const undo = pill.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();

    // Focus inside the receipt is the same hold: a keyboard user reaches Undo and it waits.
    await undo.focus();
    await page.clock.runFor(2_000);
    await expect(pill).toBeVisible();
    await expect(undo).toBeFocused();

    // Focusing away dismisses on the same short grace as a pointer leaving.
    await column.locator('[aria-label="Conversation history"]').focus();
    await expect(pill).toBeVisible();
    await page.clock.runFor(300);
    await expect(pill).toHaveCount(0);
  });

  test('reduced motion keeps the same timings: they are a timer, not a CSS delay', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    await pauseClock(page);

    await reply.locator('p').click();
    await page.clock.runFor(400);
    const pill = receipt(column);
    await expect(pill).toBeVisible();
    expect(await pill.evaluate((el) => getComputedStyle(el).animationName)).not.toContain('read');

    await page.clock.runFor(1_400);
    await expect(pill).toHaveCount(0);

    // And the hold behaves identically when motion is off.
    const second = column.locator('[data-message-id="e91"]');
    await second.locator('p').click();
    await page.clock.runFor(400);
    await expect(pill).toBeVisible();
    await pill.hover();
    await page.clock.runFor(2_000);
    await expect(pill).toBeVisible();
  });
});

test.describe('the reply context menu', () => {
  test('offers Mark as unread, Copy as Markdown and Reply on an assistant reply', async ({ page }, testInfo) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    await reply.locator('p').click({ button: 'right' });

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Mark as unread', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy as Markdown', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Reply', exact: true })).toBeVisible();
    await testInfo.attach('context-menu', { body: await page.screenshot(), contentType: 'image/png' });

    await page.screenshot({ path: '/home/em/.cache/ember-unread-inverse-results/shot-context-menu.png' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('Mark as unread rewinds the watermark, re-arms unread navigation and shows its own receipt', async ({ page }, testInfo) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');

    // Make sure the reply is *read* first: the inverse only means something from a read state.
    await column.getByRole('button', { name: 'Mark all as read', exact: true }).click();
    await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);
    const read = await readMarks(page);
    expect(read['pi:hearth::16'].through).toBeGreaterThanOrEqual(93);

    await pauseClock(page);
    await reply.locator('p').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
    await expect(menu).toHaveCount(0);

    // Watermark semantics: the target and everything after it are unread again, nothing before it.
    await expect.poll(async () => (await readMarks(page))['pi:hearth::16']?.through).toBe(92);
    const after = await readMarks(page);
    expect(after['pi:hearth::16'].ids ?? []).toEqual([]);

    // The column's own unread machinery agrees, and the reply's dot is back.
    await expect(column.locator('[data-unread-navigation]')).toBeVisible();
    await expect(reply.getByRole('button', { name: 'Mark this message as read' })).toBeVisible();

    const pill = receipt(column);
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Marked unread');
    await testInfo.attach('receipt-unread', { body: await page.screenshot(), contentType: 'image/png' });
    await page.screenshot({ path: '/home/em/.cache/ember-unread-inverse-results/shot-marked-unread.png' });

    // The same one-second lifetime, and no Undo: the reply's own dot is the way back.
    await expect(pill.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    expect(await runUntilReceiptGone(page, pill)).toBeLessThanOrEqual(1_200);
    await expect(pill).toHaveCount(0);
  });

  test('the watermark survives a reload, which is a relaunch to the mock', async ({ page }) => {
    const column = await openCrewLeader(page);
    await column.getByRole('button', { name: 'Mark all as read', exact: true }).click();
    await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);

    await column.locator('[data-message-id="e91"] p').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
    await expect.poll(async () => (await readMarks(page))['pi:hearth::16']?.through).toBe(90);

    await page.reload();
    const reopened = page.locator('main[data-session-key="pi:hearth::16"]');
    await expect(reopened.locator('[data-message-id="e91"]')).toBeVisible();
    await expect(reopened.getByRole('button', { name: /Go to the oldest unread reply/ })).toBeVisible();
    expect((await readMarks(page))['pi:hearth::16'].through).toBe(90);
  });
});

test.describe('where Mark as unread is withheld', () => {
  test('never on a user message', async ({ page }) => {
    const column = await openCrewLeader(page);
    const prompt = column.locator('[data-message-id="e90"]');
    await prompt.click({ button: 'right' });
    // A user bubble has no menu of its own, so nothing renders at all.
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('never while text inside the reply is selected', async ({ page }) => {
    const column = await openCrewLeader(page);
    const reply = column.locator('[data-message-id="e93"]');
    const prose = reply.locator('p');
    const bounds = await prose.boundingBox();
    if (!bounds) throw new Error('Reply prose is not laid out');

    // A real drag selection, the same gesture a person makes before choosing "copy".
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 120, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);

    // Copy and Reply are still on offer — the menu exists, it just does not move the read state.
    await prose.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy as Markdown', exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Mark as unread', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  });

  test('never inside a worker thread opened from the crew strip', async ({ page }, testInfo) => {
    const column = await openCrewLeader(page);
    await column.getByRole('button', { name: 'Parse config', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator('main[data-session-key="pi:hearth::17"]') });
    await expect(dialog).toBeVisible();
    const worker = dialog.locator('main[data-session-key="pi:hearth::17"]');
    // The worker's own transcript: it has an assistant reply, so the *only* reason there is no menu
    // is the rule under test.
    const reply = worker.locator('[data-message-id="e95"]');
    await expect(reply).toBeVisible();
    await reply.click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await reply.locator('p').first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await testInfo.attach('worker-no-menu', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
  });
});

test.describe('the menu\'s other two items still work', () => {
  test('Copy as Markdown puts the reply\'s Markdown on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const column = await openCrewLeader(page);
    await column.locator('[data-message-id="e93"] p').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Copy as Markdown', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Parse config is done');
  });

  test('Reply attaches the reply to the composer draft and focuses it', async ({ page }) => {
    const column = await openCrewLeader(page);
    await column.locator('[data-message-id="e93"] p').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Reply', exact: true }).click();
    const composer = column.locator('textarea');
    await expect(composer).toBeFocused();
    // The reply context chip is the composer's own affordance, reused rather than rebuilt.
    await expect(column.getByText(/Replying with context/i).first()).toBeVisible();
  });
});

test('the receipt and the menu in the dark theme', async ({ page }, testInfo) => {
  // The theme is a setting, not a class to poke by hand: the mock keeps it beside the read state, so
  // seeding that store and reloading is the same path a relaunch takes — and the screenshot is of
  // the app's real dark palette rather than of one class somebody added.
  await page.goto('/');
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('ember-pi-read-state');
    const stored = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem('ember-pi-read-state', JSON.stringify({ ...stored, theme: 'graphite' }));
  });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const reply = column.locator('[data-message-id="e93"]');

  // Mark it read, take it back, then acknowledge it again: the receipt needs something to report.
  await column.getByRole('button', { name: 'Mark all as read', exact: true }).click();
  await pauseClock(page);
  await reply.locator('p').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
  await expect(reply.getByRole('button', { name: 'Mark this message as read' })).toBeVisible();
  await reply.getByRole('button', { name: 'Mark this message as read' }).click();
  await page.clock.runFor(400);
  const pill = receipt(column);
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('Marked read');
  await testInfo.attach('receipt-dark', { body: await page.screenshot(), contentType: 'image/png' });
  await page.screenshot({ path: '/home/em/.cache/ember-unread-inverse-results/shot-receipt-dark.png' });

  // Let the receipt run out on the paused clock before opening the menu over it.
  await runUntilReceiptGone(page, pill);
  await expect(pill).toHaveCount(0);
  await reply.locator('p').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await testInfo.attach('menu-dark', { body: await page.screenshot(), contentType: 'image/png' });
  await page.screenshot({ path: '/home/em/.cache/ember-unread-inverse-results/shot-menu-dark.png' });
});
