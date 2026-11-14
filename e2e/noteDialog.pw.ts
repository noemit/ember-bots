import type {} from '../src/types';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * The "For later" note and its dialog.
 *
 * A note is a parked thought: read later, and — since this dialog — reworded and given a model of
 * its own. What it is sent with matters, so the assertions read the outgoing wire rather than only
 * the transcript's own copy of it.
 */

const openChat = async (page: Page) => {
  await page.goto('/?noDock');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.locator('textarea')).toBeEnabled();
  return column;
};

const note = async (column: Locator, text: string) => {
  await column.locator('textarea').fill(text);
  await column.getByRole('button', { name: 'Save as note', exact: true }).click();
  await expect(column.getByRole('button', { name: 'Read note: ' + text.slice(0, 60), exact: true })).toBeVisible();
};

const dialogFor = (page: Page) => page.getByRole('dialog', { name: 'Note for later', exact: true });

/** Open the note's model picker and pick a catalogue entry by its visible name. */
const chooseModel = async (page: Page, label: string, effort?: string) => {
  await dialogFor(page).getByRole('button', { name: 'Model this note sends with', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
  await expect(picker).toBeVisible();
  // Rows live under collapsed provider headers; open the one this model's provider owns.
  await picker.getByRole('button', { name: /^faux-hearth 2$/ }).click();
  await picker.getByRole('button', { name: label, exact: true }).first().click();
  // Picking a row inspects it; Done applies it, exactly as the composer's picker does.
  await expect(picker.getByRole('heading', { name: label, exact: true })).toBeVisible();
  if (effort) {
    await picker.getByRole('combobox', { name: 'Reasoning level' }).click();
    await page.getByRole('option', { name: effort, exact: true }).click();
  }
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(picker).toHaveCount(0);
};

/**
 * Every send the renderer made, with the model it named.
 *
 * A pi send states its model with a `/configure` call just before the `/submit` (see
 * `piConfigureForSend`): that pair is "the send config", the same thing the queue tests assert.
 */
const captureSends = (page: Page) =>
  page.evaluate(() => {
    const bridge = window.ember as unknown as {
      piRequest: (instance: string, path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
    };
    const w = window as unknown as { __sends?: Array<{ model?: unknown; thinkingLevel?: unknown; submitted: boolean }> };
    if (w.__sends) return;
    w.__sends = [];
    const original = bridge.piRequest.bind(window.ember);
    bridge.piRequest = async (instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST' && path.endsWith('/configure')) {
        const body = init.body as { model?: unknown; thinkingLevel?: unknown } | undefined;
        w.__sends!.push({ model: body?.model, thinkingLevel: body?.thinkingLevel, submitted: false });
      }
      if (init?.method === 'POST' && path.endsWith('/submit')) {
        const body = init.body as { type?: string } | undefined;
        if (body?.type === 'input') w.__sends!.push({ submitted: true });
      }
      return original(instance, path, init);
    };
  });

const sends = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __sends?: Array<{ model?: unknown; thinkingLevel?: unknown; submitted: boolean }> }).__sends ?? [])
      // Only the pairs that actually ended in a submitted message.
      .filter((entry) => entry.submitted || entry.model !== undefined || entry.thinkingLevel !== undefined));

const screenshot = async (page: Page, info: TestInfo, name: string) => {
  const path = info.outputPath(name + '.png');
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
};

