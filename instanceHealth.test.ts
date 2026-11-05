/**
 * C2 (audit): an outage used to render as deletion.
 *
 * Every list was built from `attachable` instances only, so a configured-but-silent host's sessions
 * vanished from the rail, palette, archive and Home at once, and every empty state asserted absence
 * — including the rail's "No instances connected. Add a Hearth endpoint in Settings, then refresh.",
 * which is wrong (the endpoint exists) and invites a fix that cannot help.
 *
 * The two pure halves are pinned here: which hosts are silent (and how many sessions Ember still
 * lists from each), and what an empty list means in each of the three cases.
 */
import { describe, expect, test } from 'bun:test';
import {
  activityEmptyCopy,
  activityIdleCopy,
  archiveEmptyCopy,
  endpointState,
  instanceReady,
  outageCopy,
  paletteEmptyCopy,
  railEmptyCopy,
  readyInstanceCount,
  reconcileOutageDismissals,
  silentInstances,
} from './src/lib/instanceHealth';
import type { Instance, Session } from './src/types';

const instance = (over: Partial<Instance> & { id: string }): Instance => ({
  label: over.id,
  kind: 'pi',
  status: 'unreachable',
  attachable: false,
  ...over,
});

const session = (over: Partial<Session> & { id: string; instanceId: string }): Session => ({
  title: over.id,
  ...over,
});

const host = instance({ id: 'pi:keep', label: 'Keep' });

describe('endpointState keeps the three empty cases apart', () => {
  test('nothing configured', () => {
    expect(endpointState([])).toBe('no-endpoints');
  });

  test('configured, none answering', () => {
    expect(endpointState([host, instance({ id: 'pi:tower', status: 'unreachable' })])).toBe('no-answers');
    // An endpoint the host itself refuses to serve is still an endpoint that does not answer.
    expect(endpointState([instance({ id: 'pi:x', status: 'unsupported' })])).toBe('no-answers');
  });

  test('a probe still out is not a fault', () => {
    expect(endpointState([instance({ id: 'pi:x', status: 'checking' })])).toBe('checking');
  });

  test('one host answered, so an empty list is an answer', () => {
    expect(
      endpointState([instance({ id: 'pi:x', status: 'ready', attachable: true }), host])
    ).toBe('connected');
  });
});

describe('silentInstances names the host and counts what is still listed', () => {
  const sessions = [
    session({ id: '1', instanceId: 'pi:keep' }),
    session({ id: '2', instanceId: 'pi:keep', archived: true }),
    session({ id: '3', instanceId: 'pi:keep', kind: 'worker' }),
    session({ id: '4', instanceId: 'pi:tower' }),
  ];

  test('one entry per unreachable configured host, with its listed sessions', () => {
    const rows = silentInstances([host, instance({ id: 'pi:tower', label: 'Tower', attachable: true, status: 'ready' })], sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].instanceId).toBe('pi:keep');
    expect(rows[0].label).toBe('Keep');
    // Workers are never rail rows, so they cannot be counted as hidden siblings.
    expect(rows[0].listedSessions).toBe(2);
  });

  test('a host Ember has never heard from simply reports nothing listed', () => {
    const rows = silentInstances([host], []);
    expect(rows[0].listedSessions).toBe(0);
  });

  test('a host the user switched off is hidden on purpose, not silent', () => {
    expect(silentInstances([host], sessions, new Set(['pi:keep']))).toEqual([]);
  });

  test('a probe still out raises no outage row', () => {
    expect(silentInstances([instance({ id: 'pi:x', status: 'checking' })], [])).toEqual([]);
  });

  test('the row copy names the state, says what the list below it is, and flags whether Retry helps', () => {
    const [listed] = silentInstances([host], sessions);
    const withSessions = outageCopy(listed);
    expect(withSessions.status).toMatch(/not answering/i);
    expect(withSessions.detail).toContain('2 sessions');
    // The recovery that exists is the Retry button beside this copy.
    expect(withSessions.retryable).toBe(true);
    // Says what the reader can conclude, rather than only that something failed.
    expect(withSessions.detail).toMatch(/asleep|network/i);
    // Never a claim of deletion.
    expect(withSessions.detail.toLowerCase()).not.toMatch(/deleted|removed|no sessions/);
    const [empty] = silentInstances([host], []);
    expect(outageCopy(empty).detail.toLowerCase()).toMatch(/not listed|aren.t listed/);
    expect(outageCopy(empty).retryable).toBe(true);
    // A host that answered and can't serve sessions has a settings problem: Retry is a dead end.
    const unsupported = outageCopy({
      instanceId: 'local:relay',
      label: 'Private relay',
      status: 'unsupported',
      listedSessions: 0,
    });
    expect(unsupported.retryable).toBe(false);
    expect(unsupported.detail).toMatch(/settings/i);
  });
});

