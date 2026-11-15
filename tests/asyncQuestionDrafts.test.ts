import { expect, test } from 'bun:test';
import { createQuestionDraftStore } from '../src/lib/asyncQuestionDrafts';

test('moving a question into history preserves its in-flight draft and notifies a newly mounted row', () => {
  const store = createQuestionDraftStore();
  let oldRow = 0, historyRow = 0;
  const leave = store.subscribe('host:question', () => oldRow++);
  store.put('host:question', { text: 'Keep the original draft', mutation: { requestId: 'send', revision: 1, action: 'answer' } });
  leave();
  store.subscribe('host:question', () => historyRow++);
  store.settle('host:question', 'send', { ...store.get('host:question'), failed: true });
  expect(oldRow).toBe(1); expect(historyRow).toBe(1);
  expect(store.get('host:question')).toMatchObject({ text: 'Keep the original draft', failed: true });
});

test('an old operation cannot clear or replace the next context draft after its receipt arrived', () => {
  const store = createQuestionDraftStore();
  store.put('question', { text: 'Answer', mutation: { requestId: 'old-send', revision: 1 } });
  expect(store.settle('question', 'old-send', { text: '', accepted: 'Answer' })).toBe(true);
  store.put('question', { text: 'The human is writing more context', adding: true, accepted: 'Answer' });
  expect(store.settle('question', 'old-send', { text: '' })).toBe(false);
  expect(store.get('question').text).toBe('The human is writing more context');
});

test('question identity scopes drafts and empty snapshots remain stable for React subscribers', () => {
  const store = createQuestionDraftStore();
  expect(store.get('unknown')).toBe(store.get('unknown'));
  store.put('host-one:question', { text: 'First host' });
  expect(store.get('host-two:question').text).toBe('');
  store.put('host-one:question');
  expect(store.get('host-one:question').text).toBe('');
});
