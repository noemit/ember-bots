import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The pi mock (the default dev bridge) drives the same UI App against Hearth semantics:
 * conversations in the rail, pi transcripts, the wire submit path, and the crash-durable
 * approvals/questions cards. The legacy OpenCode mock is still exercised by the other
 * suites via `?legacy` during the transition.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the top bar has no Directory tab: names are registered, not browsed', async ({ page }) => {
  // 0.82.0 removed the tab at the owner's request — a spawned session now registers itself, so
  // there is nothing to go and look at.
  await expect(page.getByRole('group', { name: 'Views' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Bot directory/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Usage — model calls and reported cost' })).toBeVisible();
});

test('the rail lists Hearth conversations and the top bar shows the instance', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Habit onboarding QA/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Remote access hardening/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Instances', exact: true })).toContainText('1/1');
});

test('opening a conversation renders its pi transcript', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column).toBeVisible();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('QA the Habit onboarding flow.');
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('step counter shows');
  // The session's folder shows next to the instance in the header.
  await expect(column.getByTitle('/workspace/habit')).toBeVisible();
});

test('a running command shows its output as it arrives, without opening the row', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
  await page.keyboard.press('Escape');
  await column.locator('textarea').fill('live tail of the log please');
  await column.locator('textarea').press('Enter');

  // The host streams the command's output; the row shows it while it is still running.
  const tail = column.locator('[data-live-tail]');
  await expect(tail).toContainText('waiting for RC=');
  const row = column.getByRole('button', { name: /grep -c/ });
  // Collapsed, deliberately: needing a click to see a command's progress was the bug.
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  // And it keeps up as more lines land.
  await expect(tail).toContainText('FINAL-CUT-v2.iso');

  // The settled result replaces the block in place, and the whole output is behind the row.
  await expect(tail).toHaveCount(0);
  await row.click();
  await expect(column.locator('pre').filter({ hasText: 'FINAL-CUT-v2.iso' }).last()).toBeVisible();
});

test('a failed command keeps its whole output, and the row names the exit code', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
  await page.keyboard.press('Escape');
  await column.locator('textarea').fill('a failing grep please');
  await column.locator('textarea').press('Enter');

  // Matched on the log name: the caret in `^RC=` is a regex anchor, not a character to search for.
  const row = column.getByRole('button', { name: /stage2\.log/ });
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  // The exit status is named, because a grep exiting 1 is an answer rather than a crash.
  await expect(row).toContainText('exit 1');

  await row.click();
  // The line that matters sits past the old 400-character cut, and it is in the transcript.
  await expect(column.locator('pre').filter({ hasText: 'FINAL-CUT-v2.iso   1.8 MB' })).toBeVisible();
  // One red line says why, instead of replacing the output.
  await expect(column.locator('pre').filter({ hasText: 'Command exited with code 1' })).toBeVisible();
  // And the host's own truncation is admitted rather than hidden.
  await expect(column.getByText('Earlier output was dropped — this is the tail the host kept.')).toBeVisible();
});

/** How far the reader is from the end of the transcript, in pixels. */
const distanceFromBottom = (scroller: Locator) =>
  scroller.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));

test('a message landing never pulls a reader who scrolled back to the bottom', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const scroller = column.locator('[aria-label="Conversation history"]');
  const composer = column.locator('textarea');

  // Give the transcript more height than its scroller so there is somewhere to scroll back to.
  for (let index = 0; index < 6; index += 1) {
    await composer.fill(`padding message ${index}`);
    await composer.press('Enter');
    await page.waitForTimeout(700);
  }
  const openAtBottom = await scroller.evaluate((el) => ({
    top: Math.round(el.scrollTop),
    end: Math.round(el.scrollHeight - el.clientHeight),
  }));
  // Opening a session lands on its latest turn — that part is intended.
  expect(Math.abs(openAtBottom.end - openAtBottom.top)).toBeLessThanOrEqual(4);

  // The reader scrolls back with a real wheel, which is what marks the scroll as theirs.
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  expect(await distanceFromBottom(scroller)).toBeGreaterThan(60);

  // A message lands. Previously the pin effect re-ran on every append and scrolled to the bottom
  // regardless of where the reader was; the state and the view then disagreed.
  await composer.fill('a thought after scrolling back');
  await composer.press('Enter');
  await page.waitForTimeout(1800);
  // Still reading where they were: distinctly short of the end, not pulled down to it.
  expect(await distanceFromBottom(scroller)).toBeGreaterThan(60);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

  // And the way back still works.
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect
    .poll(async () =>
      scroller.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop))
    )
    .toBeLessThanOrEqual(4);
});