describe('a dismissed outage warning', () => {
  const sessions = [session({ id: '1', instanceId: 'pi:keep' })];

  test('hides the row and leaves the host\'s sessions exactly where they were', () => {
    expect(silentInstances([host], sessions, undefined, new Set(['pi:keep']))).toEqual([]);
    // Nothing else about the host is affected: the count a *different* host still lists is intact,
    // which is what stops a dismissal from reading as a deletion one row over.
    const tower = instance({ id: 'pi:tower', label: 'Tower' });
    const both = silentInstances(
      [host, tower],
      [...sessions, session({ id: '9', instanceId: 'pi:tower' })],
      undefined,
      new Set(['pi:keep'])
    );
    expect(both.map((entry) => entry.instanceId)).toEqual(['pi:tower']);
    expect(both[0].listedSessions).toBe(1);
  });

  test('never silences a settings problem, which silence cannot fix', () => {
    const unsupported = instance({ id: 'pi:keep', status: 'unsupported' });
    const rows = silentInstances([unsupported], sessions, undefined, new Set(['pi:keep']));
    expect(rows.map((entry) => entry.instanceId)).toEqual(['pi:keep']);
  });

  test('is cleared by the host answering again, so the next outage warns', () => {
    const answered = instance({ id: 'pi:keep', status: 'ready', attachable: true });
    expect(reconcileOutageDismissals(['pi:keep'], [answered])).toEqual([]);
    // `unsupported` is an answer too: the host is up, so the outage the person dismissed is over.
    expect(reconcileOutageDismissals(['pi:keep'], [instance({ id: 'pi:keep', status: 'unsupported' })])).toEqual([]);
  });

  test('survives the outage, the relaunch and a probe that is still out', () => {
    expect(reconcileOutageDismissals(['pi:keep'], [host])).toEqual(['pi:keep']);
    // Unknown is not recovery: a probe still out, or an instance list that has not loaded yet,
    // would otherwise re-show every dismissed row on the launch after it was dismissed.
    expect(reconcileOutageDismissals(['pi:keep'], [instance({ id: 'pi:keep', status: 'checking' })])).toEqual(['pi:keep']);
    expect(reconcileOutageDismissals(['pi:keep'], [])).toEqual(['pi:keep']);
  });

  test('reports "nothing changed" by identity, so a caller can skip the settings write', () => {
    const dismissed = ['pi:keep'];
    expect(reconcileOutageDismissals(dismissed, [host])).toBe(dismissed);
    expect(reconcileOutageDismissals([], [host])).toEqual([]);
    expect(reconcileOutageDismissals(['pi:keep'], [instance({ id: 'pi:keep', status: 'ready' })])).not.toBe(
      dismissed
    );
  });
});

