import { parseSessionKey } from './workspace';
import type { Session } from '../types';

/**
 * Agent groups: a named set of sessions that can span instances and projects. Ember-side only, so no
 * Hearth call is involved; the keys use the same `instance::session` format as the workspace.
 *
 * One invariant holds everywhere below: **a session lives in at most one group**. Adding a key to a
 * group removes it from any other, so grouping an already-grouped session is a move rather than a
 * copy, and `groupForSession` has at most one answer.
 */
export type SessionGroup = {
  id: string;
  name: string;
  keys: string[];
  /** The member whose instance and project a new agent in this group should default to. */
  primaryKey?: string;
};

/** A group needs two members to be a group, and stops being one when it falls below that. */
export const MIN_GROUP_MEMBERS = 2;
/** Guard against a settings file that grew unbounded. */
export const MAX_GROUP_MEMBERS = 16;

const dedupe = (keys: readonly string[]): string[] => [...new Set(keys)].slice(0, MAX_GROUP_MEMBERS);

/**
 * Whether the Manage panel may save. The configured list is the group: members that cannot be read
 * right now (an unreachable instance) still count, so an outage can neither block a save nor be an
 * excuse to shorten the group.
 */
export const canSaveGroup = (keys: readonly string[]): boolean => keys.length >= MIN_GROUP_MEMBERS;

/** Strip a key from every group except `keepId`, dropping groups that stop being groups. */
const withoutKey = (groups: readonly SessionGroup[], key: string, keepId: string): SessionGroup[] =>
  groups.flatMap((group) => {
    if (group.id === keepId || !group.keys.includes(key)) return [group];
    const keys = group.keys.filter((entry) => entry !== key);
    if (keys.length < MIN_GROUP_MEMBERS) return [];
    return [{ ...group, keys, primaryKey: keys.includes(group.primaryKey ?? '') ? group.primaryKey : keys[0] }];
  });

/** The group holding a session. Unique, because a key can only be in one group. */
export const groupForSession = (
  groups: readonly SessionGroup[],
  key: string
): SessionGroup | null => groups.find((group) => group.keys.includes(key)) ?? null;

/** Group members in the order the group lists them; unresolvable keys are skipped. */
export const groupMembers = (
  group: SessionGroup,
  lookup: (key: string) => Session | undefined
): Session[] => group.keys.flatMap((key) => lookup(key) ?? []);

/** Create a group, moving its members out of any group they were already in. */
export const createGroup = (
  groups: readonly SessionGroup[],
  group: { id: string; name: string; keys: readonly string[]; primaryKey?: string }
): SessionGroup[] => {
  const keys = dedupe(group.keys);
  if (keys.length < MIN_GROUP_MEMBERS) return [...groups];
  let next = [...groups];
  keys.forEach((key) => {
    next = withoutKey(next, key, group.id);
  });
  return [
    ...next,
    {
      id: group.id,
      name: group.name,
      keys,
      primaryKey: group.primaryKey && keys.includes(group.primaryKey) ? group.primaryKey : keys[0],
    },
  ];
};

/**
 * Save a group (new or edited), enforcing the single-group invariant: any key in `group.keys` is
 * moved out of every other group (dissolving groups that fall below two members), `group.keys` is
 * deduplicated and capped, and an existing group keeps its place in the list.
 */
export const upsertGroup = (
  groups: readonly SessionGroup[],
  group: { id: string; name: string; keys: readonly string[]; primaryKey?: string }
): SessionGroup[] => {
  const keys = dedupe(group.keys);
  if (keys.length < MIN_GROUP_MEMBERS) {
    return groups.filter((entry) => entry.id !== group.id);
  }
  let next = [...groups];
  keys.forEach((key) => {
    next = withoutKey(next, key, group.id);
  });
  const saved: SessionGroup = {
    id: group.id,
    name: group.name,
    keys,
    primaryKey: group.primaryKey && keys.includes(group.primaryKey) ? group.primaryKey : keys[0],
  };
  return next.some((entry) => entry.id === group.id)
    ? next.map((entry) => (entry.id === group.id ? saved : entry))
    : [...next, saved];
};