test('with following off, growth does not scroll even at the bottom', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const scroller = column.locator('[aria-label="Conversation history"]');
  const composer = column.locator('textarea');

  for (let index = 0; index < 6; index += 1) {
    await composer.fill(`padding message ${index}`);
    await composer.press('Enter');
    await page.waitForTimeout(700);
  }

  // Untick "Follow new content while streaming" in the eye menu.
  await page.getByRole('button', { name: 'View options' }).first().click();
  await page.getByRole('menuitemcheckbox', { name: 'Follow new content while streaming' }).click();
  await page.keyboard.press('Escape');
  // Let the menu's overlay unmount, or the wheel lands on it instead of the transcript.
  await page.waitForTimeout(400);

  await scroller.hover();
  await page.mouse.wheel(0, -600);
  // Wheel dispatch returns before Chromium applies the scroll. Wait for the user's movement.
  await expect.poll(() => distanceFromBottom(scroller)).toBeGreaterThan(60);
  await composer.fill('another without following');
  await composer.press('Enter');
  await page.waitForTimeout(1800);
  expect(await distanceFromBottom(scroller)).toBeGreaterThan(60);
});

/** Records what the renderer sends to the instance, so a read can be shown to send nothing. */
const captureRequests = (page: Page) =>
  page.evaluate(() => {
    const bridge = window.ember as unknown as { request: (...args: unknown[]) => Promise<unknown> };
    if ((window as unknown as { __readCapture?: boolean }).__readCapture) return;
    (window as unknown as { __readCapture?: boolean }).__readCapture = true;
    const original = bridge.request.bind(window.ember);
    (window as unknown as { __readRequests: unknown[] }).__readRequests = [];
    bridge.request = async (...args: unknown[]) => {
      (window as unknown as { __readRequests: unknown[] }).__readRequests.push(args.slice(0, 3));
      return original(...args);
    };
  });

const capturedMutations = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __readRequests?: Array<[string, string, string]> }).__readRequests ?? [])
      .filter(([, method]) => method !== 'GET')
      .map(([, method, path]) => ({ method, path }))
  );

/** A busy conversation, so the next message queues instead of sending. */
const queueFollowUpsForRead = async (page: Page): Promise<Locator> => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = column.locator('textarea');
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(
    column.locator('textarea[aria-label="Queue a follow-up message"]')
  ).toBeVisible({ timeout: 15_000 });
  return column;
};

