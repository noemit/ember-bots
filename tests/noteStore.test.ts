import { describe, expect, test } from 'bun:test';
import {
  addNote,
  cleanNoteText,
  MAX_NOTES_PER_SESSION,
  noteModelChoice,
  removeNote,
  updateNote,
  type NotesStore,
} from '../src/lib/noteStore';
import type { SessionNote } from '../src/types';

const note = (id: string, text: string, extra: Partial<SessionNote> = {}): SessionNote => ({ id, text, ...extra });

describe('adding a note', () => {
  test('appends to the session list, trimming and capping the text', () => {
    const store = addNote({}, 's1', note('a', '  a thought  '));
    expect(store.s1).toEqual([{ id: 'a', text: 'a thought' }]);
    expect(cleanNoteText('   ')).toBeNull();
    expect(cleanNoteText('x'.repeat(30_000))!.length).toBe(20_000);
  });

  test('blank text and a missing key change nothing at all', () => {
    const store: NotesStore = { s1: [note('a', 'keep')] };
    expect(addNote(store, 's1', note('b', '   '))).toBe(store);
    expect(addNote(store, '', note('b', 'text'))).toBe(store);
  });

  test('the per-session cap drops the oldest, not the newest', () => {
    let store: NotesStore = {};
    for (let index = 0; index < MAX_NOTES_PER_SESSION + 3; index += 1) {
      store = addNote(store, 's1', note(`n${index}`, `note ${index}`));
    }
    expect(store.s1).toHaveLength(MAX_NOTES_PER_SESSION);
    expect(store.s1![0].id).toBe('n3');
    expect(store.s1!.at(-1)!.id).toBe(`n${MAX_NOTES_PER_SESSION + 2}`);
  });
});

describe('editing a note', () => {
  test('replaces the text of exactly one note and leaves the rest byte-identical', () => {
    const other = note('b', 'a different note');
    const store: NotesStore = { s1: [note('a', 'old text'), other], s2: [note('c', 'elsewhere')] };
    const next = updateNote(store, 's1', 'a', { text: '  new text  ' });
    expect(next.s1![0]).toEqual({ id: 'a', text: 'new text' });
    // `toBe`, not `toEqual`: an untouched note must not be a new object, or a list keyed on identity
    // would re-render everything on every save.
    expect(next.s1![1]).toBe(other);
    expect(next.s2).toBe(store.s2);
  });

  test('a save for a note that is already gone does not resurrect it', () => {
    const store: NotesStore = { s1: [note('b', 'still here')] };
    expect(updateNote(store, 's1', 'deleted-meanwhile', { text: 'zombie' })).toBe(store);
    expect(updateNote(store, 's1', 'b', { text: '   ' })).toBe(store);
    expect(updateNote({}, 's1', 'b', { text: 'x' })).toEqual({});
  });

  test('an edit racing another note’s save keeps both notes', () => {
    // The dialog opened with [a]; meanwhile the composer saved `b`. The save patch must merge into
    // the store as it is now, not replace it with what the dialog last rendered.
    const opened: NotesStore = { s1: [note('a', 'original')] };
    const afterConcurrentSave = addNote(opened, 's1', note('b', 'saved while the dialog was open'));
    const saved = updateNote(afterConcurrentSave, 's1', 'a', { text: 'edited' });
    expect(saved.s1!.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(saved.s1![0].text).toBe('edited');
    expect(saved.s1![1].text).toBe('saved while the dialog was open');
  });

  test('a model is stored with its level and cleared back to the composer', () => {
    const store: NotesStore = { s1: [note('a', 'text')] };
    const withModel = updateNote(store, 's1', 'a', { modelId: 'anthropic/claude-sonnet-4-5', variant: 'high' });
    expect(withModel.s1![0]).toEqual({ id: 'a', text: 'text', modelId: 'anthropic/claude-sonnet-4-5', variant: 'high' });
    // The default sentinel is "no choice", stored as absence rather than as the string `default`.
    const cleared = updateNote(withModel, 's1', 'a', { modelId: 'default' });
    expect(cleared.s1![0]).toEqual({ id: 'a', text: 'text' });
    const levelless = updateNote(store, 's1', 'a', { modelId: 'openai/gpt-5', variant: 'default' });
    expect(levelless.s1![0]).toEqual({ id: 'a', text: 'text', modelId: 'openai/gpt-5' });
  });

  test('a text-only edit keeps the model the note already carried', () => {
    const store: NotesStore = { s1: [note('a', 'text', { modelId: 'openai/gpt-5', variant: 'low' })] };
    expect(updateNote(store, 's1', 'a', { text: 'reworded' }).s1![0]).toEqual({
      id: 'a', text: 'reworded', modelId: 'openai/gpt-5', variant: 'low',
    });
  });
});

describe('removing a note', () => {
  test('drops the entry and the empty session key, like the store already did', () => {
    const store: NotesStore = { s1: [note('a', 'one')], s2: [note('b', 'two')] };
    expect(removeNote(store, 's1', 'a')).toEqual({ s2: store.s2 });
    expect(removeNote(store, 's2', 'missing')).toBe(store);
    expect(removeNote(store, 'nope', 'b')).toBe(store);
  });
});

describe('which model a note sends with', () => {
  test('no model means the composer', () => {
    expect(noteModelChoice(note('a', 'text'))).toEqual({ kind: 'composer' });
    expect(noteModelChoice(note('a', 'text', { modelId: '' }))).toEqual({ kind: 'composer' });
    expect(noteModelChoice(note('a', 'text', { modelId: 'default' }))).toEqual({ kind: 'composer' });
  });

  test('a stored model is the note’s own, with its level when it has one', () => {
    expect(noteModelChoice(note('a', 'text', { modelId: 'openai/gpt-5' }))).toEqual({ kind: 'note', modelId: 'openai/gpt-5' });
    expect(noteModelChoice(note('a', 'text', { modelId: 'openai/gpt-5', variant: 'high' }))).toEqual({
      kind: 'note', modelId: 'openai/gpt-5', variant: 'high',
    });
  });
});
