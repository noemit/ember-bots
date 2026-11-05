/**
 * What a session's cost badge can honestly say (unit-tested in `sessionCost.test.ts`).
 *
 * `cost > 0` was the only test the badge used, so three different truths were one pixel of
 * nothing: a session that has never run (`0` is correct, there is nothing to report), a session
 * that ran but whose provider reported no priced usage (unknown), and a host that doesn't send
 * `cost` at all (also unknown). Live data shows the middle case is common — conversations with real
 * entries whose usage ledger totals `0` — so silence there reads as "this cost nothing".
 *
 * The distinction only needs the number and whether the session has run:
 * - never ran → `none`: no badge, because there is nothing to report;
 * - ran, `cost > 0` → `priced`: the badge as before, formatted by `formatCost`;
 * - ran, `cost === 0` or absent → `unknown`: an explicit "Cost unknown".
 */

export type SessionCostState =
  /** No turn has run: nothing has been spent, so nothing is claimed. */
  | { kind: 'none' }
  | { kind: 'priced'; cost: number }
  /** The session ran, and the host's ledger reported no cost for those turns. */
  | { kind: 'unknown' };

/**
 * @param cost   the session summary's `cost` (`undefined` when the host sends none, `0` when its
 *               ledger totals zero or the provider doesn't price the model)
 * @param hasRun whether the session has entries at all — the transcript is non-empty
 */
export const sessionCostState = (cost: number | undefined, hasRun: boolean): SessionCostState => {
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) return { kind: 'priced', cost };
  if (!hasRun) return { kind: 'none' };
  return { kind: 'unknown' };
};

/** The badge's word for the unknown state. */
export const COST_UNKNOWN_LABEL = 'Cost unknown';

/**
 * The tooltip: names the actor (the host's usage ledger), says what it reported, and gives the
 * reader the conclusion to draw — the provider probably doesn't price this model.
 */
export const COST_UNKNOWN_TITLE =
  "ember-harness's usage ledger reported no cost for this session's turns. The provider may not price this model, so spend can't be shown here.";

/** The badge's tooltip for a priced session. */
export const COST_PRICED_TITLE = "Spent on this session, from the host's own usage ledger";

/**
 * Whether a host's sessions carry a spend figure at all.
 *
 * **Hearth only.** Its usage ledger prices every turn and the number is exact, which is what the
 * badge promises. An OpenChamber instance reports a per-message `cost` too, but it is the model's
 * *rate* applied to its own token counts — a local estimate rather than a bill, and one that has
 * never been reconciled against a provider's invoice. Showing it under the same badge as Hearth's
 * ledger would make two different kinds of number look like one truth, and the reader has no way to
 * tell which they are looking at.
 *
 * So OpenChamber sessions show no cost at all — not "Cost unknown", which would be a claim that the
 * host *tried* and failed. Cost is simply not one of the things an OpenChamber session reports.
 */
export const hostReportsCost = (instanceKind: string | undefined): boolean => instanceKind === 'pi';
