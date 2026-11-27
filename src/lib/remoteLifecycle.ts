import { questionDrafts } from './asyncQuestionDrafts';
import { composerMemory } from './composerDrafts';
// Recovery is not a send preview: retain the exact annotation, quote and whitespace.
export type RemoteAuxiliaryDraft = { question: string; annotationDraft: string; annotationQuote: string };
export const remoteAuxiliaryDrafts = new Map<string, RemoteAuxiliaryDraft>();
/** Unacknowledged sends refused on remote session expiry, held in page memory for explicit copy only. */
export const remoteRefusedSends = new Map<string, string>();
export const REMOTE_UNSENT_CHANGED_EVENT = 'ember:remote-unsent-changed';
export const recordRemoteRefusedSend = (id: string, text: string) => {
  if (!text.trim()) return;
  remoteRefusedSends.set(id, text);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(REMOTE_UNSENT_CHANGED_EVENT));
  }
};
export const remoteUnsentText = () => [...new Set([
  ...[...composerMemory.values()].map((draft) => draft.text),
  ...[...remoteRefusedSends.values()],
  ...questionDrafts.unsentTexts(),
  ...[...remoteAuxiliaryDrafts.values()].flatMap((draft) => [draft.question,
    draft.annotationDraft || draft.annotationQuote
      ? `Quoted text:\n${draft.annotationQuote}\nYour annotation:\n${draft.annotationDraft}` : '',
  ]),
].filter((text) => text.trim()))].join('\n\n');

export type RemoteConnectionState = 'online' | 'offline' | 'unavailable' | 'expired';
export const REMOTE_CONNECTION_EVENT = 'ember:remote-connection';
let remote = false;
let expired = false;
let activeWork = false;
let requests = 0;
const draftBlockers = new Set<string>();
export const setRemoteDraftBlocker = (key: string, blocked: boolean) => {
  if (blocked) draftBlockers.add(key); else draftBlockers.delete(key);
};

export const isRemoteBrowser = () => remote;
export const isRemoteExpired = () => expired;
/** Update prompts must call this at click time, not just when displaying the prompt. */
export const canReloadRemote = () => !activeWork && requests === 0 && draftBlockers.size === 0 && remoteAuxiliaryDrafts.size === 0 &&
  remoteRefusedSends.size === 0 &&
  !questionDrafts.hasUnsent() &&
  ![...composerMemory.values()].some((draft) => draft.text.length || draft.attachments.length || draft.replyContext);
export const setRemoteActiveWork = (active: boolean) => { activeWork = active; };
export const trackRemoteRequest = (delta: number) => { requests = Math.max(0, requests + delta); };
export const reportRemoteConnection = (state: RemoteConnectionState) => {
  if (expired && state !== 'expired') return;
  if (state === 'expired') {
    expired = true;
    // Hide authenticated content synchronously, before React handles the event. Drafts stay in
    // memory for the locked screen's explicit Copy action; navigation intentionally discards them.
    document.body.dataset.remoteExpired = 'true';
  }
  window.dispatchEvent(new CustomEvent(REMOTE_CONNECTION_EVENT, { detail: { state } }));
};
export const installRemoteLifecycle = () => {
  remote = true;
  window.addEventListener('ember:can-reload', (event) => {
    if (!canReloadRemote()) event.preventDefault();
  });
  window.addEventListener('beforeunload', (event) => {
    if (canReloadRemote()) return;
    event.preventDefault();
    event.returnValue = '';
  });
};
/** Reset module-level remote lifecycle flags between unit tests. */
export const resetRemoteLifecycleForTest = () => {
  remote = false;
  expired = false;
  activeWork = false;
  requests = 0;
  draftBlockers.clear();
  remoteRefusedSends.clear();
};
