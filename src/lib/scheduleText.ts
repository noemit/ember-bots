/**
 * How a scheduled task's plan reads in one line.
 *
 * A run is a session (it lives in the rail like any other, with a calendar mark saying what started
 * it); the *plan* is the other half — a trigger that repeats. This is the sentence for the plan side,
 * written from Hearth's own `schedule` object (`{ kind: "once" | "daily" | "weekly", time?, weekdays?,
 * at?, timezone? }`, `hearth/src/scheduler.ts`).
 *
 * It returns `null` rather than inventing a plan for anything it does not understand: a host that
 * grows a new kind should produce a row with no schedule line, not a false one.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Hearth numbers weekdays 0 = Sunday … 6 = Saturday (`WEEKDAY_INDEX` in its scheduler). */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());

/** `09:00` stays as the host wrote it; the plan is quoted, not reformatted into the reader's locale. */
const time = (value: string): string => value.trim();

/** `Sun`, `Mon, Wed` … in the order given, de-duplicated, ignoring anything out of range. */
const weekdayList = (days: readonly number[]): string[] =>
  [...new Set(days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b)
    .map((day) => WEEKDAYS[day]);

/** A one-off, dated locally: `Once, 4 Nov at 09:00`. */
const onceText = (at: number): string => {
  const when = new Date(at);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return `Once, ${when.getDate()} ${MONTHS[when.getMonth()]} at ${hh}:${mm}`;
};

/**
 * One line for a task's schedule, or `null` when the host sent one this does not understand.
 *
 * @param schedule the task's own `schedule` object (straight off the wire, so it is validated here)
 */
export const describeSchedule = (schedule: unknown): string | null => {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return null;
  const record = schedule as Record<string, unknown>;
  const kind = record.kind;

  if (kind === 'once' && typeof record.at === 'number' && Number.isFinite(record.at)) {
    return onceText(record.at);
  }
  if (kind === 'daily' && isTime(record.time)) {
    return `Every day at ${time(record.time)}`;
  }
  if (kind === 'weekly' && isTime(record.time) && Array.isArray(record.weekdays)) {
    const days = weekdayList(record.weekdays.filter((day): day is number => typeof day === 'number'));
    if (days.length === 0) return null;
    // Seven named days is a daily task spelled the long way; say the simpler true thing.
    if (days.length === 7) return `Every day at ${time(record.time)}`;
    return `${days.join(', ')} at ${time(record.time)}`;
  }
  return null;
};

/**
 * The whole plan in one sentence for a row's tooltip: schedule, plus whether it is running.
 * Kept separate from `describeSchedule` so the row can show the schedule alone when the tooltip is
 * already busy with something else.
 */
export const describeTask = (input: {
  schedule: unknown;
  enabled: boolean;
  modelLabel?: string;
}): string => {
  const when = describeSchedule(input.schedule);
  const parts = [when ?? 'No schedule Ember understands'];
  if (!input.enabled) parts.push('paused');
  if (input.modelLabel) parts.push(`runs on ${input.modelLabel}`);
  return parts.join(' · ');
};
