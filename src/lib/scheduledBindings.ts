/** Keep observed runs when an older host reports only its latest run, and retain the entire
 * ledger from newer hosts. A size cap would silently lose readable scheduled history.
 */
export const mergeScheduledSessionBindings = (
  current: Readonly<Record<string, string>>,
  discovered: Readonly<Record<string, string>>
): Record<string, string> => ({ ...current, ...discovered });
