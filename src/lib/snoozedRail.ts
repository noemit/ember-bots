import { isWorker } from './crew';
import { sessionKey, type Session } from '../types';

/** Snooze changes only rail placement, never visibility, group membership or host state. */
export function splitSnoozedRail(
  recent: Session[],
  all: Session[],
  snoozedKeys: ReadonlySet<string>,
  selectedKey: string | null,
  docked: boolean,
): { main: Session[]; snoozed: Session[] } {
  const eligible = (session: Session) => !session.archived && !isWorker(session);
  const unique = (sessions: Session[]) => [...new Map(sessions.map(session => [sessionKey(session), session])).values()];
  return {
    main: unique(recent).filter(session => eligible(session) &&
      (!snoozedKeys.has(sessionKey(session)) || (!docked && sessionKey(session) === selectedKey)) &&
      (!docked || sessionKey(session) !== selectedKey)),
    snoozed: unique([...all, ...recent]).filter(session => eligible(session) && snoozedKeys.has(sessionKey(session)))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0) || sessionKey(a).localeCompare(sessionKey(b))),
  };
}
