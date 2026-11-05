import { projectForSession, projectIdentityKey } from '../blob/seed';
import { isWorker } from './crew';
import { sessionKey } from '../types';
import type { Project, Session, SessionGroup } from '../types';

export type ProjectEntry = {
  kind: 'project';
  /** `projectIdentityKey(instanceId, project.id)`. */
  id: string;
  instanceId: string;
  project: Project;
  /** Active sessions in the project, most recent first. */
  sessions: Session[];
  /** Most recent session activity, or the project's last-opened time when empty. */
  updated: number;
};

export type SessionEntry = {
  kind: 'session';
  /** `sessionKey(session)`. */
  id: string;
  session: Session;
  updated: number;
};

/**
 * A group of agents that can span instances and projects. It outranks the project of any member, so a
 * grouped session leaves its project card and appears only here.
 */
export type GroupEntry = {
  kind: 'group';
  id: string;
  name: string;
  /**
   * The group's configured keys, exactly as saved — including ones that resolve to no session right
   * now (an unreachable instance, a session outside the loaded window). Never derived from
   * `members`: a member that cannot be read is still a member, and the Manage panel saves this list
   * back, so deriving it would quietly drop those keys.
   */
  keys: string[];
  /** Resolved members, most recent first. */
  members: Session[];
  /** Distinct instance ids among the resolved members, for the row's badges. */
  instanceIds: string[];
  /**
   * The member new agents for this group default to. The configured key is kept even when it does
   * not resolve (so an outage cannot re-point the group); only a key that is no longer configured
   * falls back to the most recent resolved member.
   */
  primaryKey?: string;
  updated: number;
};

export type RailEntry = ProjectEntry | SessionEntry | GroupEntry;

/** The draft the Manage panel opens with. */
export type GroupDraftSeed = {
  id: string;
  name: string;
  /** The configured keys, resolved or not — see `GroupEntry.keys`. */
  keys: string[];
  primaryKey?: string;
};

/**
 * Seed the Manage panel from a rail entry. The configured key list is copied as it stands: a member
 * whose instance is not answering has no session to resolve to, and rebuilding the list from
 * `members` is what used to drop it (and then save the shorter list back).
 */
export const groupDraftFromEntry = (entry: GroupEntry): GroupDraftSeed => ({
  id: entry.id,
  name: entry.name,
  keys: [...entry.keys],
  primaryKey: entry.primaryKey,
});

const byRecency = (a: Session, b: Session) => (b.updated ?? 0) - (a.updated ?? 0);

const nameOf = (entry: RailEntry): string =>
  entry.kind === 'group'
    ? entry.name
    : entry.kind === 'project'
      ? entry.project.name
      : entry.session.title ?? entry.session.id;

/**
 * Builds the rail's single recency-ordered list. Sessions that sit inside a configured project
 * (`projectForSession`) group under that project's card; everything else stays a standalone row.
 * Project cards and standalone rows interleave by most-recent activity.
 *
 * Only projects that own at least one of the given sessions appear: an empty project has nothing
 * to open, and starting one is the New-agent flow's job. The archive screen groups archived
 * sessions the same way.
 */
export const buildRailEntries = (
  sessions: Session[],
  projectsByInstance: Record<string, Project[]>,
  groups: readonly SessionGroup[] = []
): RailEntry[] => {
  const projects = new Map<string, ProjectEntry>();
  const standalone: SessionEntry[] = [];
  // Grouped sessions belong to their group and nowhere else, so they are kept out of the project
  // pass entirely. A project card stays as long as it still has ungrouped members.
  const groupedKeys = new Set(groups.flatMap((group) => group.keys));

  sessions.forEach((session) => {
    if (groupedKeys.has(sessionKey(session))) return;
    const project = projectForSession(session, projectsByInstance[session.instanceId] ?? []);
    if (project) {
      const id = projectIdentityKey(session.instanceId, project.id);
      const existing = projects.get(id);
      if (existing) existing.sessions.push(session);
      else {
        projects.set(id, {
          kind: 'project',
          id,
          instanceId: session.instanceId,
          project,
          sessions: [session],
          updated: session.updated ?? 0,
        });
      }
    } else {
      standalone.push({
        kind: 'session',
        id: sessionKey(session),
        session,
        updated: session.updated ?? 0,
      });
    }
  });

  const byKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const groupEntries: GroupEntry[] = groups.flatMap((group) => {
    const members = group.keys
      .flatMap((key) => byKey.get(key) ?? [])
      .sort(byRecency);
    // A group whose members are all gone (or archived out of `sessions`) has nothing to show.
    if (members.length === 0) return [];
    return [
      {
        kind: 'group' as const,
        id: group.id,
        name: group.name,
        keys: [...group.keys],
        members,
        instanceIds: [...new Set(members.map((member) => member.instanceId))],
        primaryKey:
          group.primaryKey !== undefined && group.keys.includes(group.primaryKey)
            ? group.primaryKey
            : sessionKey(members[0]),
        updated: members[0].updated ?? 0,
      },
    ];
  });

  const entries: RailEntry[] = [...groupEntries, ...projects.values(), ...standalone];
  entries.forEach((entry) => {
    if (entry.kind !== 'project') return;
    entry.sessions.sort(byRecency);
    entry.updated = entry.sessions[0]?.updated ?? 0;
  });
  entries.sort((a, b) => {
    if (b.updated !== a.updated) return b.updated - a.updated;
    return nameOf(a).localeCompare(nameOf(b)) || a.id.localeCompare(b.id);
  });
  return entries;
};

