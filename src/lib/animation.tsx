import type { Transition } from 'motion/react';

export const springTransition: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 34,
  mass: 0.8,
};
