import { expect, test } from '@playwright/test';

test('rejected selection cannot create an empty-quote Resume draft', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('log')).toContainText('step counter shows');
  await page.waitForTimeout(600);
  await column.getByRole('textbox', { name: 'Message your bot', exact: true }).fill('Keep composer');
  await page.evaluate(() => {
    const parts = document.querySelectorAll('main[data-session-key="pi:hearth::10"] [data-quote-part-id]');
    const range = document.createRange(); range.setStartBefore(parts[0]); range.setEndAfter(parts[parts.length - 1]);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  });
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('textbox')).toBeDisabled();
  await bar.getByRole('button', { name: 'Close annotation editor' }).click();
  await expect(column.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
  await expect(column.getByRole('textbox', { name: 'Message your bot', exact: true })).toHaveValue('Keep composer');
});

test('valid draft hides, survives session switching, and explicit discard leaves the composer alone', async ({ page }) => {
  await page.goto('/');
  const rail = page.locator('aside');
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('log')).toContainText('step counter shows');
  await page.waitForTimeout(600);
  const main = column.getByRole('textbox', { name: 'Message your bot', exact: true });
  await main.fill('Keep composer');
  await column.locator('[data-message-id="e2"] strong').dblclick();
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Keep annotation');
  await main.click();
  await expect(column.getByRole('button', { name: /Resume annotation/ })).toBeVisible();
  await rail.getByRole('button', { name: /Dataset shortlist/ }).click();
  await expect(page.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
  await column.getByRole('button', { name: /Resume annotation/ }).click();
  await expect(bar.getByRole('textbox')).toHaveValue('Keep annotation');
  await bar.getByRole('button', { name: 'Discard annotation draft' }).click();
  await expect(bar).toHaveCount(0);
  await expect(column.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
  await expect(main).toHaveValue('Keep composer');
  await page.reload();
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(column.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
});

test('missing source retains editable text with recovery rather than a misleading Resume', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { rememberAnnotationDraft } = await import('/src/lib/annotationDraftMemory.ts');
    rememberAnnotationDraft('pi:hearth::10', { text: 'Recover my unsent thought', requestId: null, source: { sessionKey: 'pi:hearth::10', quote: 'old source', spans: [{ messageId: 'missing', partId: 'missing', start: 0, end: 10, quote: 'old source', text: 'old source' }] } });
  });
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
  await column.getByRole('button', { name: /Review annotation draft/ }).click();
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await expect(bar.getByRole('textbox')).toHaveValue('Recover my unsent thought');
  await expect(bar).toContainText(/Ember.*Copy.*discard.*select/);
  await bar.getByRole('textbox').fill('Editable recovery');
  await expect(bar.getByRole('button', { name: /Send annotation with quote/ })).toBeDisabled();
  await bar.getByRole('button', { name: 'Discard annotation draft' }).click();
  await expect(column.getByRole('button', { name: /Review annotation draft|Resume annotation/ })).toHaveCount(0);
});

