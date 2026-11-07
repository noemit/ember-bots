import * as React from 'react';
import { motion, useIsPresent } from 'motion/react';

/** An outgoing row remains visible for its handover, but leaves keyboard and accessibility
 * navigation immediately so it cannot compete with the same chat's new docked identity. */
const RailItem = React.forwardRef<HTMLDivElement, { children: React.ReactNode }>(function RailItem({ children }, ref) {
  const present = useIsPresent();
  return <motion.div ref={ref} layout="position" aria-hidden={!present || undefined} inert={!present}
    initial={false} exit={{ opacity: 0, transition: { duration: .2 } }}
    transition={{ layout: { duration: .5, ease: [.22, 1, .36, 1] } }}>
    {children}
  </motion.div>;
});
export default RailItem;