test('a queued message opens read-only, and reading it changes nothing', async ({ page }) => {
  const column = await queueFollowUpsForRead(page);
  const composer = column.locator('textarea');
  const long = 'once that lands, re-run the schema tests and paste the failures next to the diff';
  await composer.fill(long);
  await composer.press('Enter');
  const row = column.getByRole('button', { name: new RegExp(`Read queued message: ${long.slice(0, 40)}`) });
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Nothing on the wire yet: this is the state a read must leave untouched.
  await captureRequests(page);
  await row.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Queued message')).toBeVisible();
  // The whole message, which the one-line row truncates.
  await expect(dialog.locator('pre')).toHaveText(long);
  await expect(dialog.getByText('Nothing here changes what will be sent.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Reading is not an edit: the row is still queued, under the same id, with no request behind it.
  expect(await capturedMutations(page)).toEqual([]);
  await expect(column.getByRole('button', { name: /Cancel queued message: once that lands/ })).toBeVisible();

  // Editing is a separate, explicit step from the read view.
  await row.click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog').getByText('Edit queued message')).toBeVisible();
  await page.getByRole('textbox', { name: 'Queued message text' }).fill('edited from the read view');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    column.getByRole('button', { name: /Cancel queued message: edited from the read view/ })
  ).toBeVisible({ timeout: 10_000 });
});

test('a compaction the host accepts and does not perform says so', async ({ page }) => {
  // Hearth answers 202 for every compaction, then does nothing at all when the transcript already
  // fits the kept window: no summary entry, no flag, no event. The click used to be silent.
  await page.goto('/?compactNoop');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const meter = column.locator('button[data-context-meter]');
  await expect(meter).toBeVisible();
  await meter.click();

  // The notice is the app's own toast, next to the search button in the top bar.
  await expect(page.getByRole('status').filter({ hasText: /Nothing to compact/ })).toBeVisible({
    timeout: 10_000,
  });
  // The transcript is untouched, and the meter is idle again rather than spinning for ever.
  await expect(meter).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // And the attempt is written down: the next "nothing happened" has to be answerable from a file,
  // not reconstructed from a hunch.
  const logged = await page.evaluate(() => window.localStorage.getItem('ember-compact-log') ?? '');
  expect(logged).toContain('outcome=nothing');
  expect(logged).toContain('compacting=false');
  expect(logged).toContain('session=10');
});

test('a compaction that runs keeps the meter spinning until its summary lands', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const meter = column.locator('button[data-context-meter]');
  await expect(meter).toBeVisible();
  await meter.click();
  await expect(column.getByRole('button', { name: 'Compacting context…' })).toBeVisible({ timeout: 10_000 });
  await expect(column.getByRole('button', { name: 'Compacting context…' })).toHaveCount(0, { timeout: 15_000 });
});

test('a fast run of messages keeps the transcript at the end instead of stranding it', async ({ page }) => {
  // The reported shape: many appends in quick succession. Each one changes the band's height, and the
  // browser clamps the scroll when the viewport grows — which the transcript used to read as the
  // reader scrolling back, so following switched itself off (measured before the fix: left at the top
  // of an 8,428px list with "Jump to latest" showing, three runs out of three).
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const scroller = column.locator('[aria-label="Conversation history"]');
  const composer = column.locator('textarea');

  for (let index = 0; index < 24; index += 1) {
    await composer.fill(`padding message ${index}`);
    await composer.press('Enter');
    await page.waitForTimeout(230);
  }
  await page.waitForTimeout(1200);

  const end = await scroller.evaluate((el) => ({
    distance: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    height: Math.round(el.scrollHeight),
  }));
  // Long enough that straying from the end would be obvious, and still at the end.
  expect(end.height).toBeGreaterThan(2000);
  expect(end.distance).toBeLessThanOrEqual(4);
  await expect(column.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
});

test('a message can be copied as the Markdown it was written in', async ({ page }) => {
  // Read the real clipboard back rather than stubbing it: that is the thing a person pastes.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: /Wire the pi mock/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::12"]');
  const log = column.getByRole('log', { name: 'Conversation' });
  await expect(log).toBeVisible();

  const copies = column.getByRole('button', { name: 'Copy', exact: true });
  await expect(copies.first()).toBeVisible();

  // A user's message copies too, and it is their own words.
  await copies.first().click();
  await expect(column.getByRole('status').filter({ hasText: 'Copied as Markdown' }).first()).toBeAttached();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Wire the pi mock into dev:web.');

  // The assistant's turn, whole. Its text is the source, so nothing is flattened into prose.
  await expect(copies.first()).toBeVisible();
  await copies.last().click();
  await expect(column.getByRole('status').filter({ hasText: 'Copied as Markdown' }).last()).toBeAttached();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('delete the stale previews');
  expect(copied.trim().length).toBeGreaterThan(10);
});
test('a tool-result entry merges into the assistant tool row', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
  await page.keyboard.press('Escape');
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('src/remote.ts');
});

test('sending to a conversation echoes the scripted pi reply', async ({ page }) => {
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const composer = column.locator('textarea');
  await composer.fill('hello there');
  await composer.press('Enter');
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Hello! ember-harness is listening.');
});

