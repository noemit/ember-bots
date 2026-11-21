import * as React from 'react';
import { loadSubmissionReceipt, submissionReceiptOf } from '../api';
import type { ActionNotice } from '../hooks/useFeedback';
import type { UnreadDigestState } from '../hooks/useUnreadDigests';
import { confirmAnnotations, type AnnotationGuard } from '../lib/annotationNavigation';
import { annotationNotePatch } from '../lib/annotationNote';
import { pruneAnnotationNotes } from '../lib/annotationDestinations';
import { mergeDraftChanges, type DraftChanges } from '../lib/composerDrafts';
import { isWorker } from '../lib/crew';
import { addNote, removeNote, updateNote } from '../lib/noteStore';
import { recoverStrandedNotes } from '../lib/notes';
import { entryOrdinal } from '../lib/piMapping';
import {
  isMessageRead,
  markAllRead,
  markRead,
  markTimestampRead,
  markUnreadFrom,
  messageReadReceipt,
  pruneSessionReadMarks,
  type MessageReadReceipt,
  undoMessageRead,
} from '../lib/readState';
import { createQuoteLinkId } from '../lib/quoteLinks';
import { setSessionSnoozed, pruneSnoozedSessions } from '../lib/snoozedSessions';
import type { TranscriptCache } from '../lib/transcriptCache';
import type { TranscriptState } from '../lib/transcriptStatus';
import { isUnreadEligible, visibleUnreadItems } from '../lib/unreadDigest';
import { parseSessionKey } from '../lib/workspace';
import { isPiInstance } from '../piApi';
import { sessionKey } from '../types';
import type {
  ChatMessage,
  EmberSettings,
  EmberSettingsPatch,
  Instance,
  Project,
  QuoteAnchor,
  QuoteLink,
  Session,
  SessionRef,
} from '../types';
import { composerDraftSignature, createNoteId } from './appHelpers';

export type QuoteNavigationTarget = {
  key: string;
  messageId: string;
  token: number;
  source: QuoteAnchor | null;
  destination: QuoteLink['destination'] | null;
};

/**
 * Serializes navigation guards for open inline annotation editors so switching sessions/modals
 * confirms Save/Discard before leaving.
 */
export function useAnnotationNavigationGuard() {
  const annotationNavigationHandlers = React.useRef(new Map<string, AnnotationGuard>());
  const annotationNavigationPending = React.useRef(false);
  const navigateWithAnnotations = React.useCallback((action: () => void) => {
    if (annotationNavigationPending.current) return;
    const allowed = confirmAnnotations([...annotationNavigationHandlers.current.values()]);
    if (typeof allowed === 'boolean') {
      if (allowed) action();
      return;
    }
    annotationNavigationPending.current = true;
    void allowed
      .then(
        (ok) => {
          if (ok) action();
        },
        () => {}
      )
      .finally(() => {
        annotationNavigationPending.current = false;
      });
  }, []);

  return { annotationNavigationHandlers, navigateWithAnnotations };
}

type Options = {
  instances: Instance[];
  instancesLoaded: boolean;
  sessionsByInstance: Record<string, Session[]>;
  projectsByInstance: Record<string, Project[]>;
  activeSession: string | null;
  settings: EmberSettings;
  settingsLoaded: boolean;
  settingsRef: React.RefObject<EmberSettings>;
  handleSettings: (patch: EmberSettingsPatch, options?: { preserveActionError?: boolean }) => Promise<EmberSettings>;
  showActionError: (message: string | null, retry?: () => void, retryLabel?: string, onDismiss?: () => void) => void;
  setActionNotice: (notice: ActionNotice | null) => void;
  unreadDigests: UnreadDigestState;
  messageCacheRef: React.RefObject<TranscriptCache>;
  transcriptsRef: React.RefObject<Record<string, TranscriptState & { messages: ChatMessage[] }>>;
  openSession: (ref: SessionRef, known?: Session | null) => void;
};

/**
 * Owns session notes, composer draft persistence, explicit per-message/session read marks,
 * mute/snooze toggles, quote-link navigation/reconciliation, and settings housekeeping pruners.
 */
