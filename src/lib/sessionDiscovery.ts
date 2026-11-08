import type { Session } from '../types';

export type SessionDiscoveryBaseline = {
  seenIds: ReadonlySet<string>;
  /** A complete, unfiltered host-wide list has established the existing-id baseline. */
  completeSnapshot: boolean;
};
export type SessionDiscoveryOptions = {
  /** Only for a host-wide response including archived chats and hidden workers, without pagination. */
  completeSnapshot?: boolean;
};
export type SessionDiscoveryState = Readonly<Record<string, SessionDiscoveryBaseline>>;

/**
 * Call only for successful list responses (including successful empty lists), never failed requests
 * or placeholder arrays. Pass the response's instance, not all merged cached sessions. Retain this
 * state for the application lifetime; reconnecting must not reset a host's baseline.
 *
 * Absence from a COMPLETE baseline establishes novelty without timestamps or clock assumptions.
 * The first complete list after partial lists re-baselines all ids, offering none. Never claim
 * completeness for directory-scoped lists or lists that filtered out archived chats/workers.
 * Partial lists never offer candidates: absence from a page is not evidence of creation.
 *
 * Baseline and ineligible ids become seen, so unarchiving, promoting, or later receiving metadata
 * cannot turn an existing chat into a new one. Eligible ids are NOT consumed: each complete response
 * offers them again until the caller stores an assignment. This permits deferring while a local
 * create is pending. Local create responses use the separate explicit-create path.
 */
export const observeSessionDiscovery = (
  state: SessionDiscoveryState,
  instanceId: string,
  sessions: readonly Session[],
  options: SessionDiscoveryOptions = {},
): { state: SessionDiscoveryState; eligible: Session[] } => {
  const baseline = Object.hasOwn(state, instanceId) ? state[instanceId] : undefined;
  const seenIds = new Set(baseline?.seenIds);
  const completeEvidence = options.completeSnapshot === true && baseline?.completeSnapshot === true;
  const eligible: Session[] = [];
  const offered = new Set<string>();
  for (const session of sessions) {
    if (session.instanceId !== instanceId || seenIds.has(session.id) || offered.has(session.id)) continue;
    if (completeEvidence
      && !session.archived && session.kind !== 'worker' && !session.parentId
      && (!session.lead || session.kind === 'peer')) {
      eligible.push(session);
      offered.add(session.id);
    } else {
      seenIds.add(session.id);
    }
  }
  return {
    state: {
      ...state,
      [instanceId]: {
        seenIds,
        completeSnapshot: baseline?.completeSnapshot === true || options.completeSnapshot === true,
      },
    },
    eligible,
  };
};