test('a parked approval shows a permission card and replying runs the tool', async ({ page }) => {
  await page.getByRole('button', { name: /Wire the pi mock/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::12"]');
  await expect(column.getByText('About to delete the stale previews.')).toBeVisible();
  const allowOnce = column.getByRole('button', { name: 'Allow', exact: true });
  await expect(allowOnce).toBeVisible();
  await allowOnce.click();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Done. The tool ran and I carried on.');
});

test('a parked question can be answered and the run continues', async ({ page }) => {
  await page.getByRole('button', { name: /Dataset shortlist/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::13"]');
  await expect(column.getByText('Which licence should the shortlist require?')).toBeVisible();
  await column.getByRole('button', { name: 'CC-BY' }).click();
  await column.getByRole('button', { name: 'Answer' }).click();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Got it: CC-BY');
});

test('a tool that returns an image shows it in the transcript', async ({ page }) => {
  await page.getByRole('button', { name: /Screenshot review/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::15"]');
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Here is the dashboard.');
  await expect(column.locator('img[alt="screenshot.png"]')).toBeVisible();

  // The image is content, not plumbing: it stays when tool calls are hidden.
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show tool use' }).click();
  await page.keyboard.press('Escape');
  await expect(column.locator('img[alt="screenshot.png"]')).toBeVisible();
});

test('the eye menu toggles what the transcript shows, and stays open', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
  await page.keyboard.press('Escape');
  const log = column.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('src/remote.ts');

  await column.getByRole('button', { name: 'View options' }).click();
  const toolToggle = page.getByRole('menuitemcheckbox', { name: 'Show tool use' });
  // Toggling off keeps the menu open for the next choice.
  await toolToggle.click();
  await expect(toolToggle).toBeVisible();
  await expect(toolToggle).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(log).not.toContainText('src/remote.ts');

  // And back on, again without the menu closing.
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show tool use' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show tool use' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(log).toContainText('src/remote.ts');
});

test('compacting stays visible while the compaction is in flight', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const compact = column.getByRole('button', { name: /Click to compact/ });
  await expect(compact).toBeVisible();
  await compact.click();
  // The meter stays compacting until the summary lands — not just for the HTTP request.
  await expect(column.getByRole('button', { name: 'Compacting context…' })).toBeVisible({ timeout: 5_000 });
  await expect(column.getByRole('button', { name: /Click to compact/ })).toBeVisible({ timeout: 10_000 });
});

test('an answered question stays in the transcript as a Q&A record', async ({ page }) => {
  await page.getByRole('button', { name: /Dataset shortlist/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::13"]');
  await expect(column.getByText('The bot has a question')).toBeVisible();
  // A URL in the question is a clickable link (routed through the Ember bridge).
  await expect(column.getByRole('link', { name: 'https://example.com/licences' })).toBeVisible();
  await column.getByRole('button', { name: 'CC-BY' }).click();
  await column.getByRole('button', { name: 'Answer' }).click();

  // The pending card goes away, but the question and the answer stay in the transcript.
  await expect(column.getByText('The bot has a question')).toHaveCount(0, { timeout: 10_000 });
  await expect(column.getByText('The bot asked')).toBeVisible({ timeout: 10_000 });
  await expect(column.getByText('Which licence should the shortlist require?')).toBeVisible();
  await expect(column.getByText(/You answered:/)).toBeVisible();
});

test('Settings → Instances manages Hearth endpoints', async ({ page }) => {
  // The mock ships one endpoint; it is listed with its masked token.
  await page.getByRole('button', { name: 'Instances', exact: true }).click();
  await page.getByRole('menuitem', { name: /Instance settings/ }).click();
  const row = page.locator('[data-endpoint="pi:hearth"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('ember-harness (mock)');
  await expect(row).toContainText('••••');

  // Add a second endpoint.
  await page.getByLabel('New endpoint label').fill('Studio (test)');
  await page.getByLabel('New endpoint address').fill('http://127.0.0.1:3999');
  await page.getByLabel('New endpoint token').fill('test-token');
  await page.getByRole('button', { name: 'Add' }).click();
  const added = page.locator('[data-endpoint="pi:studio-test"]');
  await expect(added).toBeVisible();

  // Test probes /health through the bridge; the mock answers.
  await page.getByRole('button', { name: 'Test Studio (test)' }).click();
  await expect(added).toContainText('up');

  // Remove it again.
  await page.getByRole('button', { name: 'Remove Studio (test)' }).click();
  await expect(added).toHaveCount(0);
});

test('YOLO mode reflects the conversation auto-accept policy over the pi wire', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const yolo = column.getByRole('button', { name: /YOLO mode/ });
  // The fresh conversation is off; Hearth carries the flag on the summary.
  await expect(yolo).toHaveAttribute('aria-label', 'YOLO mode off');
  await yolo.click();
  await expect(yolo).toHaveAttribute('aria-label', /YOLO mode on/);
});

test('a scheduled run is an ordinary session, marked with the plan that started it', async ({ page }) => {
  // The scheduler used to get a rail *mode*: a clock toggle swapped the whole list for the latest run
  // of each task, which hid every session the person was actually working in. A run is a session —
  // it belongs in the list, with a mark saying what started it — and the plans belong in their own
  // Scheduled tab, because a trigger is not a conversation.
  await page.getByRole('button', { name: /Crew: auth refactor/ }).click();

  // The run is in the normal list, and says where it came from.
  const run = page.getByRole('button', { name: /Remote access hardening/ }).first();
  await expect(run).toBeVisible();
  await expect(page.getByLabel('Started by the scheduled task Nightly brief')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show scheduled sessions' })).toHaveCount(0);

  // Plans live in the Scheduled tab, leaving the rail for ordinary sessions.
  await expect(page.getByTestId('rail-scheduled-plan')).toHaveCount(0);
  await page.getByRole('button', { name: 'Scheduled — runs and recurring plans' }).click();
  const plan = page.getByTestId('scheduled-plans-list');
  await expect(plan).toContainText('Nightly brief');
  await expect(plan).toContainText('Every day at 09:00');
  await expect(plan.getByRole('button', { name: 'Run Nightly brief now' })).toBeVisible();
});

test('a new bot is named from its first message, not given a number', async ({ page }) => {
  await page.getByRole('button', { name: 'New bot' }).first().click();
  await page.getByRole('button', { name: 'New bot project' }).waitFor();
  const composer = page.locator('textarea').first();
  await composer.fill('Fix the flaky tailnet reconnect before the demo.');
  await composer.press('Enter');

  // The subject survives naming, and the dock exposes the same identity as the conversation.
  const column = page.locator('main[data-session-key]').first();
  await expect(column).toBeVisible();
  await expect(column.locator('header')).toContainText('Network Navigator');
  await expect(page.locator('[data-active-chat]')).toContainText('Network Navigator');
});

test('closing every column keeps the rail available, and Sessions reopens a chat', async ({ page }) => {
  await page.getByRole('button', { name: /^Sessions —/ }).click();
  const column = page.locator('main[data-session-key]').first();
  await expect(column).toBeVisible();
  const key = await column.getAttribute('data-session-key');
  await column.locator('header').getByRole('button', { name: 'Close this column', exact: true }).click();

  // The rail remains available when the last column is closed.
  await expect(page.locator('aside')).toBeVisible();
  await expect(page.locator('main[data-session-key]')).toHaveCount(0);

  // Sessions reopens the latest chat when nothing is open.
  await page.getByRole('button', { name: /^Sessions —/ }).click();
  await expect(page.locator(`main[data-session-key="${key}"]`)).toBeVisible();
  await expect(page.getByTestId('home-view')).toHaveCount(0);
});

test('the session list has three widths: mini, normal, wide', async ({ page }) => {
  await page.getByRole('button', { name: /^Sessions —/ }).click();
  const rail = page.locator('aside');
  const toolbar = page.getByTestId('window-toolbar');
  const name = toolbar.locator('[data-app-name]');
  const namePosition = await name.boundingBox();
  const widen = toolbar.getByRole('button', { name: 'Widen the session list' });
  await expect(widen).toBeVisible();
  const controlPosition = (await widen.boundingBox())!;
  expect(controlPosition.x + controlPosition.width).toBeLessThan(namePosition!.x);
  expect(Math.abs(controlPosition.y + controlPosition.height / 2 - namePosition!.y - namePosition!.height / 2)).toBeLessThan(1);
  await expect(rail.getByRole('button', { name: 'Widen the session list' })).toHaveCount(0);
  const width = async () => (await rail.boundingBox())?.width ?? 0;
  // The width animates, so every step is polled rather than measured once.
  await expect.poll(width).toBe(272);

  // Wide: about half the window, and the whole reason for it — more of the latest message.
  await widen.click();
  const viewport = page.viewportSize()?.width ?? 0;
  await expect.poll(width).toBeGreaterThan(viewport * 0.4);
  await expect(rail.getByTestId('session-preview').first()).toBeVisible();

  // Mini: a blob dock, about the width of one blob column.
  await toolbar.getByRole('button', { name: 'Collapse the session list' }).click();
  await expect.poll(width).toBeLessThan(80);
  expect(await rail.locator('[data-mini-session]').count()).toBeGreaterThan(0);
  await expect(rail.getByTestId('session-preview')).toHaveCount(0);

  // Back to normal, and the keyboard walks the same ring.
  await toolbar.getByRole('button', { name: 'Show the normal session list' }).click();
  await expect.poll(width).toBe(272);
  expect(await name.boundingBox()).toEqual(namePosition);
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(width).toBeGreaterThan(viewport * 0.4);
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(width).toBeLessThan(80);
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(width).toBe(272);
  await page.screenshot({ path: '/tmp/ember-topbar-sidebar.png' });
});

test('the new-agent folder picker lists Hearth directories', async ({ page }) => {
  await page.getByRole('button', { name: 'New bot' }).click();
  await page.getByRole('button', { name: 'New bot project' }).click();
  await page.getByRole('button', { name: 'Use this workspace' }).click();
  await expect(page.getByRole('option', { name: /habit/ })).toBeVisible();
  await page.getByRole('option', { name: /habit/ }).click();
  await expect(page.getByRole('button', { name: 'New bot project' })).toContainText('habit');
});

test('a busy conversation queues a follow-up, and it can be withdrawn', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');

  // A "slow" reply keeps the conversation busy; the state poll flips the composer into queue mode.
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });

  await composer.fill('queued follow-up');
  await composer.press('Enter');

  // The queued row reconciles with Hearth's inbox (server id, not a lingering pending row).
  const discard = column.getByRole('button', { name: /Cancel queued message: queued follow-up/ });
  await expect(discard).toBeVisible({ timeout: 10_000 });

  // Folding lives on the shelf's tab line now, and the fold control sits inside the band, clear of
  // the column's right edge — it used to float over the corner, which is where the scrollbar is.
  const fold = column.getByRole('button', { name: 'Fold the composer trays' });
  const badge = await fold.boundingBox();
  const bounds = await column.boundingBox();
  expect(badge && bounds).toBeTruthy();
  // The band's own padding is the margin now: the control is a normal child of the tab line, not a
  // badge offset from the edge, so it clears the transcript's scrollbar by construction.
  expect((badge as { x: number; width: number }).x + (badge as { width: number }).width).toBeLessThanOrEqual(
    (bounds as { x: number; width: number }).x + (bounds as { width: number }).width - 8
  );
  // Folding hides the rows but keeps the tab, so the queue is still one click away.
  await fold.click();
  await expect(column.getByRole('tab', { name: /Queue/ })).toBeVisible();
  await expect(discard).toHaveCount(0);
  await column.getByRole('tab', { name: /Queue/ }).click();
  await expect(discard).toBeVisible();
  // A queued message is not a sent one: it must not read as a transcript bubble.
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('queued follow-up');
  await discard.click();
  await expect(discard).toHaveCount(0);
});

test('a queued follow-up can be reordered', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = column.locator('textarea');
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });
  await composer.fill('first follow-up');
  await composer.press('Enter');
  await composer.fill('second follow-up');
  await composer.press('Enter');

  const rows = column.locator('ol > li');
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await expect(rows.nth(0)).toContainText('first follow-up');
  await expect(rows.nth(1)).toContainText('second follow-up');

  // Move the second up: Hearth withdraws and re-submits in the new order, and the rows follow.
  await column.getByRole('button', { name: /Move queued message up: second follow-up/ }).click();
  await expect(rows.nth(0)).toContainText('second follow-up', { timeout: 10_000 });
  await expect(rows.nth(1)).toContainText('first follow-up');
});

test('a follow-up Hearth queues without the client knowing lands in the queue, never the transcript', async ({ page }) => {
  // `?staleBusy` parks a follow-up server-side while the summary reads idle, so the client only
  // learns it was queued from the response — the race where a sent bubble used to flash and vanish.
  await page.goto('/?staleBusy');
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');

  await composer.fill('raced follow-up');
  await composer.press('Enter');

  // It lands in the queue (cancellable), not as a sent transcript bubble.
  await expect(
    column.getByRole('button', { name: /Cancel queued message: raced follow-up/ })
  ).toBeVisible({ timeout: 10_000 });
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('raced follow-up');
});

test('a queued follow-up leaves the queue the moment it is placed', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = column.locator('textarea');
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });
  await composer.fill('placed follow-up');
  await composer.press('Enter');
  const queued = column.getByRole('button', { name: /Cancel queued message: placed follow-up/ });
  await expect(queued).toBeVisible({ timeout: 10_000 });

  // When the run ends the follow-up is placed: it lands in the transcript and leaves the queue
  // without waiting for a poll (the inbox_update invalidation refreshes the queue).
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('placed follow-up', { timeout: 20_000 });
  await expect(queued).toHaveCount(0, { timeout: 3_000 });
});

