/**
 * How the configured Hearth endpoints stand, and what an empty list should therefore say.
 *
 * The rule this module exists for: **a host that did not answer must never look like a host with
 * nothing in it.** Before this, every list (rail, palette, archive, Home) was built from the
 * `attachable` instances only, so an outage subtracted a host's sessions from every surface at once
 * and each empty state confidently asserted absence — "No instances connected." / "No sessions or
 * commands match." / "No archived sessions." / "Everything is idle". The rail then showed exactly
 * one session, the open one (pinned back in), which reads as "the rest were deleted".
 *
 * Two things fix that, and both are pure so the wording is pinned by tests:
 *
 * - `silentInstances` — the configured hosts that are not answering, each with the sessions Ember
 *   still lists from its last answer. App keeps those sessions in `sessionsByInstance` (a failed
 *   poll only ever *adds* to that map: `loadAllSessions` omits instances that did not answer), so
 *   the render just stops filtering them out.
 * - `endpointState` — the three cases an empty list can mean, kept apart rather than collapsed into
 *   "nothing here": nothing configured, configured and none answering, or answered with nothing.
 *
 * A warning row is the rail's one honest statement about a host that is down, which is exactly why
 * it can be **dismissed** and not only read: a laptop that slept or a Hearth restarting otherwise
 * leaves one above every session for good. See `reconcileOutageDismissals` for the rule that stops
 * a dismissal outliving its outage.
 */
import type { Instance, Session } from '../types';
import { isWorker } from './crew';

/**
 * What the configured endpoints amount to:
 *
 * - `no-endpoints`: nothing is configured yet — the one case where "add an endpoint" is the fix.
 * - `checking`: at least one probe is still out, so Ember does not know yet. Not a fault.
 * - `no-answers`: endpoints exist and none of them is answering.
 * - `connected`: at least one answered, so an empty list is a real (if partial) answer.
 */
export type EndpointState = 'no-endpoints' | 'checking' | 'no-answers' | 'connected';

/**
 * The one answer to "is this host usable right now?" — the top bar's dot and count, the dropdown's
 * per-row dot, and the rail's `New agent on…` menu all read this, so they can never disagree.
 *
 * It keys off `status`, not `attachable`. `attachable` means "listed in the settings file", so
 * during a probe a host is `attachable: true` while its `status` is still `unreachable`; a surface
 * that treated `attachable` as "connected" said `1/1 instances` with a green dot above a dropdown
 * reading "not connected, check the instance" for the very same host.
 */
export const instanceReady = (instance: Instance): boolean => instance.status === 'ready';

/** How many configured hosts are ready — the numerator of the top bar's `n/total instances`. */
export const readyInstanceCount = (instances: readonly Instance[]): number =>
  instances.filter(instanceReady).length;

export const endpointState = (instances: readonly Instance[]): EndpointState => {
  if (instances.length === 0) return 'no-endpoints';
  if (instances.some((instance) => instance.attachable)) return 'connected';
  if (instances.some((instance) => instance.status === 'checking')) return 'checking';
  return 'no-answers';
};

/** A configured host Ember cannot list sessions from right now. */
export type SilentInstance = {
  instanceId: string;
  /** The host's display label, which is what the row names. */
  label: string;
  status: 'unreachable' | 'unsupported';
  /**
   * Sessions Ember still shows from this host's last answer (crew workers excluded — they are
   * never rail rows). Zero means Ember has no last-known list, which is a different sentence.
   */
  listedSessions: number;
};

/**
 * The configured hosts whose sessions are last-known only, newest silent host first (the order
 * App shows instances in, so the rows match the Instances menu).
 *
 * `exclude` is the instance ids the user has switched off in the Instances menu: a host they hid
 * on purpose should not raise a warning row. `dismissed` is the ids of hosts whose *outage* they
 * silenced (see `reconcileOutageDismissals`). It only ever suppresses the "Not answering" row,
 * never the "Sessions unavailable" one: that one is a settings problem, and silence cannot fix it.
 */
export const silentInstances = (
  instances: readonly Instance[],
  sessions: readonly Session[],
  exclude?: ReadonlySet<string>,
  dismissed?: ReadonlySet<string>
): SilentInstance[] => {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (isWorker(session) || exclude?.has(session.instanceId)) continue;
    counts.set(session.instanceId, (counts.get(session.instanceId) ?? 0) + 1);
  }
  return instances
    .filter(
      (instance) =>
        !instance.attachable &&
        instance.status !== 'checking' &&
        !exclude?.has(instance.id) &&
        !(instance.status === 'unreachable' && dismissed?.has(instance.id))
    )
    .map((instance) => ({
      instanceId: instance.id,
      label: instance.label || instance.url || instance.id,
      status: instance.status === 'unsupported' ? ('unsupported' as const) : ('unreachable' as const),
      listedSessions: counts.get(instance.id) ?? 0,
    }));
};

/**
 * Which dismissals still stand, given what the hosts are doing now.
 *
 * The rule: **a dismissal survives the outage, not the recovery.** It is cleared once the host
 * answers again — `ready` or `unsupported`, both are answers — so the next time it goes down the
 * warning is back, and the person is told once per outage rather than once per blip. Nothing else
 * clears it: a probe still out (`checking`) and a host missing from the instance list are both
 * *unknown*, and reading unknown as recovery would re-show every dismissed row on launch, which is
 * the exact bug this feature exists for.
 *
 * Returns the same array when nothing changed, so a caller can skip the settings write on identity.
 */