/** Add members to an existing group, moving them out of any other. Unknown ids are a no-op. */
export const addToGroup = (
  groups: readonly SessionGroup[],
  groupId: string,
  keys: readonly string[]
): SessionGroup[] => {
  const target = groups.find((group) => group.id === groupId);
  if (!target) return [...groups];
  let next = [...groups];
  keys.forEach((key) => {
    next = withoutKey(next, key, groupId);
  });
  const merged = dedupe([...target.keys, ...keys]);
  return next.map((group) =>
    group.id === groupId
      ? { ...group, keys: merged, primaryKey: merged.includes(group.primaryKey ?? '') ? group.primaryKey : merged[0] }
      : group
  );
};

/** Remove members. A group that falls below two members is dissolved. */
export const removeFromGroup = (
  groups: readonly SessionGroup[],
  groupId: string,
  keys: readonly string[]
): SessionGroup[] =>
  groups.flatMap((group) => {
    if (group.id !== groupId) return [group];
    const remaining = group.keys.filter((key) => !keys.includes(key));
    if (remaining.length < MIN_GROUP_MEMBERS) return [];
    return [
      {
        ...group,
        keys: remaining,
        primaryKey: remaining.includes(group.primaryKey ?? '') ? group.primaryKey : remaining[0],
      },
    ];
  });

export const renameGroup = (
  groups: readonly SessionGroup[],
  groupId: string,
  name: string
): SessionGroup[] => groups.map((group) => (group.id === groupId ? { ...group, name } : group));

export const setGroupPrimary = (
  groups: readonly SessionGroup[],
  groupId: string,
  key: string
): SessionGroup[] =>
  groups.map((group) =>
    group.id === groupId && group.keys.includes(key) ? { ...group, primaryKey: key } : group
  );

/**
 * Drop members whose session is archived, gone or a subagent. `check` follows the same convention as
 * `pruneWorkspace`: `false` drops the key, `undefined` means "not known yet" and keeps it, so a group
 * survives an instance being briefly unreachable. Also enforces the one-group invariant and the
 * minimum, so a hand-edited settings file cannot produce a key in two groups.
 */
export const pruneGroups = (
  groups: readonly SessionGroup[],
  check: (key: string) => boolean | undefined
): SessionGroup[] => {
  const seenGroups = new Set<string>();
  const seenKeys = new Set<string>();
  const next: SessionGroup[] = [];
  groups.forEach((group) => {
    if (seenGroups.has(group.id)) return;
    const keys = group.keys.filter((key) => {
      if (seenKeys.has(key)) return false;
      if (check(key) === false) return false;
      seenKeys.add(key);
      return true;
    });
    if (keys.length < MIN_GROUP_MEMBERS) return;
    seenGroups.add(group.id);
    next.push(
      keys.length === group.keys.length
        ? group
        : { ...group, keys, primaryKey: keys.includes(group.primaryKey ?? '') ? group.primaryKey : keys[0] }
    );
  });
  return next;
};

/**
 * A starting name for a new group: the first two member titles, plus a count when there are more.
 *
 * **Never a single member's title.** It used to be, and a group made from one session's
 * "Group with..." therefore carried that session's own name — so the card's header and the member
 * list beneath it said the same words, which read as a bug rather than as a group. One member gets
 * a label of its own ("Group") and the person renames it if they care; two or more is genuinely a
 * set, and the joined titles describe it.
 */
export const defaultGroupName = (titles: readonly string[]): string => {
  const named = titles.map((title) => title.trim()).filter(Boolean);
  if (named.length <= 1) return 'Group';
  const head = `${named[0]} + ${named[1]}`;
  return named.length > 2 ? `${head} +${named.length - 2}` : head;
};

/** How Ember sees the instance a missing group member points at. */
export type GroupMemberInstance = {
  /** The instance's label, as the rail and the panel show it. */
  label: string;
  /** Whether Ember can read that instance's sessions right now. */
  readable: boolean;
};

