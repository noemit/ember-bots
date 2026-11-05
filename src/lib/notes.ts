import type { Project, Session, SessionNote } from '../types';
import { sessionKey } from '../types';
import { notesKeyForSession } from './projectGroups';
import { projectForSession, projectIdentityKey } from '../blob/seed';

type SessionsByInstance = Record<string, Session[]>;
type ProjectsByInstance = Record<string, Project[]>;
type NotesMap = Record<string, SessionNote[]>;

/**
 * Recovery for notes stranded on a shared project key.
 *
 * Notes are parked per session (`notesKeyForSession`). But the 0.13.0 migration ("share notes
 * across the sessions of a project") kept rewriting a project session's notes onto
 * `project:<instance>::<project>` and deleting the session key, so a saved note left the place the
 * UI reads from and appeared to vanish. That migration is gone; this puts back what it moved.
 *
 * Each project row is given to a session of that project - the one on screen when it belongs to
 * the project, else the most recently used - and then dropped, because no code reads a project key
 * any more and leaving it would strand the note a second time.
 *
 * Returns the same object when there is nothing to move, so an effect can skip a settings write.
 */
export const recoverStrandedNotes = (
  notes: NotesMap,
  sessionsByInstance: SessionsByInstance,
  projectsByInstance: ProjectsByInstance,
  activeSessionKey: string | null = null
): NotesMap => {
  const projectKeys = Object.keys(notes).filter((key) => key.startsWith('project:'));
  if (projectKeys.length === 0) return notes;

  const next: NotesMap = { ...notes };
  let changed = false;

  projectKeys.forEach((projectKey) => {
    const stranded = next[projectKey];
    if (!stranded || stranded.length === 0) return;

    const owners = Object.entries(sessionsByInstance).flatMap(([instanceId, sessions]) =>
      sessions.filter((session) => {
        const project = projectForSession(session, projectsByInstance[instanceId] ?? []);
        return project ? projectIdentityKey(instanceId, project.id) === projectKey : false;
      })
    );
    // No session of that project is loaded yet. Keep the row: the effect runs again when sessions
    // arrive, and dropping it now would destroy the only copy.
    if (owners.length === 0) return;

    owners.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    const receiver =
      owners.find((session) => sessionKey(session) === activeSessionKey) ?? owners[0];
    const receiverKey = notesKeyForSession(receiver);
    next[receiverKey] = [...(next[receiverKey] ?? []), ...stranded].slice(-100);
    delete next[projectKey];
    changed = true;
  });

  return changed ? next : notes;
};
