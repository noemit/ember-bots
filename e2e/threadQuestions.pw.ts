import { expect, test, type Page } from '@playwright/test';

const leaderSelector = 'main[data-session-key="pi:hearth::16"]';

async function workspace(page: Page) {
  return page.evaluate(async () => {
    const settings = await window.ember.getSettings();
    return { openSessions: settings.openSessions, activeSession: settings.activeSession };
  });
}

async function openLeader(page: Page, nested = false) {
  await page.goto(nested ? '/?fixture=thread-questions' : '/');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const leader = page.locator(leaderSelector);
  await expect(leader.getByTestId('thread-question').first()).toBeVisible();
  await leader.locator('textarea').fill('Keep my leader draft while I answer');
  await expect.poll(async () => (await workspace(page)).activeSession).toBe('pi:hearth::16');
  await leader.evaluate((node) => node.setAttribute('data-retention-probe', 'original'));
  // Requests use the in-browser mock bridge, not HTTP. Observe the real UI's calls through it.
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    const replies: Array<{ instance: string; path: string; body: unknown }> = [];
    Object.assign(window, { threadQuestionReplies: replies });
    window.ember.piRequest = <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/questions/') && init?.method === 'POST') {
        replies.push({ instance, path, body: init.body });
      }
      return original<T>(instance, path, init);
    };
  });
  return { leader, savedWorkspace: await workspace(page) };
}

async function replies(page: Page) {
  return page.evaluate(() => (window as unknown as {
    threadQuestionReplies: Array<{ instance: string; path: string; body: unknown }>;
  }).threadQuestionReplies);
}

async function expectLeaderRetained(page: Page, savedWorkspace: Awaited<ReturnType<typeof workspace>>) {
  const leader = page.locator(leaderSelector);
  await expect(leader).toHaveAttribute('data-retention-probe', 'original');
  await expect(leader.locator('textarea')).toHaveValue('Keep my leader draft while I answer');
  await expect.poll(() => workspace(page)).toEqual(savedWorkspace);
  await expect(page.locator('[data-active-chat]')).toContainText('Crew: auth refactor');
}

test('a direct thread question is answerable in the leader and routes only to its worker', async ({ page }, testInfo) => {
  const { leader, savedWorkspace } = await openLeader(page);
  const question = leader.getByTestId('thread-question');
  await expect(question).toHaveCount(1);
  await expect(question).toContainText('Thread: Migrate schema');
  await expect(question).toContainText('Drop the legacy column?');
  await expect(question.getByRole('button', { name: 'Open thread', exact: true })).toBeVisible();
  await expect(question.getByRole('button', { name: 'Answer', exact: true })).toBeDisabled();
  await question.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(question.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('leader-thread-question.png') });
  await testInfo.attach('Leader with an actionable thread question', {
    path: testInfo.outputPath('leader-thread-question.png'), contentType: 'image/png',
  });
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(question).toHaveCount(0);
  expect(await replies(page)).toEqual([
    { instance: 'pi:hearth', path: '/questions/18/worker-question/reply', body: { answer: 'Yes' } },
  ]);
  await expect(page.getByTestId('thread-session-modal')).toHaveCount(0);
  await expectLeaderRetained(page, savedWorkspace);
  // Settled threads move behind Previous; their source remains openable there.
  await leader.getByRole('button', { name: /\+1 previous/ }).click();
  // The host's resulting reply belongs to the worker, not the leader transcript.
  await leader.getByRole('button', { name: 'Migrate schema', exact: true }).click();
  const worker = page.getByTestId('thread-session-modal').locator('main[data-session-key="pi:hearth::18"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Got it: Yes.');
  await expect(worker.getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectLeaderRetained(page, savedWorkspace);
});

