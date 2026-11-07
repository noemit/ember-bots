import { modelRefKey } from '../types';
import type { InstanceDefaults, Project, Session } from '../types';
import { isWorker } from './crew';

const byRecency = <T extends { updated?: number }>(a: T, b: T) => (b.updated ?? 0) - (a.updated ?? 0);

/**
 * Where a new agent should start on an instance: the saved default folder, then the directory
 * of the most recently updated session (real recent work), then the project opened most
 * recently in OpenChamber.
 */
export const newSessionDirectoryPrefill = (
  sessions: Session[],
  projects: Project[],
  defaults: InstanceDefaults
): string | null => {
  if (defaults.directory) return defaults.directory;
  const recentSession = [...sessions].filter((session) => session.directory).sort(byRecency)[0]?.directory;
  if (recentSession) return recentSession;
  const recentProject = projects
    .filter((project) => project.path && project.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]?.path;
  return recentProject ?? defaults.workspaceDirectory ?? null;
};

/** Recent folders are per host, distinct, and led by human-facing chats. */
export const recentProjectDirectories = (sessions: Session[]): string[] =>
  [...new Set([...sessions].filter((session) => !isWorker(session) && !session.archived && session.directory)
    .sort(byRecency).map((session) => session.directory!))].slice(0, 6);

export type ModelPrefill = { key: string; variant: string };

/**
 * Model for a new agent: the per-instance default setting when set, otherwise `null` so the
 * composer falls back to the server default. The most recent session's model is deliberately
 * *not* used — a recent one-off (an image model, say) would otherwise silently hijack every new
 * agent, which reads as the model changing at random.
 */
export const newSessionModelPrefill = (defaults: InstanceDefaults): ModelPrefill | null => {
  if (!defaults.model) return null;
  return {
    key: modelRefKey(defaults.model),
    variant: defaults.variant ?? defaults.model.variant ?? '',
  };
};
