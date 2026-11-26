import * as React from 'react';
import {
  loadMessageAppend,
  loadMessageHistory,
  loadMessages,
  loadMessageTail,
  loadMessageTailPage,
  MESSAGE_TAIL_LIMIT,
  OPEN_MESSAGE_TAIL_LIMIT,
  type PromptInput,
} from '../api';
import type { ActionNotice } from '../hooks/useFeedback';
import { applyLiveDeltas, StreamDeltaCoalescer } from '../lib/liveStream';
import { sessionIsLoaded } from '../lib/invalidation';
import { summarizeMessages, type SessionMessageSummary } from '../lib/messageSummary';
import { observationsFor, observeModels } from '../lib/modelStats';
import {
  applyLiveToolOutput,
  newestEntryId,
  settleToolResults,
  type LiveToolOutput,
  type ToolResultSettlement,
} from '../lib/piMapping';
import { ReadCoordinator } from '../lib/readCoordinator';
import { classifyFullReadFailure, RepairBudget, type FullReadFailure, type RepairHalt } from '../lib/repairBudget';
import { type AbortReceipt, unconfirmedSendMessage } from '../lib/sendDelivery';
import { missingSent, PENDING_SEND_TTL_MS, type SentLedger } from '../lib/sentLedger';
import { TranscriptCache } from '../lib/transcriptCache';
import { applyTranscriptCommit } from '../lib/transcriptCommit';
import {
  reconcileFullTranscript,
  reconcileTranscriptAppend,
  reconcileTranscriptTail,
} from '../lib/transcriptReconciliation';
import type { TranscriptFailureSource, TranscriptState } from '../lib/transcriptStatus';
import { useStableCallback } from '../lib/useStableCallback';
import { parseSessionKey, pruneTranscripts, transcriptKeysToKeep } from '../lib/workspace';
import { sessionKey } from '../types';
import type { ChatMessage, LiveDelta, MessagesStatus, Session, SessionRef } from '../types';
import { MESSAGE_CACHE_LIMIT, sameSummary } from './appHelpers';

export type PendingSendInput = { target: SessionRef; directory?: string; input: PromptInput; submissionId?: string };

type Options = {
  transcripts: Record<string, TranscriptState & { messages: ChatMessage[] }>;
  setTranscripts: React.Dispatch<
    React.SetStateAction<Record<string, TranscriptState & { messages: ChatMessage[] }>>
  >;
  summaries: Record<string, SessionMessageSummary>;
  setSummaries: React.Dispatch<React.SetStateAction<Record<string, SessionMessageSummary>>>;
  setRepairHalts: React.Dispatch<React.SetStateAction<Record<string, RepairHalt>>>;
  openSessions: string[];
  activeSession: string | null;
  minimizedSessions: Set<string>;
  workspaceWidth: number;
  watchedSessionKeys: string[];
  watchedSessionKeysRef: React.RefObject<string[]>;
  activeSessionRef: React.RefObject<string | null>;
  sessionsByInstanceRef: React.RefObject<Record<string, Session[]>>;
  setActionNotice: (notice: ActionNotice | null) => void;
  onReplayMissingSendRef: React.RefObject<((replay: PendingSendInput) => void) | null>;
};

/**
 * Manages the bounded LRU transcript cache, optimistic-send tracking/reconciliation,
 * stream delta coalescer ref, compact rail summaries, repair breaker, and REST transcript loaders.
 */
