import { describe, expect, test } from 'bun:test';
import { describeSchedule, describeTask } from './src/lib/scheduleText';

/**
 * A run is a session; the *plan* is the trigger. The rail shows the plan on its own card, and this is
 * the sentence it prints — written from Hearth's own schedule object, and `null` (not a guess) for
 * anything it does not recognise.
 */
describe('a schedule reads as a plan', () => {
  test('daily keeps the host time as written', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('Every day at 09:00');
    expect(describeSchedule({ kind: 'daily', time: '07:30', timezone: 'Europe/Berlin' })).toBe(
      'Every day at 07:30'
    );
  });

  test('weekly names the days in order, and collapses a full week to "every day"', () => {
    expect(describeSchedule({ kind: 'weekly', time: '08:15', weekdays: [3, 1] })).toBe(
      'Mon, Wed at 08:15'
    );
    expect(describeSchedule({ kind: 'weekly', time: '08:15', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      'Every day at 08:15'
    );
    // Duplicates and out-of-range values do not invent extra days.
    expect(describeSchedule({ kind: 'weekly', time: '08:15', weekdays: [1, 1, 9] })).toBe('Mon at 08:15');
  });

  test('a one-off says when it is, in local time', () => {
    // Built from local parts so the assertion does not depend on the runner's zone.
    const at = new Date(2026, 10, 4, 9, 0).getTime();
    expect(describeSchedule({ kind: 'once', at })).toBe('Once, 4 Nov at 09:00');
  });

  test('a host kind this does not know produces no sentence at all', () => {
    expect(describeSchedule({ kind: 'cron', expression: '* * * * *' })).toBeNull();
    expect(describeSchedule({ kind: 'daily' })).toBeNull();
    expect(describeSchedule({ kind: 'daily', time: '9am' })).toBeNull();
    expect(describeSchedule({ kind: 'weekly', time: '09:00', weekdays: [] })).toBeNull();
    expect(describeSchedule(undefined)).toBeNull();
    expect(describeSchedule('daily')).toBeNull();
  });
});

describe('a task in one line', () => {
  test('schedule, state and model', () => {
    expect(
      describeTask({ schedule: { kind: 'daily', time: '09:00' }, enabled: true, modelLabel: 'glm-5.3' })
    ).toBe('Every day at 09:00 · runs on glm-5.3');
  });

  test('a paused task says so, and an unknown schedule is admitted', () => {
    expect(describeTask({ schedule: { kind: 'cron' }, enabled: false })).toBe(
      'No schedule Ember understands · paused'
    );
  });
});
