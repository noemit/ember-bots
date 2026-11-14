/** Bounded policy for a jump whose target may not be loaded yet. */
export const messageNavigationAction = (state: { found: boolean; loading: boolean; complete: boolean; attempts: number; canLoad: boolean }): 'jump' | 'wait' | 'load' | 'unavailable' => {
  if (state.found) return 'jump';
  if (state.loading) return 'wait';
  if (state.complete || !state.canLoad || state.attempts >= 3) return 'unavailable';
  return 'load';
};
