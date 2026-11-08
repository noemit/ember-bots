import type { ProcessStopResult, Session } from '../types';

/**
 * Stopping what a bot left running when it is hidden.
 *
 * Hiding is a statement about a bot — "I am done with this" — and a program it started outliving
 * that statement is the surprise behind the request: the row is gone, but a dev server, a watcher
 * or a browser keeps holding the port. So hiding stops the leftovers of the bot **and of every
 * worker under it**, because a worker has no row of its own once its leader is gone.
 *
 * The sentences here say three things in the order a person needs them: the bot *is* hidden (that
 * part already happened and is not in question), what happened to the programs, and — when it went
 * wrong — which machine to look at and how to try again.
 */
export type ProcessStopReply = {
  ok: boolean;
  results?: ProcessStopResult[];
  processes?: Session['processes'];
};

/** Programs the host said were still there after the polite signal. */
export const refusedPids = (results: readonly ProcessStopResult[] | undefined): number[] =>
  (results ?? []).filter((entry) => entry.outcome === 'refused').map((entry) => entry.pid);

/**
 * The banner when the polite stop did not land at all: the host never answered. It names the host,
 * says the bot is hidden (so nobody doubts that part), and says plainly that the programs may still
 * be running — the fact worth knowing before closing the lid on the machine.
 */
export const hideStopFailure = (hostLabel: string | undefined): string => {
  const host = hostLabel?.trim() || 'The host';
  return `${host} did not answer the stop request, so the programs this bot left running may still be there. The bot is hidden; Retry tries the stop again.`;
};

/**
 * The banner when programs took SIGTERM and ignored it. Unlike the failure above this one is a
 * choice: force is destructive, so it is asked for rather than assumed — the same two-step the
 * Processes tray offers.
 */
export const hideForceStopAsk = (pids: readonly number[], hostLabel: string | undefined): string => {
  const host = hostLabel?.trim() || 'The host';
  const programs = pids.length === 1 ? 'One program' : `${pids.length} programs`;
  return `The bot is hidden, but ${programs.toLowerCase()} it left running on ${host} did not stop when asked. Force stop ends ${pids.length === 1 ? 'it' : 'them'} at once, and anything unsaved is lost.`;
};

/**
 * The sentence for a crew that reached beyond this machine. Pids are per host, so a worker living
 * elsewhere was not touched; saying so is the difference between "clean" and "clean here".
 */
export const hideElsewhereNote = (count: number): string =>
  `${count === 1 ? 'One worker' : `${count} workers`} in this crew ${count === 1 ? 'lives' : 'live'} on another host, so ${count === 1 ? 'its' : 'their'} programs were left alone.`;
