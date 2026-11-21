import { errorMessageOf } from '../api';
import type { SessionMessageSummary } from '../lib/messageSummary';
import { MAX_OPEN_SESSIONS } from '../lib/workspace';
import { modelRefKey } from '../types';
import type { AvatarIdentity, Session, SessionRef, StoredComposerDraft } from '../types';

// Fast cadence: used while an instance has no live event stream.
export const STATE_POLL_MS = 3000;
export const SESSION_POLL_MS = 10_000;
export const SCHEDULE_POLL_MS = 30_000;
// Slow cadence: the safety net while every instance is streaming events to us.
export const STATE_POLL_LIVE_MS = 30_000;
export const SESSION_POLL_LIVE_MS = 60_000;
export const MESSAGES_POLL_LIVE_MS = 20_000;
// Approvals and questions have no stream event yet (see `PI_RESOURCES`), so a parked prompt is only
// discovered by polling. That is the one thing a live stream does not cover, and it is the one thing
// a person must see promptly, so it keeps the fast cadence whatever the instance's liveness is.
export const PROMPT_POLL_MS = 3000;
export const SCHEDULE_POLL_LIVE_MS = 5 * 60_000;

export const PREVIEW_COUNT = 24;
export const PREVIEW_CONCURRENCY = 4;
// Progressive tails for rail previews, largest last: stop as soon as a preview is found.
export const PREVIEW_LIMITS = [8, 32, 128] as const;
// Transcripts kept warm for instant switching. Preview warming writes summaries only, never the
// message cache, so this covers the visible columns plus a little slack for quick switches.
export const MESSAGE_CACHE_LIMIT = MAX_OPEN_SESSIONS + 4;

export const RECENT_MODEL_COUNT = 5;
export const CREATED_SESSION_GRACE_MS = 2 * 60_000;

/** Models the instance ran most recently, newest first, taken from its sessions' last-used model. */
export const recentModelKeys = (sessions: Session[]): string[] => {
  const keys: string[] = [];
  [...sessions]
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .forEach((session) => {
      if (!session.model) return;
      const key = modelRefKey(session.model);
      if (!keys.includes(key)) keys.push(key);
    });
  return keys.slice(0, RECENT_MODEL_COUNT);
};

export const forSession = <T extends { instanceId: string; sessionId: string }>(
  list: T[],
  selected: SessionRef | null
): T[] =>
  selected
    ? list.filter(
        (request) =>
          request.instanceId === selected.instanceId && request.sessionId === selected.sessionId
      )
    : [];

export const sameIdentity = (a: AvatarIdentity, b: AvatarIdentity): boolean =>
  a.sessionKey === b.sessionKey &&
  a.projectKey === b.projectKey &&
  a.taskKey === b.taskKey &&
  a.colorSeed === b.colorSeed &&
  a.shapeSeed === b.shapeSeed &&
  a.motionSeed === b.motionSeed &&
  a.colorIndex === b.colorIndex &&
  a.color === b.color &&
  a.shapeName === b.shapeName &&
  a.style === b.style;

export const sameStringRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

export const sameSummary = (a: SessionMessageSummary, b: SessionMessageSummary): boolean =>
  a.preview === b.preview && a.failed === b.failed && a.thinking === b.thinking && a.version === b.version;

export const composerDraftSignature = (drafts: Record<string, StoredComposerDraft>): string =>
  JSON.stringify(
    Object.keys(drafts).sort().map((key) => {
      const draft = drafts[key];
      return [key, draft.text, draft.modelId ?? '', draft.variant ?? ''];
    })
  );

export const responseError = (data: unknown, fallback: string, source?: string): string => {
  const detail = errorMessageOf(data);
  const message = detail ?? fallback;
  // Middle-process errors already say "Ember → …"; don't double-label those.
  const origin = data && typeof data === 'object' ? (data as Record<string, unknown>).source : undefined;
  return source && origin !== 'ember' ? `${source}: ${message}` : message;
};

let noteSequence = 0;
export const createNoteId = (): string =>
  `note-${Date.now().toString(36)}-${(noteSequence = (noteSequence + 1) % 0xffff).toString(36)}`;
