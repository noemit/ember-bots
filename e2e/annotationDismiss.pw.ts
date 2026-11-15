import { expect, test, type Page } from '@playwright/test';

async function prepare(page: Page, query = '') {
  await page.goto('/' + query);
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('log')).toContainText('step counter shows');
  await column.getByRole('textbox', { name: 'Message your bot', exact: true }).fill('Keep the main draft');
  await column.locator('[data-message-id="e2"] strong').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  });
  const editor = column.getByRole('group', { name: 'Annotate selected text' });
  await editor.getByRole('textbox').fill('Keep the annotation and its exact quote');
  return { column, editor, decision: page.getByRole('dialog', { name: 'Save this annotation for later?' }) };
}

for (const destination of ['another chat', 'New bot', 'Usage', 'Scheduled', 'hide', 'minimize', 'keyboard palette']) {
  test(`Save/Discard protects annotation navigation to ${destination}`, async ({ page }, info) => {
    const { column, editor, decision } = await prepare(page);
    const marks = await page.evaluate(async () => (await window.ember.getSettings()).readMarks);
    const navigate = async () => {
      if (destination === 'another chat') await page.locator('aside').getByRole('button', { name: /Dataset shortlist/ }).click();
      else if (destination === 'hide') await column.getByRole('button', { name: 'Hide session', exact: true }).click();
      else if (destination === 'minimize') await column.getByRole('button', { name: 'Close this column', exact: true }).click();
      else if (destination === 'keyboard palette') await page.keyboard.press('Control+k');
      else await page.getByRole('button', { name: destination === 'New bot' ? /^New bot$/ : new RegExp('^' + destination + ' —') }).first().click();
    };
    await navigate();
    await expect(decision).toBeVisible();
    await expect(column).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(decision).toHaveCount(0);
    await expect(editor.getByRole('textbox')).toHaveValue('Keep the annotation and its exact quote');
    await navigate();
    await expect(decision).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('save-before-' + destination.replaceAll(' ', '-') + '.png') });
    await decision.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(decision).toHaveCount(0);
    await expect(editor).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).quoteLinks.length)).toBe(1);
    expect(await page.evaluate(async () => (await window.ember.getSettings()).readMarks)).toEqual(marks);
    const saved = await page.evaluate(() => window.ember.getSettings());
    expect(saved.quoteLinks[0].source.quote).toBe('3/2');
    const span = saved.quoteLinks[0].source.spans[0];
    expect(span).toMatchObject({ messageId: 'e2', partId: 'e2-1' });
    expect(span.text.slice(span.start, span.end)).toBe(span.quote);
    expect(saved.quoteLinks[0].destination.kind).toBe('note');
    expect(saved.composerDrafts['pi:hearth::10'].text).toBe('Keep the main draft');
    if (destination === 'another chat') await expect(page.locator('main[data-session-key="pi:hearth::13"]')).toBeVisible();
    if (destination === 'New bot') await expect(page.getByRole('radiogroup', { name: 'Standing instructions' })).toBeVisible();
  });
}

test('Discard is explicit, saves nothing and does not leave a resumable editor', async ({ page }) => {
  const { column, editor, decision } = await prepare(page);
  await editor.getByRole('textbox').press('Escape');
  await decision.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Resume annotation/ })).toHaveCount(0);
  expect((await page.evaluate(() => window.ember.getSettings())).quoteLinks).toEqual([]);
  await expect(column.getByRole('textbox', { name: 'Message your bot', exact: true })).toHaveValue('Keep the main draft');
});

test('a failed Save stays visible and retryable without navigating or duplicating the note', async ({ page }) => {
  const { decision } = await prepare(page, '?failQuoteSaveOnce');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await decision.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(decision.getByRole('alert')).toContainText(/Ember.*text is still here.*Save again/);
  await expect(page.locator('[data-annotation-composer] textarea')).toHaveValue('Keep the annotation and its exact quote');
  await decision.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Standing instructions' })).toBeVisible();
  const settings = await page.evaluate(() => window.ember.getSettings());
  expect(settings.quoteLinks).toHaveLength(1);
  expect(settings.sessionNotes['pi:hearth::10']).toHaveLength(1);
});

test('navigation waits for an already-running note save instead of losing the text or saving twice', async ({ page }) => {
  const { editor } = await prepare(page);
  await page.evaluate(() => {
    const original = window.ember.setSettings;
    let held = false;
    window.ember.setSettings = async patch => {
      if (!held && patch.quoteLinks?.length) {
        held = true;
        await new Promise<void>(resolve => window.addEventListener('release-note-save', () => resolve(), { once: true }));
      }
      return original(patch);
    };
  });
  await editor.getByRole('button', { name: 'Save annotation with quote as a note' }).click();
  await expect(editor.getByRole('textbox')).toBeDisabled();
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(page.getByRole('radiogroup', { name: 'Standing instructions' })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('release-note-save')));
  await expect(page.getByRole('radiogroup', { name: 'Standing instructions' })).toBeVisible();
  const saved = await page.evaluate(() => window.ember.getSettings());
  expect(saved.quoteLinks).toHaveLength(1);
  expect(saved.sessionNotes['pi:hearth::10']).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: 'Save this annotation for later?' })).toHaveCount(0);
});
