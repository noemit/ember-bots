import { describe, expect, test } from 'bun:test';
import {
  canFinish,
  firstIncompleteStep,
  isCompactStep,
  needsOnboarding,
  stepStates,
  stepsFor,
  workspaceHint,
  type OnboardingState,
} from '../src/lib/onboarding';

/**
 * First-run decisions.
 *
 * The wizard's whole job is to appear for the right people and then get out of the way, so these
 * test the two failures that actually cost something: showing up for someone who is set up, and
 * staying shut for someone whose local instance is broken but who has remotes configured.
 */

const world = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  localReady: false,
  canRotate: false,
  remoteReady: false,
  targetInstanceId: null,
  ...over,
});

describe('needsOnboarding', () => {
  test('a fresh install with nothing running is onboarded', () => {
    expect(needsOnboarding(world(), null)).toBe(true);
  });

  test('a working local harness means no wizard, even with no remotes', () => {
    expect(needsOnboarding(world({ localReady: true }), null)).toBe(false);
  });

  test('a working remote means no wizard: that person is already set up', () => {
    expect(needsOnboarding(world({ remoteReady: true }), null)).toBe(false);
  });

  test('a broken local with a configured remote still runs — this was the motivating case', () => {
    // The owner's settings.json: pi:heliograph configured, local harness installed but not listed.
    expect(needsOnboarding(world({ remoteReady: false }), null)).toBe(true);
  });

  test('a dismissal sticks, whatever the state', () => {
    expect(needsOnboarding(world(), Date.now())).toBe(false);
    expect(needsOnboarding(world(), 1)).toBe(false);
  });

  test('a dismissal of 0 is not a dismissal', () => {
    expect(needsOnboarding(world(), 0)).toBe(true);
  });
});

describe('which steps to draw', () => {
  test('a connected-here setup never sees the container instructions', () => {
    const steps = stepsFor(world({ localReady: true }));
    expect(steps.map((step) => step.id)).toEqual(['welcome', 'connection', 'token', 'providers', 'first-agent']);
  });

  test('a failed local keeps the computer choice page, with optional setup inside it', () => {
    const steps = stepsFor(world());
    expect(steps.map((step) => step.id)).toContain('connection');
  });

  test('only the connection step blocks', () => {
    expect(stepsFor(world()).filter((step) => step.blocking).map((step) => step.id)).toEqual(['connection']);
  });

  test('the token step is compact when a host is already running here', () => {
    expect(isCompactStep('token', world({ localReady: true }))).toBe(true);
    expect(isCompactStep('token', world())).toBe(false);
    // Nothing else has a compact form, so the flag never leaks into another step.
    expect(isCompactStep('welcome', world({ localReady: true }))).toBe(false);
  });
});

describe('the step list ticks', () => {
  test('a failed connection is the only step that can report a fault', () => {
    const states = stepStates(world(), 'Kiln did not answer on 127.0.0.1:3002');
    expect(states.connection).toEqual({ kind: 'failed', problem: 'Kiln did not answer on 127.0.0.1:3002' });
    // Not configured yet is `pending`, which is not the same word as `failed`.
    expect(states.providers).toEqual({ kind: 'pending' });
  });

  test('a pending connection says pending, not failed', () => {
    expect(stepStates(world()).connection).toEqual({ kind: 'pending' });
  });

  test('connected here ticks the token step; no remote is skipped rather than failed', () => {
    const states = stepStates(world({ localReady: true }));
    expect(states.connection).toEqual({ kind: 'done' });
    expect(states.token).toEqual({ kind: 'done' });
  });
});

describe('where it opens and how it ends', () => {
  test('a failed connection opens on the connection step', () => {
    expect(firstIncompleteStep(world())).toBe('connection');
  });

  test('a connected install opens on the provider step: nothing to fix first', () => {
    expect(firstIncompleteStep(world({ localReady: true }))).toBe('providers');
  });

  test('Finish is offered once anything works, so a failed local never traps anyone', () => {
    expect(canFinish(world({ localReady: true }))).toBe(true);
    expect(canFinish(world({ remoteReady: true }))).toBe(true);
    expect(canFinish(world())).toBe(false);
  });
});

describe('workspaceHint', () => {
  test('names the container mount when that is where sessions will land', () => {
    expect(workspaceHint('/workspace')).toContain('/workspace');
    expect(workspaceHint('/workspace')).toContain('container');
  });

  test('names a home workspace otherwise, and admits it can be changed', () => {
    const hint = workspaceHint('/Users/noemi/workspace');
    expect(hint).toContain('/Users/noemi/workspace');
    expect(hint).toContain('anywhere');
  });

  test('says what a project is even before anyone knows the root', () => {
    expect(workspaceHint(null)).toContain('project');
  });
});


test('a new installation keeps onboarding when bundled Kiln is healthy, until explicitly dismissed', () => {
  const ready = world({ localReady: true, canRotate: true });
  expect(needsOnboarding(ready, undefined, 123)).toBe(true);
  expect(needsOnboarding(ready, 456, 123)).toBe(false);
  expect(needsOnboarding(ready, undefined)).toBe(false);
});
