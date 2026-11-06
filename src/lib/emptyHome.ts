import type { Instance, Session } from '../types';

type Target = Pick<Instance, 'id' | 'status' | 'attachable'>;

/** Prefer the included Kiln, without sending a draft to a hidden or unavailable computer. */
export const newSessionTarget = (instances: readonly Target[], hidden: ReadonlySet<string>): string | null => {
  const ready = instances.filter(instance => !hidden.has(instance.id) && instance.status === 'ready' && instance.attachable);
  return ready.find(instance => instance.id === 'pi:local')?.id ?? ready[0]?.id ?? null;
};

/** An unanswered session request is not evidence that Home is empty. */
export const emptyHomeTarget = (
  instances: readonly Target[],
  sessionsByInstance: Readonly<Record<string, readonly Session[]>>,
  visibleSessionCount: number,
  hidden: ReadonlySet<string>
): string | null => {
  if (visibleSessionCount > 0) return null;
  const visible = instances.filter(instance => !hidden.has(instance.id));
  if (visible.some(instance => instance.status === 'checking' || (instance.attachable && sessionsByInstance[instance.id] === undefined))) return null;
  return newSessionTarget(visible, hidden);
};
