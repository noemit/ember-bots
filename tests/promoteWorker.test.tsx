import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { promoteSession } from '../src/api';
import { PromoteWorkerForm } from '../src/components/PromoteWorkerDialog';
import { sessionCreateFailureOf, type SessionCreateFailure } from '../src/lib/newSessionFailure';
import { promoteFailureText } from '../src/lib/promoteFailure';
import { SessionCreateError } from '../src/lib/sessionCreateError';
import { piPromoteSession, rememberPiInstances } from '../src/piApi';
import type { Session } from '../src/types';

let previousWindow: unknown;
beforeAll(() => {
  previousWindow = (globalThis as { window?: unknown }).window;
});
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
});

const WORKER: Session = {
  id: '14',
  instanceId: 'pi:tower',
  title: 'Audit concurrency gates',
  kind: 'worker',
};

const FAILURE_CASES: SessionCreateFailure[] = [
  { kind: 'refused', detail: 'bot name already registered: Audit concurrency gates' },
  { kind: 'refused', detail: 'conversation is busy; wait or stop it first' },
  { kind: 'refused', detail: 'nothing to fork' },
  { kind: 'refused', detail: 'only a worker can be promoted; this conversation is not a worker' },
  { kind: 'refused', detail: 'the registry is read-only' },
  { kind: 'refused' },
  { kind: 'host-error', detail: 'Error: SQLite busy!\n    at commit (storage.ts:12)' },
  { kind: 'host-error' },
  { kind: 'unreachable' },
  { kind: 'ambiguous' },
  { kind: 'unknown' },
];

describe('piPromoteSession error propagation', () => {
  test('returns the promoted session on 201 and throws SessionCreateError with status and reason on failure', async () => {
    rememberPiInstances([{ id: 'pi:tower', kind: 'pi' }]);
    (globalThis as { window?: unknown }).window = {
      ember: {
        piRequest: async (_endpointId: string, _path: string, init?: { body?: unknown }) => {
          const body = (init?.body ?? {}) as { name?: string };
          if (body.name === 'Taken') {
            return { ok: false, status: 400, data: { error: 'bot name already registered: Taken' } };
          }
          if (body.name === 'Busy') {
            return { ok: false, status: 409, data: { error: 'conversation is busy; wait or stop it first' } };
          }
          return {
            ok: true,
            status: 201,
            data: { id: 22, title: body.name ?? 'Peer', kind: 'peer' },
          };
        },
      },
    };

    const promoted = await promoteSession(WORKER, {
      name: 'Audit concurrency gates',
      description: 'Checks race conditions',
      pinned: true,
    });
    expect(promoted?.id).toBe('22');
    expect(promoted?.title).toBe('Audit concurrency gates');

    try {
      await piPromoteSession('pi:tower', '14', { name: 'Taken', pinned: true });
      throw new Error('expected duplicate name to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCreateError);
      expect(sessionCreateFailureOf(error)).toEqual({
        kind: 'refused',
        detail: 'bot name already registered: Taken',
      });
    }

    try {
      await piPromoteSession('pi:tower', '14', { name: 'Busy', pinned: true });
      throw new Error('expected busy worker to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCreateError);
      expect((error as SessionCreateError).status).toBe(409);
    }
  });
});

describe('promoteFailureText copy qualities', () => {
  test('every failure names the actor, offers an on-screen recovery action, and avoids shouting or jargon', () => {
    for (const failure of FAILURE_CASES) {
      const text = promoteFailureText({
        failure,
        instanceLabel: 'Tower',
        name: 'Audit concurrency gates',
      });
      expect(text).toContain('Tower');
      expect(text).toMatch(/Make persistent|Cancel|another name|try again/i);
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\b(4\d\d|5\d\d|undefined|null|error:|status|agents?|peers?|fork)\b/i);
    }
  });

  test('falls back to Kiln when no instance label is supplied and names the colliding bot name', () => {
    const duplicate = promoteFailureText({
      failure: { kind: 'refused', detail: 'bot name already registered: Audit concurrency gates' },
      name: 'Audit concurrency gates',
    });
    expect(duplicate).toContain('Kiln');
    expect(duplicate).toContain('Audit concurrency gates');
    expect(duplicate).toContain('Choose another name above');
  });
});

describe('PromoteWorkerForm in-flight and inline error states', () => {
  const noop = () => {};

  test('shows busy in-flight state and disables inputs and actions while promotion is running', () => {
    const html = renderToStaticMarkup(
      <PromoteWorkerForm
        worker={WORKER}
        busy={false}
        submitting
        instanceLabel="Tower"
        initialDescription="Keeps watch over lock ordering"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(html).toContain('Making persistent…');
    expect(html).toContain('Creating “Audit concurrency gates” on Tower…');
    expect(html).toContain('value="Audit concurrency gates"');
    expect(html).toContain('value="Keeps watch over lock ordering"');
    // Both text inputs and both footer buttons are disabled while the request is in flight.
    const disabledControls = [...html.matchAll(/<(input|button)\b[^>]*\bdisabled\b[^>]*>/g)];
    expect(disabledControls.length).toBeGreaterThanOrEqual(4);
  });

  test('renders inline alert copy on error while preserving typed name and description for retry', () => {
    const errorCopy = promoteFailureText({
      failure: { kind: 'refused', detail: 'bot name already registered: Audit concurrency gates' },
      instanceLabel: 'Tower',
      name: 'Audit concurrency gates',
    });
    const html = renderToStaticMarkup(
      <PromoteWorkerForm
        worker={WORKER}
        busy={false}
        submitting={false}
        error={errorCopy}
        instanceLabel="Tower"
        initialDescription="Keeps watch over lock ordering"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Tower already has a bot named “Audit concurrency gates”');
    expect(html).toContain('value="Audit concurrency gates"');
    expect(html).toContain('value="Keeps watch over lock ordering"');
    expect(html).toContain('>Make persistent<');
    expect(html).toContain('aria-describedby="promotion-error"');
  });
});