/** One configured member that resolves to no session right now, and where it was supposed to live. */
export type MissingGroupMember = {
  /** The configured key. It stays in the group whether or not it resolves. */
  key: string;
  /** The instance's label when Ember still lists that instance; `null` when it no longer does. */
  instanceLabel: string | null;
  /**
   * Whether that instance's sessions are readable right now. `false` means the instance is listed
   * but not answering (the member is waiting on a connection); `true` with a label means the
   * instance answered and the session itself is not in the list (deleted, or a read that came back
   * short) — a different thing to tell the reader, and a different next step.
   */
  instanceReadable: boolean;
};

/**
 * The configured keys that resolved to no session, paired with what Ember knows about the instance
 * each one names. A key whose instance Ember no longer lists gets `instanceLabel: null`, so the note
 * can tell the reader to re-add it rather than reconnect it — the two need different next steps.
 */
export const missingGroupMembers = (
  keys: readonly string[],
  isResolved: (key: string) => boolean,
  instanceFor: (instanceId: string) => GroupMemberInstance | undefined
): MissingGroupMember[] =>
  keys
    .filter((key) => !isResolved(key))
    .map((key) => {
      const ref = parseSessionKey(key);
      const instance = ref ? instanceFor(ref.instanceId) : undefined;
      return {
        key,
        instanceLabel: instance?.label ?? null,
        instanceReadable: instance?.readable ?? false,
      };
    });

const nameList = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

/**
 * What to tell someone about members a group cannot show right now. Names the instance at fault,
 * says the place in the group is kept (the thing the reader is afraid of), and points at the one
 * screen that fixes it. Null when every configured member resolved.
 *
 * Three cases, because the next step differs: an instance that is not answering (reconnect it), one
 * Ember no longer lists (re-add it), and a session that is simply not in a readable instance's list
 * (nothing to reconnect — Ember keeps the place and shows it again if the session returns).
 */
export const groupMissingNote = (missing: readonly MissingGroupMember[]): string | null => {
  if (missing.length === 0) return null;
  const offline = missing.filter((entry) => entry.instanceLabel !== null && !entry.instanceReadable);
  const unlisted = missing.filter((entry) => entry.instanceLabel === null);
  const absent = missing.filter((entry) => entry.instanceLabel !== null && entry.instanceReadable);
  const notes: string[] = [];

  if (offline.length > 0) {
    const labels = [...new Set(offline.flatMap((entry) => entry.instanceLabel ?? []))];
    const many = offline.length !== 1;
    notes.push(
      `${offline.length} ${many ? 'members are' : 'member is'} on ${nameList(labels)}, ` +
        `${labels.length === 1 ? "which isn't" : "which aren't"} connected right now — ` +
        `${many ? 'their places are' : 'its place is'} kept. Reconnect ${labels.length === 1 ? 'it' : 'them'} under Settings → Instances.`
    );
  }
  if (unlisted.length > 0) {
    const many = unlisted.length !== 1;
    notes.push(
      `${unlisted.length} ${many ? 'members are' : 'member is'} on ${many ? 'instances' : 'an instance'} Ember no longer lists — ` +
        `${many ? 'their places are' : 'its place is'} kept. Re-add ${many ? 'those instances' : 'that instance'} under ` +
        `Settings → Instances to get ${many ? 'them' : 'it'} back.`
    );
  }
  if (absent.length > 0) {
    const labels = [...new Set(absent.flatMap((entry) => entry.instanceLabel ?? []))];
    const many = absent.length !== 1;
    notes.push(
      `${absent.length} ${many ? 'members are' : 'member is'} no longer in ${nameList(labels)}'s session list — ` +
        `${many ? 'their places are' : 'its place is'} kept. Ember shows ${many ? 'them' : 'it'} again if ${many ? 'those sessions come' : 'that session comes'} back.`
    );
  }
  return notes.join(' ');
};
