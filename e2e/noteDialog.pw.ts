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
const chooseModel = async (page: Page, label: string) => {
  await dialogFor(page).getByRole('button', { name: 'Model this note sends with', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model', exact: true });
  await expect(picker).toBeVisible();
  // Rows live under collapsed provider headers; open the one this model's provider owns.
  await picker.getByRole('button', { name: /^faux-hearth 2$/ }).click();
  await picker.getByRole('button', { name: label, exact: true }).first().click();
  // Picking a row inspects it; Done applies it, exactly as the composer's picker does.
  await expect(picker.getByRole('heading', { name: label, exact: true })).toBeVisible();
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
