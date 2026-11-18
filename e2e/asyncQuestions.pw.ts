import { test, expect } from '@playwright/test';

test('Questions send once, keep uncertain drafts and append independent context without touching the composer', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const composer = leader.getByRole('textbox', { name: 'Message your bot' });
  await composer.fill('Keep my working draft');
  const tab = leader.getByRole('tab', { name: /Questions/ });
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();
  const panel = leader.getByRole('tabpanel', { name: /Questions/ });
  const nested = panel.locator('article').filter({ hasText: 'Keep the migration backup?' });
  await expect(nested).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Migrate schema' })).toBeVisible();
  await nested.getByText('Source and delivery history', { exact: true }).click();
  await expect(nested).toContainText('backup-review');
  await nested.getByRole('button', { name: 'Answer', exact: true }).click();
  const answerComposer = leader.locator('[data-question-answer-composer]');
  await expect(answerComposer).toContainText('Answer for task · Backup audit');
  await answerComposer.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    const calls: Array<{ path: string; body: unknown }> = [];
    let failOnce = true;
    Object.assign(window, { questionMutationCalls: calls });
    window.ember.piRequest = async <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/questions/81/') && init?.method === 'POST') {
        calls.push({ path, body: init.body });
        if (failOnce) { failOnce = false; return { ok: false, status: 503, error: 'Kiln is restarting' }; }
      }
      return original<T>(instance, path, init);
    };
  });
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(answerComposer.getByRole('alert')).toContainText('did not confirm');
  await expect(answerComposer.getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await tab.click();
  await expect(panel).toBeHidden();
  await expect(composer).toHaveValue('Keep my working draft');
  await tab.focus(); await page.keyboard.press('Enter');
  await expect(answerComposer.getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await answerComposer.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByText(/Answered and closed/)).toBeVisible();
  await expect(nested).toContainText('Sent · held on the host');
  await expect(nested.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(nested.getByRole('button', { name: /Resume|Withdraw answer|Retract/i })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { questionMutationCalls: Array<{ path: string; body: { requestId: string; revision: number } }> }).questionMutationCalls);
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
  expect(calls[0].path).toBe('/questions/81/nested%3Adecision/reply');
  expect(calls[0].body.revision).toBe(3);
  await answerComposer.getByRole('button', { name: /Back to chat/ }).click();
  await expect(composer).toHaveValue('Keep my working draft');
  await nested.getByRole('button', { name: 'Add more context' }).click();
  await answerComposer.getByRole('textbox', { name: 'Additional context' }).fill('Keep it until verification is complete.');
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(nested.getByRole('list', { name: 'Additional context' })).toContainText('Keep it until verification is complete.');
  await expect(nested).toContainText('Your answer: Keep');
  await expect(nested.getByRole('button', { name: 'Add more context' })).toBeVisible();
  const latest = await page.evaluate(() => (window as unknown as { questionMutationCalls: Array<{ path: string; body: { requestId: string } }> }).questionMutationCalls);
  expect(latest.at(-1)?.path).toBe('/questions/81/nested%3Adecision/context');
  expect(latest.at(-1)?.body.requestId).not.toBe(calls[0].body.requestId);
  await nested.getByRole('button', { name: 'Go to question' }).click();
  const dialog = page.getByTestId('thread-session-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Keep the migration backup?');
  await expect(dialog.locator('[data-message-id="e811"]')).toHaveAttribute('data-highlighted', 'true');
  await expect(dialog.locator('[data-message-id="e810"]')).not.toHaveAttribute('data-highlighted', 'true');
  await page.keyboard.press('Escape');
  await expect(composer).toHaveValue('Keep my working draft');
  const own = panel.locator('article').filter({ hasText: 'Keep the rollout gradual?' });
  await own.getByRole('button', { name: 'Withdraw question', exact: true }).click();
  await expect(own).toContainText('withdrawn');
});

test('Questions own source opens its canonical message, not a fabricated target', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const tab = leader.getByRole('tab', { name: /Questions/ });
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();
  const own = leader.getByRole('tabpanel', { name: /Questions/ }).locator('article').filter({ hasText: 'Keep the rollout gradual?' });
  await own.getByRole('button', { name: 'Go to question' }).click();
  await expect(leader.locator('[data-message-id="e91"]')).toBeVisible();
  await expect(leader.locator('[data-message-id="e91"]')).toHaveAttribute('data-highlighted', 'true');
});

async function openQuestions(page: import('@playwright/test').Page) {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const tab = column.getByRole('tab', { name: /Questions/ });
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();
  const panel = column.getByRole('tabpanel', { name: /Questions/ });
  const question = panel.locator('article').filter({ hasText: 'Keep the migration backup?' });
  const answerComposer = column.locator('[data-question-answer-composer]');
  return { column, tab, panel, question, answerComposer };
}

test('a committed context message whose response was lost is confirmed by its own receipt, not resent', async ({ page }, info) => {
  const { question, panel, answerComposer } = await openQuestions(page);
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await answerComposer.getByRole('button', { name: 'Keep', exact: true }).click();
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await question.getByRole('button', { name: 'Add more context' }).click();
  await answerComposer.getByRole('textbox', { name: 'Additional context' }).fill('Keep backups until the external audit ends.');
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    Object.assign(window, { contextSends: 0 });
    window.ember.piRequest = async (instance, path, init) => {
      const result = await original(instance, path, init);
      if (path.endsWith('/context') && init?.method === 'POST') {
        (window as unknown as { contextSends: number }).contextSends++;
        return { ok: false, status: 0, data: null as never };
      }
      return result;
    };
  });
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(question.getByRole('list', { name: 'Additional context' }).getByRole('listitem')).toHaveCount(1);
  await expect(question).toContainText('Keep backups until the external audit ends.');
  await expect(question.getByRole('button', { name: 'Add more context' })).toBeVisible();
  await expect(question.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { contextSends: number }).contextSends)).toBe(1);
  await expect(panel).toContainText('Your answer: Keep');
  await page.screenshot({ path: info.outputPath('questions-appended-context.png') });
});