export function useAnnotationsAndNotes({
  instances,
  instancesLoaded,
  sessionsByInstance,
  projectsByInstance,
  activeSession,
  settings,
  settingsLoaded,
  settingsRef,
  handleSettings,
  showActionError,
  setActionNotice,
  unreadDigests,
  messageCacheRef,
  transcriptsRef,
  openSession,
}: Options) {
  // Only tiny receipts are retained; transcripts/toasts can unmount independently.
  const readUndoReceipts = React.useRef(new Map<string, MessageReadReceipt>());
  const annotationQueueMutations = React.useRef(new Set<string>());
  const [quoteNavigation, setQuoteNavigation] = React.useState<QuoteNavigationTarget | null>(null);

  // Keep read receipts across archives and while another host's session list is still loading.
  React.useEffect(() => {
    if (!instancesLoaded) return;
    const current = settingsRef.current.readMarks;
    const next = pruneSessionReadMarks(current, sessionsByInstance, instances.map((instance) => instance.id));
    if (Object.keys(next).length === Object.keys(current).length) return;
    void handleSettings({ readMarks: next }, { preserveActionError: true });
  }, [sessionsByInstance, instances, instancesLoaded, handleSettings, settingsRef]);

  // A hidden session keeps its snooze preference so restoring it does not promote it to the main list.
  // Partial/older host snapshots are not proof of deletion; only removed hosts and known workers prune.
  React.useEffect(() => {
    if (!instancesLoaded) return;
    const current = settingsRef.current.snoozedSessions;
    const hosts = new Set(instances.map((instance) => instance.id));
    const removedInstanceIds = new Set<string>();
    const deletedSessionKeys = new Set<string>();
    for (const key of current) {
      const ref = parseSessionKey(key);
      if (!ref) continue; // The settings boundary already rejects malformed keys.
      if (!hosts.has(ref.instanceId)) removedInstanceIds.add(ref.instanceId);
      const session = sessionsByInstance[ref.instanceId]?.find((entry) => entry.id === ref.sessionId);
      if (session && isWorker(session)) deletedSessionKeys.add(key);
    }
    const next = pruneSnoozedSessions(current, { removedInstanceIds, deletedSessionKeys });
    if (next.length !== current.length) void handleSettings({ snoozedSessions: next }, { preserveActionError: true });
  }, [instancesLoaded, instances, sessionsByInstance, settings.snoozedSessions, handleSettings, settingsRef]);

  // Recovery for notes a previous build stranded on the shared project key: 0.13.0's migration
  // (removed in this release) moved a project session's notes onto the project key and deleted the
  // session key, so a saved note left the place the UI reads from and looked lost. The helper puts
  // them back where ChatView looks; `notes.test.ts` covers it.
  React.useEffect(() => {
    if (!settingsLoaded) return;
    const current = settingsRef.current.sessionNotes;
    const recovered = recoverStrandedNotes(current, sessionsByInstance, projectsByInstance, activeSession);
    if (recovered !== current) void handleSettings({ sessionNotes: recovered });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-way recovery; retriggers when sessions load
  }, [settingsLoaded, sessionsByInstance, projectsByInstance, activeSession]);

  const handleComposerDraftsChange = React.useCallback(
    (changes: DraftChanges) => {
      const drafts = mergeDraftChanges(settingsRef.current.composerDrafts, changes);
      const composerDrafts = Object.fromEntries(
        Object.entries(drafts)
          .filter(
            ([key, draft]) =>
              key.length > 0 &&
              key.length <= 500 &&
              (draft.text.trim() || draft.modelId || draft.variant)
          )
          .slice(-50)
          .map(([key, draft]) => [
            key,
            {
              text: draft.text.slice(0, 200_000),
              ...(draft.modelId ? { modelId: draft.modelId } : {}),
              ...(draft.variant ? { variant: draft.variant } : {}),
              updatedAt: draft.updatedAt || Date.now(),
            },
          ])
      );
      if (composerDraftSignature(composerDrafts) === composerDraftSignature(settingsRef.current.composerDrafts)) return;
      void handleSettings({ composerDraftChanges: changes }, { preserveActionError: true });
    },
    [handleSettings, settingsRef]
  );

  const navigateQuote = React.useCallback(
    (link: QuoteLink, direction: 'source' | 'destination') => {
      const key = direction === 'source' ? link.source.sessionKey : link.destination.sessionKey;
      const ref = parseSessionKey(key);
      if (!ref) return;
      openSession(ref);
      const messageId =
        direction === 'source'
          ? link.source.spans[0]?.messageId
          : link.destination.kind === 'message'
            ? link.destination.id
            : null;
      setQuoteNavigation((previous) => ({
        key,
        messageId: messageId ?? '',
        token: (previous?.token ?? 0) + 1,
        source: direction === 'source' ? link.source : null,
        destination: direction === 'destination' ? link.destination : null,
      }));
    },
    [openSession]
  );

  const saveAnnotationNote = React.useCallback(
    async (key: string, text: string, source: QuoteAnchor, requestId = createQuoteLinkId()): Promise<boolean> => {
      const { sessionNotes, quoteLinks, link } = annotationNotePatch(
        settingsRef.current.sessionNotes,
        settingsRef.current.quoteLinks,
        key,
        text,
        source,
        requestId
      );
      if (!sessionNotes[key]?.some((note) => note.id === link.destination.id)) return false;
      try {
        const stored = await handleSettings({ sessionNotes, quoteLinks });
        if (!stored.quoteLinks.some((entry) => entry.id === link.id)) {
          showActionError(
            'Ember could not retain this annotation’s source link. Shorten the selected passage, then try Note again.'
          );
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    [handleSettings, settingsRef, showActionError]
  );

  // Only authoritative submission records move links. An absent record or temporary outage
  // keeps its last proven identity; explicit cancellation removes links through its receipt.
  React.useEffect(() => {
    let disposed = false;
    const reconcile = async () => {
      const links = settingsRef.current.quoteLinks
        .filter((link) => link.destination.kind === 'queue')
        .slice(0, 100);
      for (const link of links) {
        const ref = parseSessionKey(link.destination.sessionKey);
        if (!ref || !isPiInstance(ref.instanceId) || annotationQueueMutations.current.has(link.destination.sessionKey)) {
          continue;
        }
        const result = await loadSubmissionReceipt(ref.instanceId, ref.sessionId, link.destination.id).catch(() => null);
        if (disposed || !result) return;
        if (annotationQueueMutations.current.has(link.destination.sessionKey)) continue;
        const receipt = result.ok ? submissionReceiptOf(result.data, true) : null;
        if (!receipt || (receipt.kind === 'queue' && receipt.id === link.destination.id)) continue;
        const quoteLinks = settingsRef.current.quoteLinks.flatMap((current) => {
          if (current.id !== link.id || current.destination.kind !== 'queue' || current.destination.id !== link.destination.id) {
            return [current];
          }
          return [{ ...current, destination: { kind: receipt.kind, sessionKey: current.destination.sessionKey, id: receipt.id } }];
        });
        await handleSettings({ quoteLinks }).catch(() => {});
      }
    };
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [settingsRef, handleSettings]);

  const handleSaveNote = React.useCallback(
    (key: string, text: string) => {
      if (!key) return;
      const next = addNote(settingsRef.current.sessionNotes, key, { id: createNoteId(), text });
      if (next === settingsRef.current.sessionNotes) return;
      void handleSettings({ sessionNotes: next, quoteLinks: pruneAnnotationNotes(settingsRef.current.quoteLinks, next) });
    },
    [handleSettings, settingsRef]
  );

  /**
   * Save an edit to one note — its text, its model, or both.
   *
   * The write is a patch against the store as it is *now*, not a copy of what was on screen when the
   * dialog opened: a note saved from the composer in the meantime, or an edit to a different note,
   * must both survive. `updateNote` replaces only the one entry by id.
   */
  const handleUpdateNote = React.useCallback(
    (key: string, noteId: string, patch: { text?: string; modelId?: string; variant?: string }) => {
      if (!key) return;
      const next = updateNote(settingsRef.current.sessionNotes, key, noteId, patch);
      if (next === settingsRef.current.sessionNotes) return;
      void handleSettings({ sessionNotes: next });
    },
    [handleSettings, settingsRef]
  );

  const handleDeleteNote = React.useCallback(
    (key: string, noteId: string) => {
      if (!key) return;
      const next = removeNote(settingsRef.current.sessionNotes, key, noteId);
      if (next === settingsRef.current.sessionNotes) return;
      void handleSettings({
        sessionNotes: next,
        quoteLinks: settingsRef.current.quoteLinks.filter(
          (link) => !(link.destination.kind === 'note' && link.destination.sessionKey === key && link.destination.id === noteId)
        ),
      });
    },
    [handleSettings, settingsRef]
  );

  /** Explicit per-message acknowledgement; opening or scrolling never marks a reply read. */
  const handleMarkMessageReadInColumn = React.useCallback(
    (session: Session, message: ChatMessage) => {
      if (!isUnreadEligible(message)) return;
      const key = sessionKey(session);
      const current = settingsRef.current.readMarks[key];
      const ordinal = entryOrdinal(message.id);
      const at = message.completedAt ?? message.createdAt ?? Date.now();
      const receipt = messageReadReceipt(current, ordinal, at, message.id);
      if (receipt.wasRead) return;
      const receiptKey = JSON.stringify([key, message.id]);
      readUndoReceipts.current.delete(receiptKey);
      readUndoReceipts.current.set(receiptKey, receipt);
      if (readUndoReceipts.current.size > 2000) {
        readUndoReceipts.current.delete(readUndoReceipts.current.keys().next().value!);
      }
      if (ordinal !== null) {
        const digestUnread = visibleUnreadItems(unreadDigests.digests[key], current)
          .map((entry) => entry.ordinal)
          .filter((o): o is number => o !== null);
        const heldMessages = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
        const transcriptUnread = heldMessages
          .filter(
            (m) =>
              isUnreadEligible(m) &&
              !isMessageRead(current, entryOrdinal(m.id), m.completedAt ?? m.createdAt ?? 0, m.id)
          )
          .map((m) => entryOrdinal(m.id))
          .filter((o): o is number => o !== null);
        const unread = [...new Set([...digestUnread, ...transcriptUnread])];
        const next = markRead(current, ordinal, unread, Date.now());
        if (next === current) return;
        void handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
        return;
      }
      const next = markTimestampRead(current, at, message.id);
      if (next === current) return;
      void handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
    },
    [handleSettings, messageCacheRef, settingsRef, transcriptsRef, unreadDigests.digests]
  );

  const handleUndoMarkMessageReadInColumn = React.useCallback(
    function handleUndoMarkMessageReadInColumn(session: Session, message: ChatMessage) {
      const key = sessionKey(session);
      const receiptKey = JSON.stringify([key, message.id]);
      const receipt = readUndoReceipts.current.get(receiptKey);
      if (!receipt) return;
      const current = settingsRef.current.readMarks[key];
      try {
        const next = undoMessageRead(current, receipt);
        readUndoReceipts.current.delete(receiptKey);
        if (!next || next === current) return;
        void handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
      } catch (error) {
        showActionError(
          error instanceof Error ? error.message : 'Ember could not undo this read mark. Try Undo again.',
          () => handleUndoMarkMessageReadInColumn(session, message)
        );
      }
    },
    [handleSettings, settingsRef, showActionError]
  );

  /**
   * "Mark as unread": the inverse of a per-message receipt. A read mark is a watermark, so this
   * rewinds it to just below the pressed reply — that reply and everything after it become unread,
   * which is what the rail and the unread digest then show. It never goes the other way: a reply
   * already unread leaves the mark as it is.
   */
  const handleMarkMessageUnreadInColumn = React.useCallback(
    (session: Session, message: ChatMessage) => {
      if (isWorker(session)) return;
      const key = sessionKey(session);
      const current = settingsRef.current.readMarks[key];
      const ordinal = entryOrdinal(message.id);
      const at = message.completedAt ?? message.createdAt ?? 0;
      if (ordinal === null && at <= 0) return;
      const next = markUnreadFrom(current, ordinal, at);
      if (next === current) return;
      // The column's own receipt is not an acknowledgement any more; a later read wins again.
      readUndoReceipts.current.delete(JSON.stringify([key, message.id]));
      void handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
    },
    [handleSettings, settingsRef]
  );

  /** Muting notifications leaves every explicit read mark intact. */
  const handleQuietChange = React.useCallback(
    (session: Session, quiet: boolean) => {
      const key = sessionKey(session);
      const muted = new Set(settingsRef.current.mutedSessions ?? []);
      if (quiet) muted.add(key);
      else muted.delete(key);
      void handleSettings({ mutedSessions: [...muted] }, { preserveActionError: true });
    },
    [handleSettings, settingsRef]
  );

  /** Snoozing changes rail placement only; running work and explicit read marks stay intact. */
  const handleSnooze = React.useCallback(
    (session: Session, snoozed: boolean) => {
      if (isWorker(session)) return;
      const key = sessionKey(session);
      const change = (next: boolean) => {
        void handleSettings(
          { snoozedSessions: setSessionSnoozed(settingsRef.current.snoozedSessions, key, next) },
          { preserveActionError: true }
        );
      };
      change(snoozed);
      setActionNotice({
        message: snoozed ? 'Session moved to Snoozed. Its work and notifications stay on.' : 'Session returned to the main list.',
        actionLabel: 'Undo',
        action: () => change(!snoozed),
      });
    },
    [handleSettings, setActionNotice, settingsRef]
  );

  /** Right-click "Mark all as read": everything the host has, including out-of-order marks. */
  const handleMarkAllRead = React.useCallback(
    (session: Session) => {
      const key = sessionKey(session);
      const current = settingsRef.current.readMarks[key];
      // Hearth reports the newest entry id; a wire without one falls back to the message the digest
      // saw, then to the session's own update time for the timestamp rule.
      const through =
        session.lastEntryId ??
        Math.max(
          0,
          ...visibleUnreadItems(unreadDigests.digests[key], current).map((item) => item.ordinal ?? 0)
        );
      const next = markAllRead(current, through, Date.now());
      if (next === current) return;
      void handleSettings({ readMarks: { ...settingsRef.current.readMarks, [key]: next } });
    },
    [handleSettings, settingsRef, unreadDigests.digests]
  );

  return {
    annotationQueueMutations,
    quoteNavigation,
    setQuoteNavigation,
    navigateQuote,
    saveAnnotationNote,
    handleComposerDraftsChange,
    handleSaveNote,
    handleUpdateNote,
    handleDeleteNote,
    handleMarkMessageReadInColumn,
    handleUndoMarkMessageReadInColumn,
    handleMarkMessageUnreadInColumn,
    handleQuietChange,
    handleSnooze,
    handleMarkAllRead,
  };
}
