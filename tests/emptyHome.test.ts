import { expect, test } from 'bun:test';
import { emptyHomeTarget, newSessionTarget } from '../src/lib/emptyHome';

const local = { id: 'pi:local', status: 'ready' as const, attachable: true };
const remote = { ...local, id: 'pi:remote' };
const hidden = new Set<string>();

test('empty Home opens a draft on the included Kiln once session lists are known', () => {
  expect(emptyHomeTarget([remote, local], { 'pi:remote': [], 'pi:local': [] }, 0, hidden)).toBe(local.id);
});

test('a delayed session list or instance probe cannot be mistaken for empty Home', () => {
  expect(emptyHomeTarget([local, remote], { 'pi:local': [] }, 0, hidden)).toBeNull();
  expect(emptyHomeTarget([local, { ...remote, status: 'checking' }], { 'pi:local': [] }, 0, hidden)).toBeNull();
  expect(emptyHomeTarget([local], {}, 0, hidden)).toBeNull();
});

test('existing Home sessions keep their place', () => {
  expect(emptyHomeTarget([local], { 'pi:local': [] }, 1, hidden)).toBeNull();
});

test('hidden or unavailable computers are not chosen for a draft', () => {
  expect(newSessionTarget([local, remote], new Set([local.id]))).toBe(remote.id);
  expect(emptyHomeTarget([{ ...local, status: 'unreachable', attachable: false }], {}, 0, hidden)).toBeNull();
  expect(emptyHomeTarget([local, { ...remote, status: 'checking' }], { 'pi:local': [] }, 0, new Set([remote.id]))).toBe(local.id);
});