test('the note dialog no longer promises nothing changes, and the queue dialog dropped it too', async ({ page }, info) => {
  const column = await openChat(page);
  await note(column, 'A note that can be edited now');
  await column.getByRole('button', { name: /^Read note:/ }).click();
  const dialog = dialogFor(page);
  await expect(dialog).toBeVisible();
  // Gone from both trays: the sentence described a read-only view that no longer exists.
  await expect(dialog.getByText('Nothing here changes what will be sent.')).toHaveCount(0);
  await expect(dialog.getByText('Nothing is sent until you ask')).toHaveCount(0);
  // The dialog is still named by its title, and it is an editor.
  await expect(dialog.getByRole('heading', { name: 'Note for later', exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('A note that can be edited now');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await screenshot(page, info, 'note-dialog-light');

  // A real theme switch: the stored value is inert until the theme is re-applied, and the point of
  // the second screenshot is the dialog on the dark surface.
  await page.evaluate(() => window.ember.setSettings({ theme: 'graphite' }));
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { ember?: unknown }).ember));
  const reopened = await openChat(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await reopened.getByRole('button', { name: /^Read note:/ }).click();
  await expect(dialogFor(page)).toBeVisible();
  await screenshot(page, info, 'note-dialog-dark');
});

test('an edited note keeps its new text and model across a reload', async ({ page }) => {
  const column = await openChat(page);
  await note(column, 'Original wording');
  await column.getByRole('button', { name: /^Read note:/ }).click();
  const dialog = dialogFor(page);
  const text = dialog.getByRole('textbox', { name: 'Note', exact: true });
  await text.fill('Rewritten wording');

  // Give the note its own model, chosen from the instance's catalogue.
  await chooseModel(page, 'DeepSeek V4.1 Flash');
  await expect(dialog.getByRole('button', { name: 'Model this note sends with', exact: true })).toContainText('DeepSeek');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).sessionNotes['pi:hearth::10']))
    .toEqual([{ id: expect.any(String), text: 'Rewritten wording', modelId: 'faux-hearth/deepseek-v4.1-flash', variant: 'off' }]);

  await page.reload();
  // `window.ember` exists only once the renderer has loaded; ask before touching it.
  await page.waitForFunction(() => Boolean((window as unknown as { ember?: unknown }).ember));
  const reopened = await openChat(page);
  await expect(reopened.getByRole('button', { name: 'Read note: Rewritten wording', exact: true })).toBeVisible();
  await reopened.getByRole('button', { name: 'Read note: Rewritten wording', exact: true }).click();
  await expect(dialogFor(page).getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('Rewritten wording');
  await expect(dialogFor(page).getByRole('button', { name: 'Model this note sends with', exact: true })).toContainText('DeepSeek');
});

test('Cancel discards the edit and the stored note is untouched', async ({ page }) => {
  const column = await openChat(page);
  await note(column, 'Keep me exactly as I am');
  const before = await page.evaluate(async () => (await window.ember.getSettings()).sessionNotes['pi:hearth::10']);
  await column.getByRole('button', { name: /^Read note:/ }).click();
  const dialog = dialogFor(page);
  await dialog.getByRole('textbox', { name: 'Note', exact: true }).fill('This edit must not survive');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.ember.getSettings()).sessionNotes['pi:hearth::10'])).toEqual(before);
  // Reopening shows the stored text, not the discarded draft.
  await column.getByRole('button', { name: 'Read note: Keep me exactly as I am', exact: true }).click();
  await expect(dialogFor(page).getByRole('textbox', { name: 'Note', exact: true })).toHaveValue('Keep me exactly as I am');
  await page.keyboard.press('Escape');
  await expect(dialogFor(page).getByRole('textbox', { name: 'Note', exact: true })).toHaveCount(0);
});

test('a note with its own model sends with it; one without sends with the composer’s', async ({ page }) => {
  const column = await openChat(page);
  await captureSends(page);

  // A note carrying DeepSeek, while the composer is on the mock's default.
  await note(column, 'Send with the note model');
  await column.getByRole('button', { name: /^Read note:/ }).click();
  await chooseModel(page, 'DeepSeek V4.1 Flash');
  await dialogFor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialogFor(page)).toHaveCount(0);
  await column.getByRole('button', { name: 'Send note: Send with the note model', exact: true }).click();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Send with the note model');
  await expect.poll(async () => (await sends(page)).length).toBeGreaterThan(0);
  expect((await sends(page)).filter((entry) => entry.model !== undefined).at(-1)?.model).toEqual({
    provider: 'faux-hearth',
    modelId: 'deepseek-v4.1-flash',
  });

  // A plain note takes whatever the composer is set to at send time.
  await note(column, 'Send with the composer model');
  await column.getByRole('button', { name: 'Send note: Send with the composer model', exact: true }).click();
  await expect.poll(async () => (await sends(page)).filter((entry) => entry.submitted).length).toBe(2);
  // Two sends, each stating the model it meant: the note's own first, then the composer's.
  const named = (await sends(page)).filter((entry) => entry.model !== undefined);
  expect(named.map((entry) => entry.model)).toEqual([
    { provider: 'faux-hearth', modelId: 'deepseek-v4.1-flash' },
    { provider: 'faux-hearth', modelId: 'glm-5.3-flash' },
  ]);
  await expect(column.locator('textarea')).toHaveValue('');
});