test('nested questions surface at the root and dismiss independently of the direct worker', async ({ page }, testInfo) => {
  const { leader, savedWorkspace } = await openLeader(page, true);
  const questions = leader.getByTestId('thread-question');
  await expect(questions).toHaveCount(2);
  const direct = questions.filter({ hasText: 'Thread: Migrate schema' });
  const nested = questions.filter({ hasText: 'Thread: Audit migration' });
  await expect(direct).toContainText('Drop the legacy column?');
  await expect(nested).toContainText('Keep the migration backup?');
  // The unrelated pending question in conversation 12 must not leak into this leader.
  await expect(questions.filter({ hasText: 'Which licence should the shortlist require?' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('leader-nested-thread-questions.png') });
  await testInfo.attach('Direct and nested thread questions', {
    path: testInfo.outputPath('leader-nested-thread-questions.png'), contentType: 'image/png',
  });
  await nested.getByRole('button', { name: 'Open thread', exact: true }).click();
  const modal = page.getByTestId('thread-session-modal');
  await expect(modal.locator('main[data-session-key="pi:hearth::21"]')).toBeVisible();
  await expect(modal.getByRole('log', { name: 'Conversation' })).toContainText('Audit the migration.');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(nested.getByRole('button', { name: 'Open thread', exact: true })).toBeFocused();
  await nested.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(nested).toHaveCount(0);
  await expect(direct).toBeVisible();
  expect(await replies(page)).toEqual([
    { instance: 'pi:hearth', path: '/questions/21/nested-question/reply', body: { answer: null } },
  ]);
  await expectLeaderRetained(page, savedWorkspace);
});

test('answering in the source modal also removes the leader card without replacing its workspace', async ({ page }) => {
  const { leader, savedWorkspace } = await openLeader(page);
  const question = leader.getByTestId('thread-question');
  await question.getByRole('button', { name: 'Open thread', exact: true }).click();
  const modal = page.getByTestId('thread-session-modal');
  const worker = modal.locator('main[data-session-key="pi:hearth::18"]');
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Migrate the schema.');
  await expect(worker.locator('textarea')).toBeEnabled();
  await expectLeaderRetained(page, savedWorkspace);
  await worker.getByRole('button', { name: 'No', exact: true }).click();
  await worker.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(worker.getByRole('log', { name: 'Conversation' })).toContainText('Got it: No.');
  await expect(question).toHaveCount(0);
  expect(await replies(page)).toEqual([
    { instance: 'pi:hearth', path: '/questions/18/worker-question/reply', body: { answer: 'No' } },
  ]);
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expectLeaderRetained(page, savedWorkspace);
});

test('a failed thread reply preserves the answer and leader draft for retry', async ({ page }) => {
  const { leader, savedWorkspace } = await openLeader(page);
  const question = leader.getByTestId('thread-question');
  await question.getByRole('textbox', { name: 'Custom answer' }).fill('Keep the column until the audit finishes');
  await page.evaluate(() => {
    const original = window.ember.piRequest!.bind(window.ember);
    let failNextReply = true;
    window.ember.piRequest = <T = unknown>(instance: string, path: string, init?: { method?: string; body?: unknown }) => {
      if (failNextReply && path === '/questions/18/worker-question/reply' && init?.method === 'POST') {
        failNextReply = false;
        return Promise.reject(new Error('Hearth did not answer. Try again.'));
      }
      return original<T>(instance, path, init);
    };
  });
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(question).toBeVisible();
  await expect(question.getByRole('textbox', { name: 'Custom answer' })).toHaveValue('Keep the column until the audit finishes');
  const error = question.getByRole('alert');
  await expect(error).toContainText(/host|Hearth|Kiln/i);
  await expect(error).toContainText(/try|again|retry/i);
  await expect(error).not.toContainText(/undefined|null|HTTP|stack|something went wrong/i);
  await expect(question.getByRole('button', { name: 'Answer', exact: true })).toBeEnabled();
  await expectLeaderRetained(page, savedWorkspace);
  await question.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(question).toHaveCount(0);
  expect(await replies(page)).toEqual([
    { instance: 'pi:hearth', path: '/questions/18/worker-question/reply', body: { answer: 'Keep the column until the audit finishes' } },
  ]);
  await expectLeaderRetained(page, savedWorkspace);
});
