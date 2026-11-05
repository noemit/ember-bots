import * as React from 'react';

/**
 * Stop animating while the window isn't visible.
 *
 * CSS animations keep ticking when the document is hidden, so a minimised Ember window went on
 * paying for every blob breathe and every `animate-pulse` spinner nobody could see. Pausing is
 * deliberate over `animation: none`: the animation keeps its progress, so a spinner or a breathe
 * resumes where it left off instead of snapping back to its first frame.
 *
 * The rule lives in styles.css (`html.motion-paused *`); this only decides when to apply it.
 */
const PAUSED_CLASS = 'motion-paused';
let installed = false;

const apply = (): void => {
  document.documentElement.classList.toggle(PAUSED_CLASS, document.hidden);
};

export const useMotionPause = (): void => {
  React.useEffect(() => {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    apply();
    document.addEventListener('visibilitychange', apply);
    // No teardown: the listener is process-wide and lives as long as the window does.
  }, []);
};