test('Send it now submits the edited dialog snapshot, not the saved note or composer draft', async ({ page }) => {
  const column = await openChat(page);
  await captureSends(page);
  await page.evaluate(() => {
    const original = window.ember.piRequest.bind(window.ember);
    (window as unknown as { __inputs: unknown[] }).__inputs = [];
    window.ember.piRequest = async (instance, path, init) => {
      if (path.endsWith('/submit')) (window as unknown as { __inputs: unknown[] }).__inputs.push(init?.body);
      return original(instance, path, init);
    };
  });
  await note(column, 'Old note text');
  await column.locator('textarea').fill('Unsent composer draft');
  await column.getByRole('button', { name: 'Read note: Old note text', exact: true }).click();
  await dialogFor(page).getByRole('textbox', { name: 'Note', exact: true }).fill('  Current edited note  ');
  await chooseModel(page, 'DeepSeek V4.1 Flash');
  await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inputs: unknown[] }).__inputs)).toEqual([
    expect.objectContaining({ type: 'input', content: 'Current edited note', whenBusy: 'followUp' }),
  ]);
  expect((await sends(page)).filter((entry) => entry.model !== undefined).at(-1)).toMatchObject({
    model: { provider: 'faux-hearth', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'off',
  });
  await expect(column.locator('textarea')).toHaveValue('Unsent composer draft');
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).sessionNotes['pi:hearth::10'] ?? [])).toEqual([]);
});


/** Capture actual mock-host submissions, optionally refusing the first one. No provider is called. */
const captureInputs = (page: Page, failFirst = false) => page.evaluate((fail) => {
  const original = window.ember.piRequest.bind(window.ember);
  const state = { inputs: [] as unknown[], fail };
  (window as unknown as { __noteWire: typeof state }).__noteWire = state;
  window.ember.piRequest = async (instance, path, init) => {
    if (path.endsWith('/submit')) {
      state.inputs.push(init?.body);
      if (state.fail) { state.fail = false; return { ok: false, status: 503, data: { error: 'Mock host refused this send. Try again.' } }; }
    }
    return original(instance, path, init);
  };
}, failFirst);
const inputs = (page: Page) => page.evaluate(() => (window as unknown as { __noteWire: { inputs: unknown[] } }).__noteWire.inputs);

for (const queued of [false, true]) {
  test(`edited note retains its snapshot through save and send failures, then retries ${queued ? 'into the busy queue' : 'immediately'}`, async ({ page }) => {
    const column = await openChat(page);
    await note(column, 'Retry old text');
    await note(column, 'Leave this other note alone');
    if (queued) {
      await page.evaluate(() => window.ember.piRequest('hearth', '/conversations/10/submit', {
        method: 'POST', body: { type: 'input', content: 'slow mock run', whenBusy: 'followUp' },
      }));
      await expect(column.getByRole('button', { name: /^Queue message/ })).toBeVisible();
    }
    await column.locator('textarea').fill('Independent draft');
    await captureSends(page);
    await captureInputs(page, true);
    await page.evaluate(() => {
      const original = window.ember.setSettings.bind(window.ember);
      let failed = false;
      window.ember.setSettings = async (patch) => {
        if (!failed && patch.sessionNotes?.['pi:hearth::10']?.some((entry) => entry.text === 'Edited retry text')) {
          failed = true;
          throw new Error('Ember could not save this note. Try saving again.');
        }
        return original(patch);
      };
    });
    await column.getByRole('button', { name: 'Read note: Retry old text', exact: true }).click();
    await dialogFor(page).getByRole('textbox', { name: 'Note', exact: true }).fill('Edited retry text');
    await chooseModel(page, 'DeepSeek V4.1 Flash');
    await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
    // The existing send contract retains failures in delivery UI (bubble or queue), not the tray.
    if (queued) await column.getByRole('button', { name: 'Retry queueing this message: Edited retry text', exact: true }).click();
    else {
      const failed = column.getByRole('article').filter({ hasText: 'Edited retry text' });
      await expect(failed).toContainText('Not sent');
      await failed.getByRole('button', { name: 'Send again', exact: true }).click();
    }
    await expect.poll(async () => (await inputs(page)).length).toBe(2);
    expect(await inputs(page)).toEqual([0, 1].map(() => expect.objectContaining({ content: 'Edited retry text', whenBusy: 'followUp' })));
    await expect(column.getByRole('button', { name: 'Read note: Edited retry text', exact: true })).toHaveCount(0);
    if (queued) await column.getByRole('tab', { name: /^For later/ }).click();
    await expect(column.getByRole('button', { name: 'Read note: Leave this other note alone', exact: true })).toBeVisible();
    await expect(column.locator('textarea')).toHaveValue('Independent draft');
    expect((await sends(page)).filter((entry) => entry.model !== undefined)).toEqual([0, 1].map(() => expect.objectContaining({
      model: { provider: 'faux-hearth', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'off',
    })));

  });
}

test('an edited linked note sends its current text and preserves its quoted source', async ({ page }) => {
  const column = await openChat(page);
  // Native selection drives the production annotation capture and settings link creation.
  await column.locator('[data-quote-part-id]').first().evaluate((part) => {
    const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode()!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(12, node.textContent!.length));
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const annotation = column.getByRole('group', { name: 'Annotate selected text' });
  await annotation.getByRole('textbox').fill('Original linked note');
  await annotation.getByRole('button', { name: 'Save annotation with quote as a note' }).click();
  await expect(column.getByRole('button', { name: /^Read note:.*Original linked note/ })).toBeVisible();
  const before = await page.evaluate(async () => (await window.ember.getSettings()).quoteLinks);
  const link = before.find((entry) => entry.destination.kind === 'note')!;
  expect(link).toBeTruthy();
  await captureInputs(page);
  await captureSends(page);
  await column.getByRole('button', { name: /^Read note:.*Original linked note/ }).click();
  await dialogFor(page).getByRole('textbox', { name: 'Note', exact: true }).fill('Re: “' + link.source.quote + '”\n\nEdited linked note');
  await chooseModel(page, 'DeepSeek V4.1 Flash');
  await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect.poll(() => inputs(page)).toEqual([expect.objectContaining({ content: 'Re: “' + link.source.quote + '”\n\nEdited linked note' })]);
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).quoteLinks))
    .toEqual(expect.arrayContaining([expect.objectContaining({ source: link.source, destination: expect.objectContaining({ kind: 'message' }) })]));
  expect((await sends(page)).find((entry) => entry.model !== undefined)).toMatchObject({ model: { modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'off' });
});


