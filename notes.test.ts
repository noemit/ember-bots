import { describe, expect, test } from 'bun:test';
import { recoverStrandedNotes } from './src/lib/notes';
import { notesKeyForSession } from './src/lib/projectGroups';
import { projectIdentityKey } from './src/blob/seed';
import { sessionKey } from './src/types';
import type { Project, Session, SessionNote } from './src/types';

const project: Project = { id: 'proj-1', path: '/work/repo', name: 'repo' } as Project;

const session = (id: string, directory: string, updated = 0): Session =>
  ({ id, instanceId: 'inst-1', directory, title: id, updated }) as Session;

const inProject = session('ses-1', '/work/repo/src');
const alsoInProject = session('ses-2', '/work/repo/docs', 1000);
const standalone = session('ses-3', '/elsewhere/lib');

const note = (id: string, text: string): SessionNote => ({ id, text });

const projectKey = projectIdentityKey('inst-1', project.id);

describe('notes stay on the session the user saved them in', () => {
  test('a note saved in a project session is still under the session key after a load', () => {
    const key = notesKeyForSession(inProject);
    const saved = { [key]: [note('n1', 'remember this')] };

    // What the load/refresh cycle does now: nothing moves.
    const afterLoad = recoverStrandedNotes(saved, { 'inst-1': [inProject] }, { 'inst-1': [project] });

    expect(afterLoad[key]?.map((entry) => entry.text)).toEqual(['remember this']);
  });

  test('the regression is gone: a project session no longer loses its notes to the project bucket', () => {
    const key = notesKeyForSession(inProject);
    const saved = { [key]: [note('n1', 'remember this')] };

    const afterLoad = recoverStrandedNotes(saved, { 'inst-1': [inProject] }, { 'inst-1': [project] });

    // ChatView reads sessionNotes[notesKeyForSession(session)] — the note must be there.
    expect(afterLoad[notesKeyForSession(inProject)]).toHaveLength(1);
    expect(afterLoad[projectKey]).toBeUndefined();
  });
});

describe('recoverStrandedNotes puts back what the old migration moved', () => {
  test('a project-keyed row returns to the on-screen session when it belongs to the project', () => {
    const stranded = { [projectKey]: [note('n1', 'from before')] };

    const recovered = recoverStrandedNotes(
      stranded,
      { 'inst-1': [inProject, alsoInProject] },
      { 'inst-1': [project] },
      sessionKey(inProject)
    );

    expect(recovered[notesKeyForSession(inProject)]?.map((entry) => entry.text)).toEqual(['from before']);
    expect(recovered[projectKey]).toBeUndefined();
  });

  test('without an on-screen match the notes go to the most recently used project session', () => {
    const stranded = { [projectKey]: [note('n1', 'from before')] };

    const recovered = recoverStrandedNotes(
      stranded,
      { 'inst-1': [inProject, alsoInProject] },
      { 'inst-1': [project] }
    );

    expect(recovered[notesKeyForSession(alsoInProject)]?.map((entry) => entry.text)).toEqual(['from before']);
    expect(recovered[notesKeyForSession(inProject)]).toBeUndefined();
  });

  test('a row with no loaded session for its project is kept, not dropped', () => {
    const stranded = { [projectKey]: [note('n1', 'only copy')] };

    // Nothing from the project is loaded yet.
    const recovered = recoverStrandedNotes(stranded, { 'inst-1': [standalone] }, { 'inst-1': [project] });

    expect(recovered).toBe(stranded);
    expect(recovered[projectKey]).toHaveLength(1);
  });

  test('existing session notes are kept and the recovered ones append', () => {
    const existing = [note('n0', 'already here')];
    const stranded = {
      [notesKeyForSession(inProject)]: existing,
      [projectKey]: [note('n1', 'recovered')],
    };

    const recovered = recoverStrandedNotes(
      stranded,
      { 'inst-1': [inProject] },
      { 'inst-1': [project] },
      sessionKey(inProject)
    );

    expect(recovered[notesKeyForSession(inProject)]?.map((entry) => entry.text)).toEqual([
      'already here',
      'recovered',
    ]);
  });

  test('returns the same object when there is nothing to do, so no settings write happens', () => {
    const plain = { [notesKeyForSession(inProject)]: [note('n1', 'fine')] };
    expect(recoverStrandedNotes(plain, { 'inst-1': [inProject] }, { 'inst-1': [project] })).toBe(plain);

    const empty = {};
    expect(recoverStrandedNotes(empty, {}, {})).toBe(empty);
  });

  test('a standalone session is untouched', () => {
    const key = notesKeyForSession(standalone);
    const notes = { [key]: [note('n1', 'keep me')] };
    expect(recoverStrandedNotes(notes, { 'inst-1': [standalone] }, { 'inst-1': [project] })).toBe(notes);
  });
});