test('force-send (Alt+Enter) steers instead of joining the queue', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');

  // Make it busy, then park a follow-up so the composer is in queue mode.
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });
  await composer.fill('queued follow-up');
  await composer.press('Enter');
  await expect(
    column.getByRole('button', { name: /Cancel queued message: queued follow-up/ })
  ).toBeVisible({ timeout: 10_000 });

  // Alt+Enter force-sends now: it steers the running turn, so it renders in the transcript with a
  // note saying it is waiting for that turn — not as a queued follow-up. It *is* a real inbox item
  // though, so the strip lists it (labelled) and can withdraw it; nothing else in the row may
  // suggest it is still queued for a turn of its own.
  await composer.fill('steer this now');
  await composer.press('Alt+Enter');

  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('steer this now', { timeout: 10_000 });
  await expect(
    column.getByRole('button', { name: /Cancel queued message: steer this now/ })
  ).toHaveCount(0);
  await expect(
    column.getByRole('button', { name: /Withdraw the message waiting for the turn to pause: steer this now/ })
  ).toBeVisible({ timeout: 10_000 });
  expect(await column.getByText('Waiting for the turn to pause').count()).toBeGreaterThan(0);
  // The follow-up is still the only *queued* message, and it is untouched.
  await expect(
    column.getByRole('button', { name: /Cancel queued message: queued follow-up/ })
  ).toBeVisible();
});

