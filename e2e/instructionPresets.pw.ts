import { expect, test } from '@playwright/test';
import retired from '../tests/fixtures/retiredInstructionTexts.json';

const names = ['Pi Classic', 'Ultra Delegator', 'Custom (type your own)'];
test('draft picker and editor offer exactly three choices and preserve custom text', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  const picker = page.getByRole('radiogroup', { name: 'Standing instructions' });
  await expect(picker.getByRole('radio')).toHaveCount(3);
  for (const name of names) await expect(picker.getByRole('radio', { name, exact: false })).toBeVisible();
  await expect(picker.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('draft-picker.png') });
  await picker.getByRole('radio', { name: /Custom/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Standing instructions' });
  for (const name of names) await expect(dialog.getByRole('button', { name, exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Reviewer|Researcher/ })).toHaveCount(0);
  const text = dialog.getByRole('textbox', { name: 'Standing instructions text' });
  await dialog.getByRole('button', { name: names[1], exact: false }).click();
  await expect(text).toContainText('Worker model configuration');
  await expect(dialog.getByRole('button', { name: 'Harder tasks', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Easier tasks', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: names[2], exact: true }).click();
  await expect(text).toBeFocused();
  await text.fill('My custom instructions');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('instructions-editor.png') });
  await dialog.getByRole('button', { name: 'Use these' }).click();
  await expect(picker.getByRole('radio', { name: /Custom/ })).toHaveAttribute('aria-checked', 'true');
  await expect(picker.getByRole('radio').first()).toHaveAttribute('aria-checked', 'false');
  await picker.getByRole('radio', { name: /Custom/ }).click();
  await expect(text).toHaveValue('My custom instructions');
  await dialog.getByRole('button', { name: names[0], exact: false }).click();
  await expect(text).toHaveValue('');
});

for (const { id, instructions } of [...retired, { id: 'arbitrary', instructions: '  Keep my exact words\n' }]) {
  test(`existing ${id} instructions survive opening and saving the editor`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
    await page.evaluate((instructions) => {
      const original = window.ember.piRequest!;
      window.ember.piRequest = async (instance, path, init) => {
        const response = await original(instance, path, init);
        if (path.includes('/entries?') && path.includes('docs=1')) {
          const data = response.data as { docs?: Record<string, unknown> };
          data.docs = { ...data.docs, 'pi.agent': { instructions } };
        }
        if (path.endsWith('/configure') && init?.method === 'POST') {
          (window as unknown as { savedInstructions: unknown }).savedInstructions = init?.body;
        }
        return response;
      };
    }, instructions);
    const column = page.locator('main[data-session-key="pi:hearth::10"]');
    await column.getByRole('button', { name: 'View options' }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Standing instructions' });
    await expect(dialog.getByRole('textbox')).toHaveValue(instructions);
    await dialog.getByRole('button', { name: names[2], exact: true }).click();
    await expect(dialog.getByRole('textbox')).toHaveValue(instructions);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { savedInstructions: unknown }).savedInstructions)).toEqual({ instructions });
  });
}

test('Ultra choices seed from the composer, remember independent roles, and inject them on create', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Ultra Delegator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('GLM-5.3 Flash');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('GLM-5.3 Flash');
  await page.getByRole('button', { name: 'Harder tasks', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('DeepSeek');
  await picker.getByRole('button', { name: 'DeepSeek V4.1 Flash', exact: true }).click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('DeepSeek');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('GLM');
  await expect.poll(() => page.evaluate(async () => (await window.ember.getSettings()).delegatorModels?.['pi:hearth'])).toEqual({
    harder: { providerID: 'faux-hearth', modelID: 'deepseek-v4.1-flash' }, easier: { providerID: 'faux-hearth', modelID: 'glm-5.3-flash' },
  });
  await page.screenshot({ animations: 'disabled', path: info.outputPath('ultra-draft-models.png') });
  await page.reload();
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Ultra Delegator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('DeepSeek');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('GLM');
  await page.getByRole('radio', { name: /Custom/ }).click();
  const editor = page.getByRole('dialog', { name: 'Standing instructions' });
  await expect(editor.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('DeepSeek');
  await expect(editor.getByRole('textbox')).toContainText('Harder tasks: faux-hearth/deepseek-v4.1-flash');
  await expect(editor.getByRole('textbox')).toContainText('Easier tasks: faux-hearth/glm-5.3-flash');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('ultra-editor-models.png') });
  await editor.getByRole('button', { name: 'Use these' }).click();
  await expect(page.getByRole('radio', { name: 'Ultra Delegator', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => {
    const original = window.ember.piRequest!;
    window.ember.piRequest = async (instance, path, init) => {
      if (path === '/conversations' && init?.method === 'POST') (window as unknown as { createdInstructions: unknown }).createdInstructions = init.body;
      return original(instance, path, init);
    };
  });
  await page.locator('main textarea').fill('Test configured delegation');
  await page.locator('main textarea').press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { createdInstructions: { instructions?: string } }).createdInstructions?.instructions)).toContain('Harder tasks: faux-hearth/deepseek-v4.1-flash');
});

test('unavailable remembered choices stay visible and block creation until replaced', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('ember-pi-read-state', JSON.stringify({ delegatorModels: {
    'pi:hearth': { harder: { providerID: 'retired', modelID: 'missing' }, easier: { providerID: 'faux-hearth', modelID: 'glm-5.3-flash' } },
  } })));
  await page.goto('/');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Ultra Delegator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('retired/missing (unavailable)');
  await expect(page.getByRole('alert')).toContainText('Refresh models or choose another model');
  await page.locator('main textarea').fill('Do not fall back');
  await page.locator('main textarea').press('Enter');
  await expect(page.getByRole('radiogroup', { name: 'Standing instructions' })).toBeVisible();
  await expect(page.locator('main textarea')).toHaveValue('Do not fall back');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('unavailable-model.png') });
  await page.getByRole('button', { name: 'Harder tasks', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('GLM');
  await picker.getByRole('button', { name: 'GLM-5.3 Flash', exact: true }).first().click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Pi Classic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toHaveCount(0);
});

test('changing instances restores that host’s independent worker choices', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ember-pi-read-state', JSON.stringify({ delegatorModels: {
    'pi:hearth': { harder: { providerID: 'faux-hearth', modelID: 'glm-5.3-flash' }, easier: { providerID: 'faux-hearth', modelID: 'deepseek-v4.1-flash' } },
    'pi:tower': { harder: { providerID: 'faux-hearth', modelID: 'deepseek-v4.1-flash' }, easier: { providerID: 'faux-hearth', modelID: 'glm-5.3-flash' } },
  } })));
  await page.goto('/?fixture=project-picker&pickerHosts');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'ember-harness (mock)', exact: true }).click();
  await page.getByRole('radio', { name: 'Ultra Delegator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('GLM');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('DeepSeek');
  await page.getByRole('combobox', { name: 'New bot instance' }).click();
  await page.getByRole('option', { name: 'Tower (mock)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('DeepSeek');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('GLM');
  await page.getByRole('combobox', { name: 'New bot instance' }).click();
  await page.getByRole('option', { name: 'ember-harness (mock)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Harder tasks', exact: true })).toContainText('GLM');
  await expect(page.getByRole('button', { name: 'Easier tasks', exact: true })).toContainText('DeepSeek');
});