export const reconcileOutageDismissals = (
  dismissed: string[],
  instances: readonly Instance[]
): string[] => {
  const next = dismissed.filter((id) => {
    const instance = instances.find((entry) => entry.id === id);
    if (!instance) return true;
    return instance.status === 'unreachable' || instance.status === 'checking';
  });
  return next.length === dismissed.length ? dismissed : next;
};

/** One sentence naming the host's state, and one saying what the list below it is. */
export const outageCopy = (entry: SilentInstance): { status: string; detail: string; retryable: boolean } => {
  if (entry.status === 'unsupported') {
    // `retryable: false`: this host answered — it just can't serve sessions — so probing again
    // cannot help and pointing at Retry would be a dead end. The settings it names can.
    return {
      status: 'Sessions unavailable',
      retryable: false,
      detail:
        entry.listedSessions > 0
          ? `This connection can’t list its sessions — these ${count(entry.listedSessions, 'session')} are from its last answer. Check the endpoint’s settings.`
          : 'This connection can’t list its sessions. Check the endpoint’s settings.',
    };
  }
  return {
    status: 'Not answering',
    retryable: true,
    detail:
      entry.listedSessions > 0
        ? `Still listing the ${count(entry.listedSessions, 'session')} from its last answer. It may be asleep or off the network.`
        : 'Its sessions aren’t listed right now. It may be asleep or off the network.',
  };
};

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const endpoints = (n: number): string => `${n} ember-harness endpoint${n === 1 ? '' : 's'}`;

const verb = (n: number): string => (n === 1 ? 'is' : 'are');

/**
 * The rail's empty state. Four cases, each named: no endpoints, still checking, none answering,
 * and answered-but-empty. `query`/`windowLabel` only refine the last one, because
 * "nothing matched your search" is a true statement about a host that did answer and a false one
 * about a host that did not.
 */
export const railEmptyCopy = (input: {
  state: EndpointState;
  endpointCount: number;
  query?: string | null;
  windowLabel?: string | null;
}): string => {
  const { state, endpointCount } = input;
  if (state === 'no-endpoints') {
    return 'No ember-harness endpoints yet. Add one in Settings → Instances and its sessions will appear here.';
  }
  if (state === 'checking') {
    return 'Checking your ember-harness endpoints — this takes a moment.';
  }
  if (state === 'no-answers') {
    // Names the control rather than a position: an outage row can be dismissed, so "Retry above"
    // would point at nothing in the very case that leaves this list empty.
    return `No sessions to show: none of your ${endpoints(endpointCount)} ${verb(endpointCount)} answering. Choose Reprobe instances in the Instances menu once a host is back, or check Settings → Instances.`;
  }
  const query = input.query?.trim();
  if (query) return `No sessions match “${query}”.`;
  if (input.windowLabel) {
    return `No sessions active in the ${input.windowLabel.toLowerCase()}. Widen the window in Settings.`;
  }
  return 'This endpoint answered and has no sessions yet.';
};

/** The command palette's empty line. */
export const paletteEmptyCopy = (input: {
  state: EndpointState;
  endpointCount: number;
  query: string;
}): string => {
  const { state, endpointCount, query } = input;
  if (state === 'no-endpoints') {
    return 'Nothing to search yet — add an ember-harness endpoint in Settings → Instances.';
  }
  if (state === 'checking') return 'Waiting for your ember-harness endpoints to answer — then this list fills in.';
  if (state === 'no-answers') {
    return `Your ${endpoints(endpointCount)} ${verb(endpointCount)} not answering, so there is nothing to search. Retry from the Instances menu once a host is back.`;
  }
  return `No sessions or commands match “${query.trim()}”.`;
};

/** The archive screen's empty line. */
export const archiveEmptyCopy = (input: { state: EndpointState; endpointCount: number }): string => {
  const { state, endpointCount } = input;
  if (state === 'no-endpoints') {
    return 'No ember-harness endpoints yet, so there is nothing to archive. Add one in Settings → Instances.';
  }
  if (state === 'checking') return 'Waiting for your ember-harness endpoints to answer — archived sessions appear here after that.';
  if (state === 'no-answers') {
    return `Your ${endpoints(endpointCount)} ${verb(endpointCount)} not answering, so Ember can’t list archived sessions. Retry from the Instances menu once a host is back.`;
  }
  return 'Nothing archived here. Sessions you archive show up in this list.';
};

/** The Home screen's one-line status, when it has no cards to count. */
export const activityIdleCopy = (input: { state: EndpointState; endpointCount: number }): string => {
  const { state, endpointCount } = input;
  if (state === 'no-endpoints') return 'No endpoints yet';
  if (state === 'checking') return 'Waiting for your ember-harness endpoints to answer';
  if (state === 'no-answers') {
    return `Your ${endpoints(endpointCount)} ${verb(endpointCount)} not answering`;
  }
  return 'Everything is idle';
};

/** The Home screen's empty timeline line. */
export const activityEmptyCopy = (input: { state: EndpointState; endpointCount: number }): string => {
  const { state, endpointCount } = input;
  if (state === 'no-answers') {
    return `No activity to show — your ${endpoints(endpointCount)} ${verb(endpointCount)} not answering, so Ember can’t record milestones. Retry from the Instances menu once a host is back.`;
  }
  if (state === 'checking') {
    return 'No activity to show yet — Ember records milestones as your ember-harness hosts answer.';
  }
  if (state === 'no-endpoints') {
    return 'No activity recorded yet — add an ember-harness endpoint in Settings → Instances, then run an agent.';
  }
  return 'No activity recorded yet — run an agent and milestones will land here.';
};