test('another answer wins without losing the rejected draft; the human can explicitly send it as more context', async ({ page }, info) => {
  const { question, answerComposer } = await openQuestions(page);
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await answerComposer.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    let first = true;
    window.ember.piRequest = async (instance, path, init) => {
      if (first && path.endsWith('/nested%3Adecision/reply') && init?.method === 'POST') {
        first = false;
        const body = init.body as { revision: number };
        await original(instance, path, { method: 'POST', body: { answer: 'Keep', revision: body.revision, requestId: 'other-human-answer' } });
        return { ok: false, status: 409, data: null as never };
      }
      return original(instance, path, init);
    };
  });
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(question).toContainText('Your answer: Keep');
  await expect(answerComposer.getByRole('alert')).toContainText('already has an answer');
  await expect(answerComposer.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await answerComposer.getByRole('button', { name: 'Keep this draft as more context' }).click();
  await expect(answerComposer.getByRole('textbox', { name: 'Additional context' })).toHaveValue('Remove');
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(question.getByRole('list', { name: 'Additional context' })).toContainText('Remove');
  await expect(question).toContainText('Your answer: Keep');
  await page.screenshot({ path: info.outputPath('questions-conflict-recovery.png') });
});

test('a late original-answer response cannot erase the next context draft after a canonical refresh', async ({ page }) => {
  const { question, panel, answerComposer } = await openQuestions(page);
  await panel.getByText(/Answered and closed/).click();
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    window.ember.piRequest = async (instance, path, init) => {
      const result = await original(instance, path, init);
      if (path.endsWith('/nested%3Adecision/reply') && init?.method === 'POST') {
        await new Promise<void>(resolve => Object.assign(window, { releaseAnswerResponse: resolve }));
      }
      return result;
    };
  });
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await answerComposer.getByRole('button', { name: 'Keep', exact: true }).click();
  await answerComposer.getByRole('button', { name: 'Send answer', exact: true }).click();
  // Questions has an independent short poll. It sees the committed receipt while the old
  // mutation response is deliberately held, as it can be on a real interrupted connection.
  await expect(question.getByRole('button', { name: 'Add more context' })).toBeVisible({ timeout: 20000 });
  await question.getByRole('button', { name: 'Add more context' }).click();
  await answerComposer.getByRole('textbox', { name: 'Additional context' }).fill('A new draft typed after the answer was confirmed');
  await page.evaluate(() => (window as unknown as { releaseAnswerResponse: () => void }).releaseAnswerResponse());
  await expect(answerComposer.getByRole('textbox', { name: 'Additional context' })).toHaveValue('A new draft typed after the answer was confirmed');
  await expect(answerComposer.getByRole('button', { name: 'Send answer', exact: true })).toBeEnabled();
});

test('Spec Q answer mode keeps single composer, detaches child dock, preserves drafts across tabs, and returns via Escape', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  const chatInput = leader.getByRole('textbox', { name: 'Message your bot' });
  await chatInput.fill('Draft stays intact');

  // Arrival of questions does not hijack main composer focus or mode.
  const tab = leader.getByRole('tab', { name: /Questions/ });
  if (await tab.getAttribute('aria-expanded') !== 'true') await tab.click();

  const answerComposer = leader.locator('[data-question-answer-composer]');
  await expect(answerComposer).toBeVisible();
  await expect(leader.locator('textarea')).toHaveCount(1);
  await expect(answerComposer).toContainText('Answer for this conversation');
  await expect(page.locator('[data-active-chat]')).toBeVisible();

  // Dock height stays well under 38dvh when answering on desktop.
  const dockBox = await page.locator('[data-active-chat]').boundingBox();
  const viewport = page.viewportSize()!;
  expect(dockBox!.height).toBeLessThan(viewport.height * 0.38);

  // Page to child task question -> LeftRail dock detaches cleanly and provenance updates.
  await expect(answerComposer).toContainText('1 / 2');
  await answerComposer.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(answerComposer).toContainText('2 / 2');
  await expect(answerComposer).toContainText('Answer for task · Backup audit');
  await expect(page.locator('[data-active-chat]')).toHaveCount(0);

  // Combined choice + long note > 32 chars works cleanly and survives tab switching.
  await answerComposer.getByRole('button', { name: 'Keep', exact: true }).click();
  const note = 'Preserve backup snapshot until post-deploy verification finishes completely';
  await answerComposer.getByRole('textbox', { name: 'Add a note' }).fill(note);
  await leader.getByRole('tab', { name: /Tasks/ }).click();
  await expect(chatInput).toHaveValue('Draft stays intact');
  await expect(page.locator('[data-active-chat]')).toBeVisible();

  await tab.click();
  await expect(answerComposer.getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(answerComposer.getByRole('textbox', { name: 'Add a note' })).toHaveValue(note);

  // Escape returns cleanly to main chat composer with draft restored.
  await answerComposer.getByRole('textbox', { name: 'Add a note' }).press('Escape');
  await expect(answerComposer).toHaveCount(0);
  await expect(chatInput).toHaveValue('Draft stays intact');
});