test('edited note sends its explicit effort without changing the composer', async ({ page }) => {
  const column = await openChat(page);
  await note(column, 'Effort note');
  await captureSends(page);
  await column.getByRole('button', { name: 'Read note: Effort note', exact: true }).click();
  await chooseModel(page, 'DeepSeek V4.1 Flash', 'high');
  await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect.poll(async () => (await sends(page)).filter((entry) => entry.submitted).length).toBe(1);
  expect((await sends(page)).find((entry) => entry.model !== undefined)).toMatchObject({ thinkingLevel: 'high' });
  await expect(column.getByRole('button', { name: 'Choose model', exact: true })).toContainText('GLM');
});

test('unavailable edited note keeps its edits and never falls back to the composer', async ({ page }) => {
  await openChat(page);
  await page.evaluate(() => window.ember.setSettings({ sessionNotes: { 'pi:hearth::10': [{ id: 'missing-model-note', text: 'Unavailable note', modelId: 'missing/model', variant: 'off' }] } }));
  await page.reload();
  const column = await openChat(page);
  await captureInputs(page);
  await column.getByRole('button', { name: 'Read note: Unavailable note', exact: true }).click();
  await dialogFor(page).getByRole('textbox', { name: 'Note', exact: true }).fill('   ');
  await expect(dialogFor(page).getByRole('button', { name: 'Send it now', exact: true })).toBeDisabled();
  await dialogFor(page).getByRole('textbox', { name: 'Note', exact: true }).fill('Keep my unavailable edits');
  await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect(column.getByRole('button', { name: 'Read note: Keep my unavailable edits', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).sessionNotes['pi:hearth::10']))
    .toEqual([{ id: 'missing-model-note', text: 'Keep my unavailable edits', modelId: 'missing/model', variant: 'off' }]);
  expect(await inputs(page)).toEqual([]);
});


test('Use the composer’s model clears a saved note choice before immediate dispatch', async ({ page }) => {
  const column = await openChat(page);
  await note(column, 'Switch back to composer');
  await column.getByRole('button', { name: 'Read note: Switch back to composer', exact: true }).click();
  await chooseModel(page, 'DeepSeek V4.1 Flash', 'high');
  await dialogFor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await column.getByRole('button', { name: 'Read note: Switch back to composer', exact: true }).click();
  await captureSends(page);
  await dialogFor(page).getByRole('button', { name: "Use the composer's model", exact: true }).click();
  await dialogFor(page).getByRole('button', { name: 'Send it now', exact: true }).click();
  await expect.poll(async () => (await sends(page)).filter((entry) => entry.submitted).length).toBe(1);
  expect((await sends(page)).find((entry) => entry.model !== undefined)).toMatchObject({
    model: { provider: 'faux-hearth', modelId: 'glm-5.3-flash' }, thinkingLevel: 'off',
  });
});
