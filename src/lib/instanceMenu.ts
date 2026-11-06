import { instanceReady } from './instanceHealth';
import type { Instance } from '../types';

/**
 * What the Instances menu may offer for one row.
 *
 * Two different wishes share that menu, and conflating them is what made a dead container
 * impossible to get rid of: **hide** is "not right now" and only means something for a host that
 * can answer, while **forget** is "this instance no longer exists" and is precisely what you want
 * for a host that will never answer again. The checkbox used to be the only control and it was
 * disabled unless the host was ready, so the one state that needed a way out had none.
 */
export type InstanceMenuState = {
  /** Whether the row's sessions are showing. Only ever true for a host that can answer. */
  checked: boolean;
  /** Hiding needs sessions to hide: an unreachable host has nothing to toggle. */
  canToggle: boolean;
  /** Forgetting is offered for anything still listed, reachable or not. Hidden rows can be restored. */
  canForget: boolean;
};

export const instanceMenuState = (
  instance: Instance,
  hidden: ReadonlySet<string>
): InstanceMenuState => {
  const isHidden = hidden.has(instance.id);
  const ready = instanceReady(instance);
  return {
    checked: ready && !isHidden,
    canToggle: ready,
    canForget: !isHidden,
  };
};