test('a queued message can be sent now as a steer', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');

  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });
  await composer.fill('queued follow-up');
  await composer.press('Enter');

  // "Send now" takes it out of the inbox and steers it into the running turn.
  const sendNow = column.getByRole('button', { name: /Send queued message now: queued follow-up/ });
  await expect(sendNow).toBeVisible({ timeout: 10_000 });
  await sendNow.click();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('queued follow-up', { timeout: 10_000 });
  await expect(
    column.getByRole('button', { name: /Cancel queued message: queued follow-up/ })
  ).toHaveCount(0);
});

test('stopping a run interrupts the running step and shows `[step interrupted]`', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await column.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'List all tools' }).click();
  await page.keyboard.press('Escape');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');

  // A prompt that parks a long-running tool step.
  await composer.fill('please interrupt this');
  await composer.press('Enter');

  const stop = column.getByRole('button', { name: 'Stop generating' });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await stop.click();

  // The interrupted step reads as `[step interrupted]`, not a red error.
  await expect(column.getByText('[step interrupted]')).toBeVisible({ timeout: 10_000 });

  // The run is over (Hearth reports the conversation idle): the live activity line must stop
  // claiming it is thinking, without a follow-up message to shake it loose.
  await expect(column.getByText(/· thinking/)).toHaveCount(0);
  await expect(column.locator('span.animate-pulse')).toHaveCount(0);
});

