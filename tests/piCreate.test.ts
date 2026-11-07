import { describe, expect, test } from 'bun:test';
import { piCreateSession, piLoadSessionInstructions, piSetSessionInstructions, rememberPiInstances } from '../src/piApi';
import { createSession } from '../src/api';

/**
 * A new session's standing instructions ride the create, so the session is never briefly promptless.
 * Hearth turns them into a reserved section of the system prompt (not a first message), which is why
 * they must be on this request rather than a follow-up write.
 */
let bodies: Array<Record<string, unknown>> = [];

(globalThis as { window?: unknown }).window = {
  ember: {
    piRequest: async (_endpointId: string, _path: string, init?: { body?: unknown }) => {
      bodies.push((init?.body ?? {}) as Record<string, unknown>);
      return { ok: true, status: 201, data: { id: 7, title: 'new' } };
    },
  },
};

describe('creating a session with instructions', () => {
  test('sends the prompt with the create, trimmed', async () => {
    bodies = [];
    await piCreateSession('pi:test', '/work', { instructions: '  You are a reviewer.  ' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].instructions).toBe('You are a reviewer.');
    expect(bodies[0].cwd).toBe('/work');
  });

  test('carries a derived title, so the conversation is never nameless', async () => {
    bodies = [];
    await piCreateSession('pi:test', '/work', { title: 'Tailnet Mechanic' });
    expect(bodies[0].title).toBe('Tailnet Mechanic');
  });

  test('omits the title when there is none', async () => {
    bodies = [];
    await piCreateSession('pi:test', '/work', {});
    expect('title' in bodies[0]).toBe(false);
  });

  test('omits the field entirely when there is nothing to send', async () => {
    bodies = [];
    await piCreateSession('pi:test', '/work', { instructions: '   ' });
    expect('instructions' in bodies[0]).toBe(false);
    bodies = [];
    await piCreateSession('pi:test', '/work');
    expect('instructions' in bodies[0]).toBe(false);
  });
});

/**
 * Reading and writing the prompt of a session that already exists. The read rides `docs=1` on a
 * one-entry page: `GET /conversations/:id` would carry the whole transcript to deliver one string.
 */
describe("a session's standing instructions after creation", () => {
  test('reads them from the agent document', async () => {
    let asked = '';
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async (_endpointId: string, path: string) => {
          asked = path;
          return { ok: true, status: 200, data: { entries: [], docs: { 'pi.agent': { instructions: 'You are a reviewer.' } } } };
        },
      },
    };
    const read = await piLoadSessionInstructions('pi:test', '42');
    expect(asked).toBe('/conversations/42/entries?limit=1&docs=1');
    expect(read).toEqual({ supported: true, instructions: 'You are a reviewer.' });
  });

  test('a session with none reads as absent, not empty', async () => {
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async () => ({ ok: true, status: 200, data: { entries: [], docs: { 'pi.agent': { cwd: '/w' } } } }),
      },
    };
    expect((await piLoadSessionInstructions('pi:test', '42')).instructions).toBeUndefined();
  });

  test('writes through configure, and null means clear', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async (_endpointId: string, _path: string, init?: { body?: unknown }) => {
          bodies.push((init?.body ?? {}) as Record<string, unknown>);
          return { ok: true, status: 200, data: { ok: true } };
        },
      },
    };
    expect(await piSetSessionInstructions('pi:test', '42', 'Be brief.')).toBe(true);
    expect(bodies[0]).toEqual({ instructions: 'Be brief.' });
    expect(await piSetSessionInstructions('pi:test', '42', null)).toBe(true);
    expect(bodies[1]).toEqual({ instructions: null });
  });
});

/**
 * A new session starts with the model and reasoning level the composer chose. Both are optional and
 * independent: a level chosen while the model stays on the host's default is still the person's
 * choice, and Hearth's create takes `thinkingLevel` on its own.
 */
describe('creating a session with a model and a reasoning level', () => {
  const recordCreates = () => {
    bodies = [];
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async (_endpointId: string, _path: string, init?: { body?: unknown }) => {
          bodies.push((init?.body ?? {}) as Record<string, unknown>);
          return { ok: true, status: 201, data: { id: 7, title: 'new' } };
        },
      },
    };
  };

  test('forwards the level alone when the model is the server default', async () => {
    recordCreates();
    await piCreateSession('pi:test', '/work', { variant: 'high' });
    expect(bodies[0]).toEqual({ cwd: '/work', thinkingLevel: 'high' });
  });

  test('forwards both when the composer picked a model', async () => {
    recordCreates();
    await piCreateSession('pi:test', '/work', {
      model: { providerID: 'opencode-go', modelID: 'glm-5.3-flash' },
      variant: 'low',
    });
    expect(bodies[0]).toMatchObject({
      model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
      thinkingLevel: 'low',
    });
  });

  test('createSession forwards the model and level it is given', async () => {
    recordCreates();
    rememberPiInstances([{ id: 'pi:test', kind: 'pi' }]);
    const created = await createSession('pi:test', '/work', {
      instructions: 'Be brief.',
      model: { providerID: 'opencode-go', modelID: 'glm-5.3-flash' },
      variant: 'high',
    });
    expect(created?.id).toBe('7');
    expect(bodies[0]).toEqual({
      cwd: '/work',
      model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
      thinkingLevel: 'high',
      instructions: 'Be brief.',
    });
  });
});