/**
 * The session to show after archiving one: "next, please" rather than an exit to Home.
 *
 * Walks the rail's own order forward from the archived session (wrapping once), skipping anything
 * that cannot be read — archived rows, crew workers — and preferring a session that is *not* a
 * closed column, since those are deliberately put away. Only when nothing else is left does
 * it return a closed one, and `null` when the rail itself is empty.
 *
 * The list must be the one the person is looking at: call this *before* the archive is applied,
 * because archiving bumps `updated` and would sort the archived session to the top.
 */
export const nextSessionAfterArchive = (
  archived: Session,
  sessions: readonly Session[],
  projectsByInstance: Record<string, Project[]>,
  groups: readonly SessionGroup[] = [],
  minimizedKeys: ReadonlySet<string> = new Set()
): Session | null => {
  const key = sessionKey(archived);
  const order = buildRailEntries(
    sessions.filter((session) => !session.archived && !isWorker(session)),
    projectsByInstance,
    groups
  ).flatMap((entry) =>
    entry.kind === 'project' ? entry.sessions : entry.kind === 'group' ? entry.members : [entry.session]
  );
  const start = order.findIndex((session) => sessionKey(session) === key);
  const from = start >= 0 ? start + 1 : 0;
  const rotated = [...order.slice(from), ...order.slice(0, from)];
  const eligible = (session: Session): boolean =>
    !session.archived && !isWorker(session) && sessionKey(session) !== key;
  return (
    rotated.find((session) => eligible(session) && !minimizedKeys.has(sessionKey(session))) ??
    rotated.find(eligible) ??
    null
  );
};

export type BlobStrip = {
  size: number;
  /** How many blobs to draw; the rest are represented by `overflow`. */
  visible: number;
  overflow: number;
};

/**
 * How a project card's blob strip lays out: full size for a handful, shrinking toward `minSize`
 * as the count grows, and a `+N` overflow chip once even the minimum size no longer fits.
 * `minItemWidth` widens each item's footprint when chrome beneath the blob (the title label)
 * needs more room than the blob itself.
 */
export const blobStripLayout = (
  count: number,
  availableWidth: number,
  maxSize = 30,
  minSize = 18,
  gap = 4,
  minItemWidth = 0
): BlobStrip => {
  if (count <= 0) return { size: maxSize, visible: 0, overflow: 0 };
  const size = count <= 4 ? maxSize : Math.max(minSize, maxSize - (count - 4) * 2);
  const item = Math.max(size, minItemWidth);
  let visible = count;
  while (visible > 1) {
    const overflow = count - visible;
    const chipWidth = overflow > 0 ? Math.max(size, 22) : 0;
    const total =
      visible * item + (visible - 1) * gap + (overflow > 0 ? gap + chipWidth : 0);
    if (total <= availableWidth) break;
    visible -= 1;
  }
  return { size, visible, overflow: count - visible };
};

/**
 * Where a session's notes live. A session inside a configured project shares its notes with every
 * other session in that project (so a note saved in one shows up in them all); a standalone session
 * keeps its own notes under its session key.
 */
/**
 * Notes are parked against one session, not shared across a project: a note is usually a thought
 * about *this* conversation ("for later, in here"), and a project-wide bucket meant it surfaced in
 * every other session in the folder. Stored under the session key, so the same text can be parked
 * independently in two sessions.
 */
export const notesKeyForSession = (session: Session): string => sessionKey(session);