for (const action of ['Note', 'Send']) {
  test('delayed ' + action + ' completion leaves a same-text draft in another session intact', async ({ page }) => {
    await page.goto('/');
    const rail = page.locator('aside');
    await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
    const origin = page.locator('main[data-session-key="pi:hearth::10"]');
    await expect(origin.getByRole('log')).toContainText('step counter shows');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const original = window.ember.setSettings;
      let held = false;
      window.ember.setSettings = async patch => {
        const result = await original(patch);
        if (!held && patch.quoteLinks?.length) {
          held = true;
          await new Promise<void>(resolve => { (window as unknown as { releaseAnnotation: () => void }).releaseAnnotation = resolve; });
        }
        return result;
      };
    });
    await origin.locator('[data-message-id="e2"] strong').dblclick();
    const oldBar = origin.getByRole('group', { name: 'Annotate selected text' });
    await oldBar.getByRole('textbox').fill('Same annotation text');
    await oldBar.getByRole('button', { name: action === 'Note' ? 'Save annotation with quote as a note' : 'Send annotation with quote' }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAnnotation?: () => void }).releaseAnnotation)).toBe('function');
    await rail.getByRole('button', { name: /Dataset shortlist/ }).click();
    const next = page.locator('main[data-session-key="pi:hearth::13"]');
    await expect(next.getByRole('log')).toContainText('Shortlist research datasets.');
    await page.waitForTimeout(400);
    await next.locator('[data-message-id="e9"] [data-quote-part-id]').click({ position: { x: 20, y: 8 }, clickCount: 2 });
    const newBar = next.getByRole('group', { name: 'Annotate selected text' });
    await newBar.getByRole('textbox').fill('Same annotation text');
    await page.evaluate(() => (window as unknown as { releaseAnnotation: () => void }).releaseAnnotation());
    await page.waitForTimeout(500);
    await expect(newBar.getByRole('textbox')).toHaveValue('Same annotation text');
    await newBar.getByRole('button', { name: 'Close annotation editor' }).click();
    await expect(next.getByRole('button', { name: /Resume annotation/ })).toBeVisible();
    await rail.getByRole('button', { name: /Habit onboarding QA/ }).click();
    await expect(origin.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
    await rail.getByRole('button', { name: /Dataset shortlist/ }).click();
    await next.getByRole('button', { name: /Resume annotation/ }).click();
    await expect(newBar.getByRole('textbox')).toHaveValue('Same annotation text');
  });
}

test('composer-style annotation icons have accessible touch targets; close and Escape retain a valid draft', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('log')).toContainText('step counter shows');
  await page.waitForTimeout(600);
  await column.locator('[data-message-id="e2"] strong').dblclick();
  const bar = column.getByRole('group', { name: 'Annotate selected text' });
  await bar.getByRole('textbox').fill('Preserve on close');
  const send = bar.getByRole('button', { name: 'Send annotation with quote' });
  const note = bar.getByRole('button', { name: 'Save annotation with quote as a note' });
  const close = bar.getByRole('button', { name: 'Close annotation editor' });
  await expect(send.locator('svg.lucide-arrow-up')).toHaveCount(1);
  await expect(note.locator('svg.lucide-notebook-pen')).toHaveCount(1);
  await expect(close.locator('svg.lucide-x')).toHaveCount(1);
  await expect(send).toHaveAttribute('data-variant', 'default');
  await expect(note).toHaveAttribute('data-variant', 'ghost');
  for (const button of [send, note, close]) {
    await expect(button).toHaveAttribute('title', /annotation/);
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await button.innerText()).toBe('');
  }
  await expect(bar.getByRole('button', { name: /Hide/ })).toHaveCount(0);
  await close.click();
  await column.getByRole('button', { name: /Resume annotation/ }).click();
  await expect(bar.getByRole('textbox')).toHaveValue('Preserve on close');
  await bar.getByRole('textbox').press('Escape');
  await expect(bar).toHaveCount(0);
  await column.getByRole('button', { name: /Resume annotation/ }).click();
  await expect(bar.getByRole('textbox')).toHaveValue('Preserve on close');
});

for (const theme of ['stone', 'graphite']) {
  test('floating annotation keeps opaque controls over its translucent surface: ' + theme, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('ember-pi-read-state', JSON.stringify({ theme: value })), theme);
    await page.goto('/');
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
    const column = page.locator('main[data-session-key="pi:hearth::10"]');
    await expect(column.getByRole('log')).toContainText('step counter shows');
    await page.waitForTimeout(600);
    await column.locator('[data-message-id="e2"] p').click({ position: { x: 80, y: 8 }, clickCount: 3 });
    const bar = column.getByRole('group', { name: 'Annotate selected text' });
    await bar.getByRole('textbox').fill('The final step should read 2/2. Keep the draft while checking the arithmetic.');
    const style = await bar.evaluate(element => ({ opacity: getComputedStyle(element).opacity, background: getComputedStyle(element).backgroundColor, blur: getComputedStyle(element).backdropFilter }));
    expect(style.opacity).toBe('1');
    expect(style.background).toMatch(/(?:0\.4|40%)/);
    expect(style.blur).toContain('blur');
    for (const control of await bar.locator('textarea, button').all()) await expect.poll(() => control.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await page.screenshot({ path: test.info().outputPath('annotation-' + theme + '.png') });
  });
}