/** A real 1×1 PNG, so the bytes are an image rather than a name that claims to be one. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

/** Drop a real file on a column, the way the composer's drag-and-drop path takes one. */
const dropFile = async (
  page: Page,
  target: Locator,
  name: string,
  type: string,
  base64 = ''
): Promise<void> => {
  const transfer = await page.evaluateHandle(
    ([fileName, mime, payload]) => {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([bytes], fileName, { type: mime }));
      return files;
    },
    [name, type, base64] as const
  );
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
};

/** Put a conversation into queue mode with a scripted slow turn. */
const queueMode = async (page: Page, column: Locator): Promise<Locator> => {
  const composer = column.locator('textarea');
  await composer.fill('slow test');
  await composer.press('Enter');
  await expect(column.locator('textarea[aria-label="Queue a follow-up message"]')).toBeVisible({ timeout: 15_000 });
  return composer;
};

test('an attached image rides a queued follow-up and keeps its file', async ({ page }) => {
  // `?staleBusy` parks the message in Hearth's inbox and leaves it there, so the row is read back
  // from the queue rather than from the optimistic local copy.
  await page.goto('/?staleBusy');
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = column.locator('textarea');
  await expect(column).toBeVisible();

  await dropFile(page, column.getByRole('log', { name: 'Conversation' }), 'shot.png', 'image/png', TINY_PNG);
  await expect(column.getByRole('button', { name: 'Remove shot.png' })).toBeVisible();

  await composer.fill('queued with a picture');
  await composer.press('Enter');

  const row = column.getByRole('button', { name: /Cancel queued message: queued with a picture/ });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // The row is Hearth's own, so its file badge means the image rode the submission as content parts
  // and came back on the queue with them.
  const files = column.getByText('1 file', { exact: true });
  await expect(files).toBeVisible();
  // A queue poll refreshes rows from Hearth; the attachment must not fall off it.
  await page.waitForTimeout(5_000);
  await expect(row).toBeVisible();
  await expect(files).toBeVisible();
  // A queued message is not a sent one.
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('queued with a picture');
  await expect(column.getByText('Could not queue this message.')).toHaveCount(0);
});