export function useTranscriptStore({
  transcripts,
  setTranscripts,
  summaries,
  setSummaries,
  setRepairHalts,
  openSessions,
  activeSession,
  minimizedSessions,
  workspaceWidth,
  watchedSessionKeys,
  watchedSessionKeysRef,
  activeSessionRef,
  sessionsByInstanceRef,
  setActionNotice,
  onReplayMissingSendRef,
}: Options) {
  // Pending optimistic sends, scoped per session so one column's fetch can never release another's.
  const pendingOptimisticIds = React.useRef(new Map<string, Set<string>>());
  /** When each pending send was made, so a send whose echo never arrives can age out. */
  const pendingSentAt = React.useRef(new Map<string, number>());
  /**
   * Sends whose echo never came: no longer pending (the ledger may report them, nothing pretends an
   * answer is on its way), but still held on screen, because the words are the user's and a bubble
   * that quietly disappears is worse than one that says "Not confirmed".
   */
  const unconfirmedSends = React.useRef(new Set<string>());
  /** The last stop's receipt per session: what the host kept, while the queue read catches up. */
  const abortReceipts = React.useRef(new Map<string, AbortReceipt & { at: number }>());
  // A bounded record of what Ember sent, so a message missing from a later fetch is noticed.
  const sentLedgerRef = React.useRef<SentLedger>(new Map());
  const flaggedMissingSends = React.useRef(new Set<string>());
  // The input behind each optimistic send, so a failed bubble can be retried with exactly what
  // was sent (attachments, reply context, steer) rather than a reconstruction.
  const pendingInputs = React.useRef(new Map<string, PendingSendInput>());
  // Staged follow-up queue ids held back when a new session's first send failed, keyed by that
  // failed bubble's id so Send again can resume them in FIFO order once the host accepts it.
  const heldFollowUpsByTriggerId = React.useRef(new Map<string, string[]>());

  const pendingFor = React.useCallback((key: string): Set<string> => {
    let ids = pendingOptimisticIds.current.get(key);
    if (!ids) {
      ids = new Set();
      pendingOptimisticIds.current.set(key, ids);
    }
    return ids;
  }, []);

  const releaseOptimistic = React.useCallback((key: string, ids: readonly string[]) => {
    if (ids.length === 0) return;
    ids.forEach((id) => {
      unconfirmedSends.current.delete(id);
      pendingSentAt.current.delete(id);
    });
    const pending = pendingOptimisticIds.current.get(key);
    if (!pending) return;
    ids.forEach((id) => {
      pending.delete(id);
      pendingInputs.current.delete(id);
    });
    if (pending.size === 0) pendingOptimisticIds.current.delete(key);
  }, []);

  /**
   * A send whose echo never arrived stops being "pending".
   *
   * Pending is a promise that an answer is coming; after `PENDING_SEND_TTL_MS` the evidence is
   * against it. The bubble is *kept* (`unconfirmedSends` protects it the way a retained failure is
   * protected) and its own note says what happened, so the words never vanish. What changes is that
   * the ledger may now report it, and no code path keeps re-appending a bubble for ever on the
   * strength of a request id that will never be answered.
   */
  const ageOutPendingSend = React.useCallback((key: string, messages: readonly ChatMessage[], now: number) => {
    const ids = pendingOptimisticIds.current.get(key);
    if (!ids || ids.size === 0) return;
    for (const id of [...ids]) {
      const message = messages.find((entry) => entry.id === id);
      const since = pendingSentAt.current.get(id) ?? message?.createdAt;
      if (since === undefined || now - since < PENDING_SEND_TTL_MS) continue;
      ids.delete(id);
      unconfirmedSends.current.add(id);
      // Nothing will ask when this was sent again: the bubble's own `createdAt` drives its note.
      pendingSentAt.current.delete(id);
    }
    if (ids.size === 0) pendingOptimisticIds.current.delete(key);
  }, []);

  /** Forget every trace of an optimistic send: pending id, stored input and ledger record. */
  const forgetPendingSend = React.useCallback((key: string, messageId: string) => {
    pendingOptimisticIds.current.get(key)?.delete(messageId);
    pendingSentAt.current.delete(messageId);
    unconfirmedSends.current.delete(messageId);
    pendingInputs.current.delete(messageId);
    const records = sentLedgerRef.current.get(key);
    if (records) {
      sentLedgerRef.current.set(key, records.filter((record) => record.id !== messageId));
    }
  }, []);

  const protectedTranscriptKeys = React.useRef(new Set<string>());
  protectedTranscriptKeys.current = new Set(watchedSessionKeys);

  const messageCacheRef = React.useRef(
    new TranscriptCache(
      () =>
        new Set([
          ...protectedTranscriptKeys.current,
          ...[...pendingOptimisticIds.current].filter(([, ids]) => ids.size > 0).map(([key]) => key),
        ]),
      undefined,
      MESSAGE_CACHE_LIMIT
    )
  );
  // A rendered transcript can outlive its LRU cache entry; read it through a ref so a tail still
  // merges against what is on screen rather than treating the column as empty.
  const transcriptsRef = React.useRef(transcripts);
  transcriptsRef.current = transcripts;
  const summariesRef = React.useRef<Record<string, SessionMessageSummary>>(summaries);
  summariesRef.current = summaries;
  // One deduplicated full repair per session when a tail has no safe overlap to merge.
  const fullRepairRef = React.useRef<(key: string) => void>(() => {});
  const fullRepairInFlight = React.useRef(new Set<string>());
  /** Consecutive failed full reads, per session, and where to stop starting them (lib/repairBudget). */
  const repairBudget = React.useRef(new RepairBudget());
  // The session `updated` each cached transcript reflects. A newer `updated` means it is stale,
  // however recently it was read.
  const transcriptVersion = React.useRef(new Map<string, number>());

  const cacheMessages = React.useCallback((key: string, messagesForSession: ChatMessage[]) => {
    const cache = messageCacheRef.current;
    cache.delete(key);
    cache.set(key, messagesForSession);
    cache.prune();
  }, []);

  const setTranscriptFor = React.useCallback(
    (
      key: string,
      messagesForSession: ChatMessage[],
      status: MessagesStatus = 'ready',
      failure?: TranscriptFailureSource
    ) => {
      setTranscripts((prev) => {
        const current = prev[key];
        if (
          current &&
          current.messages === messagesForSession &&
          current.status === status &&
          current.failure === failure
        ) {
          return prev;
        }
        // Keep every other field the transcript carries (`historyComplete` and anything added
        // later). Rebuilding the object from three keys is how a completed history reverted to
        // "loading earlier messages" on the next commit.
        return { ...prev, [key]: applyTranscriptCommit(current, { messages: messagesForSession, status, failure }) };
      });
    },
    [setTranscripts]
  );

  // PERF-4: the LRU message cache is bounded, but `transcripts` is not — it would otherwise retain
  // every transcript a column ever loaded. Keep only the open sessions, whatever the cache still
  // holds, and the active session; anything else is a fetch away. Reading the cache ref is safe
  // here because every cache write is paired with a transcript write, so this effect re-runs.
  React.useEffect(() => {
    messageCacheRef.current.prune();
    setTranscripts((prev) =>
      pruneTranscripts(
        prev,
        transcriptKeysToKeep([...protectedTranscriptKeys.current], [...messageCacheRef.current.keys()], activeSession)
      )
    );
    for (const key of transcriptVersion.current.keys()) {
      if (!messageCacheRef.current.has(key) && !transcriptsRef.current[key]) transcriptVersion.current.delete(key);
    }
  }, [transcripts, openSessions, activeSession, minimizedSessions, workspaceWidth, setTranscripts]);

  const commitSummary = React.useCallback(
    (key: string, messagesForSession: ChatMessage[], complete: boolean, version?: number) => {
      const summary = summarizeMessages(messagesForSession, {
        previous: summariesRef.current[key],
        complete,
        version,
      });
      setSummaries((prev) => {
        const existing = prev[key];
        if (existing && sameSummary(existing, summary)) return prev;
        return { ...prev, [key]: summary };
      });
    },
    [setSummaries]
  );

  /**
   * A full read that a tail could not reconcile.
   *
   * A request made while a read is already in flight must not be dropped: the in-flight read was
   * started before whatever made the tail unreconcilable, so its answer can still leave the
   * transcript short. Dropping the request is how a reopened session kept rendering only its tail —
   * the cache looked healthy, the tail could not overlap it, the repair was skipped because the
   * poll happened to be mid-read, and nothing tried again.
   */
  const pendingRepair = React.useRef(new Set<string>());
  const requestFullRepair = React.useCallback((key: string) => {
    if (fullRepairInFlight.current.has(key)) {
      // Remember it; the read in flight replays this when it settles.
      pendingRepair.current.add(key);
      return;
    }
    fullRepairInFlight.current.add(key);
    fullRepairRef.current(key);
  }, []);

  const streamDeltaCoalescerRef = React.useRef<StreamDeltaCoalescer | null>(null);

  /**
   * The single transcript commit path. Every fetched full or tail response goes through here so
   * structural sharing, optimistic reconciliation, the message cache and the compact summary stay
   * in lockstep no matter which caller issued the fetch.
   */
  const commitFetchedTranscript = useStableCallback(
    (
      key: string,
      fetched: ChatMessage[],
      mode: 'full' | 'tail' | 'append',
      version?: number,
      repair = true,
      /** Results whose call was committed by an earlier read; applied to the held transcript. */
      settlements?: readonly ToolResultSettlement[],
      /**
       * Output of calls still executing, from the same read. An incremental page is usually empty
       * (the call was committed earlier), so without this a running command's streamed output never
       * reached the row that was already on screen.
       */
      liveOutputs?: readonly LiveToolOutput[]
    ) => {
      const rawCurrent =
        messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
      const bufferedDeltas = streamDeltaCoalescerRef.current?.takeKey(key);
      const current = bufferedDeltas
        ? (applyLiveDeltas(rawCurrent, bufferedDeltas) ?? rawCurrent)
        : rawCurrent;
      const now = Date.now();
      ageOutPendingSend(key, current, now);
      const pending = pendingOptimisticIds.current.get(key) ?? new Set<string>();
      // A send the host said it placed but never echoed back is no longer pending, yet it is still
      // the user's words: reconciliation keeps it exactly as it keeps a retained failure. The two
      // sets differ only in what they claim — pending says an echo is coming, this says it is not.
      const held = new Set(pending);
      unconfirmedSends.current.forEach((id) => held.add(id));
      const outcome =
        mode === 'tail'
          ? reconcileTranscriptTail(current, fetched, held)
          : mode === 'append'
            ? reconcileTranscriptAppend(current, fetched, held)
            : reconcileFullTranscript(current, fetched, held);
      // A tool result is not a message: it carries the settlement of a call that an earlier page
      // already committed. Patch the transcript we hold with it, or the tool row keeps the status it
      // was drawn with and its output is lost. No-op (same array) when nothing actually changed.
      const settled =
        settlements && settlements.length > 0
          ? settleToolResults(outcome.messages, settlements)
          : outcome.messages;
      // A running call's output arrives on the same page that carries no new entries; patch it onto
      // the call already held. No-op (same array) when nothing changed.
      const messages =
        liveOutputs && liveOutputs.length > 0
          ? applyLiveToolOutput(settled, liveOutputs)
          : settled;
      // A background tail with no overlap isn't worth a full fetch nobody is looking at; the stale
      // version makes the next switch-in repair it instead.
      if (outcome.needsFullFetch && !repair) {
        commitSummary(key, fetched, false, version);
        return;
      }
      if (outcome.reconciledOptimisticIds.length > 0) {
        releaseOptimistic(key, outcome.reconciledOptimisticIds);
      }
      // Diagnostic for a reported flash: a message that was on screen and is not pending must never
      // vanish because a *tail* or *append* landed — only an authoritative full read may remove
      // anything (compaction, a fork, a rewrite). If this warns, the id and the mode say which read
      // dropped it, which is the difference between a host returning a short page and a client
      // reconciliation bug. Cheap: only compares ids of the arrays already in hand.
      if (mode !== 'full' && current.length > 0) {
        const kept = new Set(messages.map((message) => message.id));
        const dropped = current.filter((message) => !kept.has(message.id) && !held.has(message.id));
        if (dropped.length > 0) {
          console.warn('[ember] a transcript read removed messages it did not replace', {
            key,
            mode,
            dropped: dropped.map((message) => ({ id: message.id, role: message.role, live: message.live === true })),
          });
        }
      }
      cacheMessages(key, messages);
      setTranscriptFor(key, messages, 'ready');
      commitSummary(key, messages, mode === 'full', version);
      // Sent-message ledger: notice any send that has vanished from the committed transcript.
      for (const record of missingSent(sentLedgerRef.current, key, messages, pending, now)) {
        if (flaggedMissingSends.current.has(record.id)) continue;
        flaggedMissingSends.current.add(record.id);
        console.warn('[ember] a sent message is missing from the transcript', { key, record });
        // The bubble is the usual surface for this (its own "Not confirmed" note). This is the
        // case where the bubble is gone too, so the notice has to carry the text and the way out:
        // a message cannot be reported as lost and then be unreachable.
        const preview = record.text.trim().replace(/\s+/g, ' ').slice(0, 60);
        const replay = pendingInputs.current.get(record.id);
        setActionNotice({
          message: unconfirmedSendMessage(preview),
          ...(replay
            ? {
                actionLabel: 'Send again',
                action: () => {
                  forgetPendingSend(key, record.id);
                  onReplayMissingSendRef.current?.(replay);
                },
              }
            : {}),
        });
      }
      if (outcome.needsFullFetch) requestFullRepair(key);
      else transcriptVersion.current.set(key, version ?? 0);
    }
  );

  /**
   * Apply a streamed chunk to the live message on screen, instead of reading the transcript again.
   *
   * Returns true when the hint is fully handled. False — no live message yet, a session that is not
   * on screen, a transcript that is not settled — means the caller should take the REST path, which
   * is also how the first chunk of a turn arrives and how any drift is corrected.
   */
  const canBufferStreamDeltas = useStableCallback(
    (instanceId: string, sessionId: string): boolean => {
      const key = sessionKey({ instanceId, sessionId });
      if (!sessionIsLoaded({ instanceId, sessionId }, watchedSessionKeysRef.current, activeSessionRef.current, document.hidden)) {
        return false;
      }
      const transcript = transcriptsRef.current[key];
      if (!transcript || transcript.status !== 'ready') return false;
      const current = messageCacheRef.current.get(key) ?? transcript.messages;
      return current.some((message) => message.live === true);
    }
  );

  const applyStreamDeltas = useStableCallback(
    (instanceId: string, sessionId: string, deltas: LiveDelta[]): boolean => {
      const key = sessionKey({ instanceId, sessionId });
      if (!sessionIsLoaded({ instanceId, sessionId }, watchedSessionKeysRef.current, activeSessionRef.current, document.hidden)) {
        return false;
      }
      const transcript = transcriptsRef.current[key];
      // Never append into a transcript that is showing an error or still loading: the read that
      // resolves it is the one that should draw the message.
      if (!transcript || transcript.status !== 'ready') return false;
      const current = messageCacheRef.current.get(key) ?? transcript.messages;
      const next = applyLiveDeltas(current, deltas);
      if (next === null) return false;
      if (next !== current) {
        cacheMessages(key, next);
        setTranscriptFor(key, next, 'ready');
      }
      return true;
    }
  );

  /**
   * Fold a tail that was fetched for a background session's preview into its cached transcript,
   * so switching back renders current messages with no extra request. Sessions without a cached
   * transcript stay summary-only; this never grows the cache.
   */
  const mergeBackgroundTail = useStableCallback(
    (
      key: string,
      tail: ChatMessage[],
      version?: number,
      mode: 'tail' | 'append' = 'tail',
      settlements?: readonly ToolResultSettlement[]
    ) => {
      if (messageCacheRef.current.has(key)) {
        commitFetchedTranscript(key, tail, mode, version, false, settlements);
      }
      // A summary is derived from the messages it is given, so a delta would describe only the newest
      // few turns. A session with no cached transcript keeps the bounded tail for that reason.
      else commitSummary(key, tail, false, version);
    }
  );

  const updateCachedMessages = React.useCallback(
    (key: string, updater: (messagesForSession: ChatMessage[]) => ChatMessage[]) => {
      const next = updater(
        messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? []
      );
      cacheMessages(key, next);
      setTranscriptFor(key, next, 'ready');
    },
    [cacheMessages, setTranscriptFor]
  );

  /**
   * The instant a stop is requested, mark every in-flight tool step in the cached transcript as
   * interrupted so its spinner becomes a `[step interrupted]` row without waiting for the server
   * round trip. The authoritative fetch that follows replaces this with the committed result.
   */
  const markSessionStepsInterrupted = React.useCallback((instanceId: string, sessionId: string) => {
    const key = sessionKey({ instanceId, sessionId });
    streamDeltaCoalescerRef.current?.flushKey(key);
    const current = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages;
    if (!current) return;
    let changed = false;
    const next = current.map((message) => {
      if (!message.parts.some((part) => part.type === 'tool' && (part.call.status === 'running' || part.call.status === 'pending'))) {
        return message;
      }
      changed = true;
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'tool' && (part.call.status === 'running' || part.call.status === 'pending')
            ? { ...part, call: { ...part.call, status: 'interrupted' as const } }
            : part
        ),
      };
    });
    if (changed) {
      cacheMessages(key, next);
      setTranscriptFor(key, next, 'ready');
    }
  }, [cacheMessages, setTranscriptFor]);

  /** Directory + `updated` for a session, read through the ref so pollers stay stable. */
  const sessionMetaFor = React.useCallback(
    (ref: SessionRef): { directory?: string; updated?: number } => {
      const session = (sessionsByInstanceRef.current[ref.instanceId] ?? []).find(
        (entry) => entry.id === ref.sessionId
      );
      return { directory: session?.directory, updated: session?.updated };
    },
    [sessionsByInstanceRef]
  );

  const transcriptReads = React.useRef(new ReadCoordinator());
  const loadAndCommitMessages = useStableCallback((ref: SessionRef, mode: 'tail' | 'full', directory?: string, afterCurrent: boolean = false) => {
    const key = sessionKey(ref);
    return transcriptReads.current.run(key, mode, async () => {
      const meta = sessionMetaFor(ref);
      if (mode === 'tail') {
        // Try the incremental read first. On a big session the tail costs 40 whole entry records
        // (measured 21.3MB for one with screenshots) on every poll, nearly all of it unchanged;
        // `since` costs only what actually changed, and nothing at all when nothing did. A gap (a
        // `next` cursor) or a host that cannot answer one falls through to the tail below, which
        // repairs by overlap.
        const held = messageCacheRef.current.get(key) ?? transcriptsRef.current[key]?.messages ?? [];
        const since = newestEntryId(held);
        if (since !== undefined) {
          const appended = await loadMessageAppend(ref.instanceId, ref.sessionId, since).catch((err: unknown) => {
            console.error('Failed to load message delta', err);
            return null;
          });
          if (appended?.supported && appended.complete) {
            commitFetchedTranscript(
              key,
              appended.messages,
              'append',
              meta.updated,
              true,
              appended.settlements,
              appended.liveOutputs
            );
            observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, appended.messages));
            return;
          }
        }
        const tailLimit = held.length === 0 ? OPEN_MESSAGE_TAIL_LIMIT : MESSAGE_TAIL_LIMIT;
        const tail = await loadMessageTailPage(ref.instanceId, ref.sessionId, directory ?? meta.directory, tailLimit);
        commitFetchedTranscript(key, tail.messages, 'tail', meta.updated);
        observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, tail.messages));
        setTranscripts((prev) => {
          const current = prev[key];
          if (!current) return prev;
          const historyComplete = current.historyComplete === true || tail.complete;
          if (current.historyComplete === historyComplete) return prev;
          return { ...prev, [key]: { ...current, historyComplete } };
        });
        return;
      }
      // A full read is a *paged* walk of the entries route, not the snapshot: the snapshot serves
      // the active window, so after a compaction it is a fraction of the history (measured live:
      // 39 of 872 entries on one conversation). `complete` says whether the walk reached the
      // start; a cap or a short answer leaves it false and the transcript says so.
      const history = await loadMessageHistory(ref.instanceId, ref.sessionId);
      // The walk landed, so the session is not one the breaker has to hold back. A success here is
      // the only evidence that counts: a transient timeout clears on the next attempt anyway.
      if (repairBudget.current.halt(ref)) {
        repairBudget.current.succeeded(ref);
        setRepairHalts((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      const messages = history.supported
        ? history.messages
        : await loadMessages(ref.instanceId, ref.sessionId, directory ?? meta.directory);
      commitFetchedTranscript(key, messages, 'full', meta.updated);
      observeModels(observationsFor(ref.instanceId, ref.sessionId, directory ?? meta.directory, messages));
      // Legacy instances have no cursor: their own paged read is complete by construction (or by
      // their documented ceiling, which this client cannot see). Do not claim either way for a
      // read that did not come from the Hearth walk.
      const historyComplete = history.supported ? history.complete : true;
      setTranscripts((prev) => {
        const current = prev[key];
        if (!current) return prev;
        if (current.historyComplete === historyComplete) return prev;
        return { ...prev, [key]: { ...current, historyComplete } };
      });
    }, afterCurrent);
  });

  /**
   * One failed full read, recorded for the breaker, and the halt it may have caused published so the
   * column can say why it is no longer repairing itself.
   */
  const recordFullReadFailure = React.useCallback((ref: SessionRef, reason: FullReadFailure) => {
    repairBudget.current.failed(ref, reason);
    const halt = repairBudget.current.halt(ref);
    setRepairHalts((prev) => {
      const key = sessionKey(ref);
      if (!halt || (prev[key] && prev[key].failures >= halt.failures)) return prev;
      return { ...prev, [key]: halt };
    });
  }, [setRepairHalts]);

  /** Refetch one transcript in full; authoritative for removals, compaction and terminal events. */
  const refreshMessages = useStableCallback(async (ref: SessionRef, afterCurrent: boolean = false) => {
    const key = sessionKey(ref);
    try {
      await loadAndCommitMessages(ref, 'full', undefined, afterCurrent);
    } catch (err) {
      console.error('Failed to load messages', err);
      // Count the failure for the breaker (`lib/repairBudget`). A full read that a session's size
      // makes impossible used to be asked for again on every trigger — open, reconnect, poll, an
      // event that wants a full read — so one oversized conversation kept a futile read alive for as
      // long as it was open. After a few consecutive failures the automatic repairs stop; the
      // reader's own Refresh still goes through, because asking again is asking again.
      recordFullReadFailure(ref, classifyFullReadFailure(err));
      setTranscripts((prev) => {
        const current = prev[key];
        // A transcript that already rendered is never demoted to an error: the poll retries and the
        // messages on screen are still the truth.
        if (current?.status === 'ready') return prev;
        // Keep a settled reload failure settled (it was the user's own action); otherwise this is
        // the transient shape, which reads as "waiting", not as a failure.
        const failure = current?.failure === 'reload' ? 'reload' : 'poll';
        const messages = current?.messages ?? messageCacheRef.current.get(key) ?? [];
        if (current && current.messages === messages && current.status === 'error' && current.failure === failure) {
          return prev;
        }
        return { ...prev, [key]: { messages, status: 'error', failure } };
      });
    } finally {
      fullRepairInFlight.current.delete(key);
      // A repair requested while this read was running was deferred rather than dropped — unless the
      // breaker has stopped repairs for this session, in which case replaying it would be the very
      // loop the breaker exists to end.
      const replay = pendingRepair.current.delete(key);
      if (replay && repairBudget.current.allows(ref)) requestFullRepair(key);
    }
  });

  /** Bounded tail refresh for a visible column on open and while a turn streams. */
  const refreshMessageTail = useStableCallback(async (ref: SessionRef) => {
    const key = sessionKey(ref);
    try {
      await loadAndCommitMessages(ref, 'tail');
    } catch (err) {
      console.error('Failed to load message tail', err);
      setTranscripts((prev) => {
        const current = prev[key];
        if (current?.status === 'ready') return prev;
        const failure = current?.failure === 'reload' ? 'reload' : 'tail';
        const messages = current?.messages ?? messageCacheRef.current.get(key) ?? [];
        if (current && current.messages === messages && current.status === 'error' && current.failure === failure) {
          return prev;
        }
        return { ...prev, [key]: { messages, status: 'error', failure } };
      });
    }
  });

  /**
   * Background sessions refresh their summary, and their cached transcript if they have one.
   *
   * A session that is streaming but not on screen is invalidated once per second, and each of those
   * refreshes used to be a whole bounded tail (20 entries, so megabytes on a session with images)
   * for a column nobody is looking at. With a cached transcript there is an anchor id to read from,
   * so it asks for the delta instead; without one it keeps the tail, because the summary is derived
   * from whatever messages it is handed.
   */
  const refreshMessageSummary = useStableCallback(async (ref: SessionRef) => {
    const key = sessionKey(ref);
    const { directory, updated } = sessionMetaFor(ref);
    try {
      const held = messageCacheRef.current.get(key);
      const since = held === undefined ? undefined : newestEntryId(held);
      if (since !== undefined) {
        const appended = await loadMessageAppend(ref.instanceId, ref.sessionId, since).catch(() => null);
        if (appended?.supported && appended.complete) {
          mergeBackgroundTail(key, appended.messages, updated, 'append', appended.settlements);
          return;
        }
      }
      const tail = await loadMessageTail(ref.instanceId, ref.sessionId, directory);
      mergeBackgroundTail(key, tail, updated);
    } catch (err) {
      console.warn('Failed to load message summary', err);
    }
  });

  // A tail with no safe overlap asks for one full repair; route it through the normal loader.
  // The breaker is checked here rather than at each of the four call sites: a session whose full read
  // cannot succeed (larger than the response cap) would otherwise be repaired again on every trigger,
  // for as long as it is open. The missing-history line says so and offers compaction.
  fullRepairRef.current = (key: string) => {
    const ref = parseSessionKey(key);
    if (!ref) {
      fullRepairInFlight.current.delete(key);
      return;
    }
    if (!repairBudget.current.allows(ref)) {
      fullRepairInFlight.current.delete(key);
      setRepairHalts((prev) => {
        const halt = repairBudget.current.halt(ref);
        if (!halt || prev[key]?.failures === halt.failures) return prev;
        return { ...prev, [key]: halt };
      });
      return;
    }
    void refreshMessages(ref);
  };

  return {
    pendingOptimisticIds,
    pendingSentAt,
    unconfirmedSends,
    abortReceipts,
    sentLedgerRef,
    pendingInputs,
    heldFollowUpsByTriggerId,
    pendingFor,
    releaseOptimistic,
    forgetPendingSend,
    messageCacheRef,
    transcriptsRef,
    summariesRef,
    repairBudget,
    transcriptVersion,
    streamDeltaCoalescerRef,
    setTranscriptFor,
    commitFetchedTranscript,
    canBufferStreamDeltas,
    applyStreamDeltas,
    updateCachedMessages,
    markSessionStepsInterrupted,
    loadAndCommitMessages,
    recordFullReadFailure,
    refreshMessages,
    refreshMessageTail,
    refreshMessageSummary,
  };
}
