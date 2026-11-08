import * as React from 'react';
import { motion } from 'motion/react';

/** Enable shared identity movement only within a navigation surface, never between duplicate
 * transcript, settings, or reading-view avatars. The renderer does not know the workspace layout. */
export const AvatarTransitionContext = React.createContext(false);
export default function AvatarTransition({ seed, children }: { seed: string; children: React.ReactNode }) {
  const enabled = React.useContext(AvatarTransitionContext);
  if (!enabled) return children;
  // Move identities between rail slots without scaling their fixed-pixel notification badges.
  return <motion.span data-avatar-key={seed} layout="position" layoutId={`chat-avatar:${seed}`} className="relative inline-flex flex-none" transition={{ layout: { duration: .6, ease: [.22, 1, .36, 1] } }}>
    {children}
  </motion.span>;
}
