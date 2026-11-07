/**
 * A 200 that is not a list is not an empty list.
 *
 * The transport (`electron/piClient.ts`) hands back whatever the host said, with `ok` from the HTTP
 * status — so a proxy's HTML error page, a captive portal, `null`, `{error}`, a number or a body cut
 * short all arrive as `ok: true, status: 200`. `parseConversations` used to coerce all of them to
 * `[]`, which `mergePolledSessions` believed (it is authoritative for membership), and the rail for
 * that instance emptied with no error anywhere. These tests pin the rule: only a body that *is* a
 * list may clear a list.
 */
import { expect, test } from 'bun:test';
import {
  loadAllSessions,
  loadAutoAcceptPolicy,
  loadMessageQueue,
  loadPermissions,
  loadQuestions,
  loadSessionStates,
  loadSessions,
  mergePolledSessions,
} from '../src/api';
import { piLoadScheduledTasks, rememberPiInstances } from '../src/piApi';
import type { Session } from '../src/types';

const ENDPOINT = 'pi:hearth';

/** Bodies that are real shapes seen from a proxy, a restart mid-response, or an error path. */
const NOT_A_LIST: Array<{ label: string; body: unknown }> = [
  { label: 'an HTML error page', body: '<!doctype html><title>502 Bad Gateway</title>' },
  { label: 'null', body: null },
  { label: 'an { error } object', body: { error: 'database is locked' } },
  { label: 'a number', body: 42 },
  { label: 'a truncated body', body: '[{"id":1,"tit' },
  { label: 'a null field', body: { conversations: null } },
];

/** Point the bridge at one fixed body for every path. */
const respondWith = (body: unknown, ok = true, status = 200) => {
  (globalThis as { window?: unknown }).window = {
    ember: {
      piRequest: async () => ({ ok, status, data: body }),
    },
  };
  rememberPiInstances([{ id: ENDPOINT, kind: 'pi' }]);
};

const conversation = (id: number, title: string) => ({
  id,
  title,
  cwd: '/work',
  updatedAt: 1_700_000_000_000,
});

/** What App holds after a good poll. */
const previous: Record<string, Session[]> = {
  [ENDPOINT]: [
    { id: '1', instanceId: ENDPOINT, title: 'Real work', updated: 1_700_000_000_000 },
    { id: '2', instanceId: ENDPOINT, title: 'Also real', updated: 1_699_000_000_000 },
  ],
};

test('a genuine conversation list still parses', async () => {
  respondWith({ conversations: [conversation(1, 'Real work'), conversation(2, 'Also real')] });
  const sessions = await loadSessions(ENDPOINT);
  expect(sessions?.map((session) => session.id)).toEqual(['1', '2']);
  expect(sessions?.[0].title).toBe('Real work');
});

test('a genuinely empty list is success, and means no sessions', async () => {
  respondWith({ conversations: [] });
  const sessions = await loadSessions(ENDPOINT);
  expect(sessions).toEqual([]);
  // A host that answered "none" is allowed to empty the rail.
  const merged = mergePolledSessions(previous, { [ENDPOINT]: sessions ?? [] }, []);
  expect(merged[ENDPOINT]).toEqual([]);
});

for (const { label, body } of NOT_A_LIST) {
  test(`a body that is not a conversation list is no answer: ${label}`, async () => {
    respondWith(body);
    // null is the api layer's "no answer" contract everywhere else in this file's callers.
    expect(await loadSessions(ENDPOINT)).toBeNull();
    expect(await loadSessionStates(ENDPOINT)).toBeNull();
    expect(await loadAutoAcceptPolicy(ENDPOINT)).toBeNull();

    // …and the list Ember already had survives the poll: no empty array ever reaches the merge.
    const polled = await loadAllSessions([ENDPOINT]);
    expect(polled[ENDPOINT]).toBeUndefined();
    const merged = mergePolledSessions(previous, polled, []);
    expect(merged[ENDPOINT].map((session) => session.id)).toEqual(['1', '2']);
  });
}

test('the other pi lists follow the same rule', async () => {
  // A queue body without a sessions array must not withdraw every queued row.
  respondWith({ revision: 9, error: 'not a queue' });
  expect(await loadMessageQueue(ENDPOINT)).toBeNull();
  // A parked approval or question is what the agent is blocked on: only an answer may clear it.
  respondWith({ error: 'not approvals' });
  expect(await loadPermissions(ENDPOINT)).toBeNull();
  respondWith({ error: 'not questions' });
  expect(await loadQuestions(ENDPOINT)).toBeNull();
  // The scheduled view is replaced wholesale, so an empty list has to be an answer.
  respondWith({ error: 'not tasks' });
  expect(await piLoadScheduledTasks(ENDPOINT)).toBeNull();
});

test('an empty queue is still an empty queue', async () => {
  respondWith({ revision: 3, sessions: [] });
  const queue = await loadMessageQueue(ENDPOINT);
  expect(queue?.sessions).toEqual([]);
});

test('a failed request keeps its old meaning too', async () => {
  respondWith({ conversations: [conversation(1, 'Real work')] }, false, 500);
  expect(await loadSessions(ENDPOINT)).toBeNull();
});
