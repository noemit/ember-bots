import type { SubmissionReceipt } from '../api';

export type AnnotationAcceptance =
  | { kind: 'linked'; receipt: SubmissionReceipt }
  | { kind: 'missing-receipt' }
  | { kind: 'persistence-failed' };

/** A transport success alone never authorizes clearing an annotation draft. */
export const recordAnnotationAcceptance = async (
  receipt: SubmissionReceipt | null,
  persist: (receipt: SubmissionReceipt) => Promise<void>
): Promise<AnnotationAcceptance> => {
  if (!receipt) return { kind: 'missing-receipt' };
  try { await persist(receipt); return { kind: 'linked', receipt }; }
  catch { return { kind: 'persistence-failed' }; }
};