test('a queued image can be sent now, picture and all', async ({ page }) => {
  await page.goto('/?staleBusy');
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = column.locator('textarea');
  await expect(column).toBeVisible();

  await dropFile(page, column.getByRole('log', { name: 'Conversation' }), 'shot.png', 'image/png', TINY_PNG);
  await composer.fill('send this now');
  await composer.press('Enter');
  const row = column.getByRole('button', { name: /Cancel queued message: send this now/ });
  await expect(row).toBeVisible({ timeout: 10_000 });

  await column.getByRole('button', { name: /Send queued message now: send this now/ }).click();

  // Taking a queued message out of the queue and sending it must carry the picture with it: the
  // transcript shows the turn and the image the row was holding.
  const log = column.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('send this now');
  await expect(log.getByRole('img', { name: 'image.png' })).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveCount(0);
});

test('a file that is not an image is refused by name, in the queue as well as the send', async ({ page }) => {
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const composer = await queueMode(page, column);

  await dropFile(page, column.getByRole('log', { name: 'Conversation' }), 'notes.txt', 'text/plain');
  await composer.fill('queued with a file');
  await composer.press('Enter');

  // The failed row names the real reason. It used to say only "Could not queue this message.",
  // which is what made an image attachment look like an unexplained queue bug.
  const reason = column.getByText(/Only images can be attached/);
  await expect(reason).toBeVisible({ timeout: 10_000 });
  await expect(reason).toContainText('notes.txt');
  await expect(column.getByText('Could not queue this message.')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Only images can be attached');
});

test('sending works in an insecure HTTP context where crypto.randomUUID and navigator.clipboard are absent', async ({ page }) => {
  // Over Tailscale HTTP (http://100.x.y.z:57821), browsers do not expose crypto.randomUUID or
  // navigator.clipboard. Strip both before the app boots and confirm a submit still succeeds.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(Navigator.prototype, 'clipboard', { value: undefined, configurable: true });
  });
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  expect(await page.evaluate(() => typeof navigator.clipboard)).toBe('undefined');

  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const composer = column.locator('textarea');
  await composer.fill('hello over tailscale');
  await composer.press('Enter');
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Hello! ember-harness is listening.');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
