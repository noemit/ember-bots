import type { Session } from '../types';

export type ProjectUsage = { path: string; count: number; lastUsed: number };
export const PROJECT_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Loaded host catalogue, never a workspace-root filter. A start counts once per chat,
 * not once per poll, folder visit or reply. Unknown start times remain searchable but
 * cannot honestly contribute frequency/recency; updated is deliberately never a fallback.
 */
export const projectUsageForHost = (
  sessions: readonly Session[],
  instanceId: string,
  now = Date.now(),
  scheduledSessionIds: ReadonlySet<string> = new Set(),
): ProjectUsage[] => {
  const distinct = new Map<string, Session>();
  for (const session of sessions) {
    if (session.instanceId !== instanceId) continue;
    const previous = distinct.get(session.id);
    // Duplicate snapshots resolve consistently to the newest authoritative summary.
    if (!previous || (session.updated ?? 0) > (previous.updated ?? 0)) distinct.set(session.id, session);
  }
  const paths = new Map<string, ProjectUsage>();
  for (const session of distinct.values()) {
    if (!session.directory || session.archived || session.kind === 'worker' || session.parentId || scheduledSessionIds.has(session.id)) continue;
    const usage = paths.get(session.directory) ?? { path: session.directory, count: 0, lastUsed: 0 };
    const started = session.createdAt;
    if (typeof started === 'number' && Number.isFinite(started) && started > 0 && started <= now) {
      usage.lastUsed = Math.max(usage.lastUsed, started);
      if (started >= now - PROJECT_USAGE_WINDOW_MS) usage.count += 1;
    }
    paths.set(usage.path, usage);
  }
  return [...paths.values()].sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};