describe('the three empty states are three different sentences', () => {
  const copy = (state: 'no-endpoints' | 'checking' | 'no-answers' | 'connected', endpointCount = 2): string =>
    railEmptyCopy({ state, endpointCount });

  test('each case names which one it is, and they are all distinct', () => {
    const sentences = [copy('no-endpoints'), copy('no-answers'), copy('connected'), copy('checking')];
    expect(new Set(sentences).size).toBe(4);
  });

  test('"no endpoints" is the only case that offers to add one', () => {
    expect(copy('no-endpoints')).toMatch(/add one|settings/i);
    // The old copy said this whenever nothing was connected, which invited re-adding an endpoint
    // that already existed. Neither of the other two cases may say it.
    expect(copy('no-answers')).not.toMatch(/add an? ember-harness endpoint|add one/i);
    expect(copy('connected')).not.toMatch(/add an? ember-harness endpoint|add one/i);
  });

  test('"none answering" names the hosts, counts them, and names the recovery that exists', () => {
    const text = copy('no-answers');
    expect(text).toMatch(/2 ember-harness endpoints/);
    // The control by its label, not by where it sits: every outage row can be dismissed, so this
    // sentence has to hold with no Retry button anywhere on screen.
    expect(text).toMatch(/Reprobe instances/i);
    // Never claims the endpoint is missing, and never claims anything was deleted.
    expect(text.toLowerCase()).not.toMatch(/deleted|removed|no instances connected/);
  });

  test('"answered and empty" never blames the host', () => {
    const text = copy('connected');
    expect(text.toLowerCase()).not.toMatch(/answering|not connected|unreachable/);
  });

  test('a search that finds nothing on a silent host does not claim there is nothing to find', () => {
    const searching = railEmptyCopy({ state: 'no-answers', endpointCount: 1, query: 'habit' });
    expect(searching).toMatch(/1 ember-harness endpoint /);
    expect(searching).toMatch(/reprobe/i);
    // The connected case still answers the query it was given.
    expect(railEmptyCopy({ state: 'connected', endpointCount: 1, query: 'habit' })).toContain('habit');
  });

  test('no shouting and no jargon anywhere', () => {
    const all = [
      copy('no-endpoints'),
      copy('no-answers'),
      copy('connected'),
      copy('checking'),
      paletteEmptyCopy({ state: 'no-answers', endpointCount: 3, query: 'x' }),
      paletteEmptyCopy({ state: 'connected', endpointCount: 3, query: 'x' }),
      archiveEmptyCopy({ state: 'no-answers', endpointCount: 3 }),
      activityEmptyCopy({ state: 'no-answers', endpointCount: 3 }),
      activityIdleCopy({ state: 'no-answers', endpointCount: 3 }),
    ];
    for (const text of all) {
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\b(4\d\d|5\d\d|undefined|null|error:|fetch)\b/i);
      expect(text.length).toBeGreaterThan(20);
    }
  });

  test('the palette, archive and Home say the same thing in their own register', () => {
    expect(paletteEmptyCopy({ state: 'no-answers', endpointCount: 1, query: 'x' })).toMatch(/not answering/i);
    expect(archiveEmptyCopy({ state: 'no-answers', endpointCount: 1 })).toMatch(/not answering/i);
    expect(activityEmptyCopy({ state: 'no-answers', endpointCount: 1 })).toMatch(/retry/i);
    // Home's one-liner used to read "Everything is idle" during an outage.
    expect(activityIdleCopy({ state: 'no-answers', endpointCount: 1 })).not.toMatch(/idle/i);
    expect(activityIdleCopy({ state: 'connected', endpointCount: 1 })).toMatch(/idle/i);
  });
});

/**
 * S4-3: one predicate for "is this host usable", so no two surfaces can answer differently.
 *
 * `attachable` means "listed in the settings file", not "answering" — during a probe (and after a
 * failed one) a host is `attachable: true` with `status: 'unreachable'`. The top bar counted
 * `attachable` and said `1/1 instances` with a green dot, while the dropdown for the same host drew
 * a grey dot and "not connected, check the instance".
 */
describe('a host is ready only when its status says so', () => {
  test('a probe grace period is not ready, however attachable it is', () => {
    const probing = instance({ id: 'pi:grace', status: 'unreachable', attachable: true });
    expect(instanceReady(probing)).toBe(false);
    expect(readyInstanceCount([probing])).toBe(0);
    // The dropdown's own per-row copy agrees: this is the status the row renders.
    expect(probing.status).not.toBe('ready');
  });

  test('ready is ready, whatever attachable says', () => {
    expect(instanceReady(instance({ id: 'pi:x', status: 'ready', attachable: true }))).toBe(true);
    expect(instanceReady(instance({ id: 'pi:y', status: 'ready', attachable: false }))).toBe(true);
    expect(instanceReady(instance({ id: 'pi:z', status: 'checking' }))).toBe(false);
    expect(instanceReady(instance({ id: 'pi:u', status: 'unsupported' }))).toBe(false);
  });

  test('the count the top bar prints matches the rows the dropdown would show as connected', () => {
    const hosts = [
      instance({ id: 'a', status: 'ready', attachable: true }),
      // The one the old `attachable` count got wrong.
      instance({ id: 'b', status: 'unreachable', attachable: true }),
      instance({ id: 'c', status: 'checking', attachable: false }),
    ];
    expect(readyInstanceCount(hosts)).toBe(1);
    expect(hosts.filter((host) => host.status === 'ready')).toHaveLength(1);
  });

  test('an empty list is zero, not NaN', () => {
    expect(readyInstanceCount([])).toBe(0);
  });
});
