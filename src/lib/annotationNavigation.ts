export type AnnotationGuard = () => boolean | Promise<boolean>;

/** Clean editors preserve synchronous navigation. Dirty editors are consulted in order and a
 * cancellation or unmount stops the original action; no synthetic clicks or inferred answers. */
export function confirmAnnotations(guards: readonly AnnotationGuard[]): boolean | Promise<boolean> {
  for (let index = 0; index < guards.length; index++) {
    const result = guards[index]();
    if (typeof result !== 'boolean') return result.then(allowed => allowed ? confirmAnnotations(guards.slice(index + 1)) : false);
    if (!result) return false;
  }
  return true;
}
