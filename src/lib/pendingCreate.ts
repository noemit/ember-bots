/**
 * A new agent's first message, held while the session it belongs to does not exist yet.
 *
 * A draft is not a session: `POST /conversations` has not answered with an id, so the message the
 * person already sent has nowhere to live. There were three ways to keep it, and two of them are
 * the reason this module exists:
 *
 * - A placeholder key in `transcripts` was rejected. A key that is not a session has to be taught to
 *   `openSessions`, `activeSession`, the message cache, the optimistic-id and sent-ledger registries,
 *   composer drafts, read marks, the colour queue and the saved workspace — and a placeholder that
 *   leaked into settings would come back after a restart as a session that never existed.
 * - Withholding the bubble until the host answered was rejected because the composer clears on
 *   Enter: between the keystroke and a slow-create's answer there was nothing on screen at all, which
 *   reads as "this session never started".
 * - So the state is plain data here, and the handover is a swap inside one commit: `sendTo` inserts
 *   the real optimistic bubble synchronously, then the pending entry is dropped. Nothing blinks, and
 *   nothing invented is ever persisted.
 *
 * Pure on purpose — no React, no clock but the caller's, no I/O — so the transitions can be tested
 * without a bridge. The bubble's delivery states are the ones `lib/sendDelivery.ts` defines:
 * `sending` while the create is in flight, `failed` once it is refused.
 */
import type { PromptInput } from '../api';
import type { ChatMessage, FileAttachment, NewSessionOptions } from '../types';

/**
 * The note on a message typed after the first Enter, once the session exists.
 *
 * It says "once this session has started" because that is the promise: a held message is not parked
 * in the host's inbox (there is no host conversation to park it in), so nothing but this pane is
 * holding it.
 */
export const HELD_MESSAGE_NOTE = 'Sends once this session has started.';

export type PendingCreateMessage = {
  /** The client message id, which is also the optimistic bubble's id. */
  id: string;
  input: PromptInput;
  /** `input.text.trim()`, kept so the bubble never renders the composer's stray whitespace. */
  text: string;
  attachments: FileAttachment[];
  createdAt: number;
  /** Held: typed after Enter, sent in order once the session has started. */
  held: boolean;
};

export type PendingCreate = {
  /** Client id for the attempt itself, so a retry is a new attempt over the same messages. */
  id: string;
  /** Destination: instance, folder, model, variant, instructions, bypass. Replaced by a retry. */
  options: NewSessionOptions;
  /** Derived before the request, so the pane can name what is starting. */
  title: string;
  createdAt: number;
  /** `creating` until the host answers or refuses; `failed` once it refused. Nothing else. */
  phase: 'creating' | 'failed';
  /** Why it failed, phrased for the reader (see `newSessionFailure.ts`). Only on `failed`. */
  failure?: string;
  /** Never empty; `messages[0]` is the one that triggered the create. */
  messages: PendingCreateMessage[];
  /**
   * Notes parked from the draft's composer. There is no session yet, so the usual per-session notes
   * key has nothing to hang them on; App moves them under the session's own key the moment it exists,
   * where they appear in the same For later tray as any other note.
   */
  notes?: Array<{ id: string; text: string }>;
};

/**
 * One bubble for the draft pane: an ordinary user message, plus the note only this pane sets.
 *
 * `deliveryNote` is client-only and produced here and nowhere else, so the shape is declared locally
 * rather than assumed on `ChatMessage`: the list still satisfies `ChatMessage[]` wherever the
 * transcript renderer takes one, and this module compiles whether or not `ChatMessage` has grown the
 * field. It is needed because a held message is in no queue and no transcript — nothing else on
 * screen would say it is waiting.
 */
export type PendingCreateBubble = ChatMessage & {
  /**
   * Why this message is not in flight yet. Set only on a held message while the session is still
   * starting — the moment it fails, the bubble's `deliveryError` is the sentence worth reading, and
   * two notes on one bubble would compete.
   */
  deliveryNote?: string;
};

/**
 * The message shape both entry points agree on: text and attachments always come from the input, so
 * a bubble can never disagree with what a replay would send.
 */
const messageFrom = (
  message: { id: string; input: PromptInput; createdAt: number },
  held: boolean
): PendingCreateMessage => ({
  id: message.id,
  input: message.input,
  text: message.input.text.trim(),
  attachments: message.input.attachments ?? [],
  createdAt: message.createdAt,
  held,
});

/**
 * Begin an attempt. The first message is the trigger, so it is never held: it is what the create is
 * for. A caller cannot mark it otherwise — the pane would then show "sends once this session has
 * started" over the message that is starting it.
 */
export const createPendingCreate = (init: {
  id: string;
  options: NewSessionOptions;
  title: string;
  message: PendingCreateMessage;
  createdAt?: number;
}): PendingCreate => ({
  id: init.id,
  options: init.options,
  title: init.title,
  createdAt: init.createdAt ?? Date.now(),
  phase: 'creating',
  messages: [{ ...init.message, held: false }],
});

/**
 * Keep a message typed while the session is starting. Always a new value: the pending create is
 * state a caller replaces, never mutates, so a render can't see half an append.
 *
 * The argument may be a whole `PendingCreateMessage` a caller already built, or only the
 * `{ id, input, createdAt }` it has; either way the derived fields come from `input` and `held` is set
 * here — a message typed during a create is held by definition, and a caller that passed `held: false`
 * with the first message's shape must not be able to store it as sent.
 */
export const holdPendingMessage = (
  pending: PendingCreate,
  message: PendingCreateMessage | Pick<PendingCreateMessage, 'id' | 'input' | 'createdAt'>
): PendingCreate => ({
  ...pending,
  messages: [...pending.messages, messageFrom(message, true)],
});

/**
 * The host refused, or never answered. The messages stay where they are: they are the whole point of
 * the retry, and a failure that emptied the pane would throw away text the person cannot retype.
 */
export const failPendingCreate = (pending: PendingCreate, failure: string): PendingCreate => ({
  ...pending,
  phase: 'failed',
  failure,
});

/**
 * Try again. Only the destination changes — a retry is usually a fixed folder, and it may now point
 * at another instance or model — because the messages (and which of them were held) are the thing
 * being retried. Held flags survive so the replay keeps the order and the notes the person saw.
 */
export const restartPendingCreate = (
  pending: PendingCreate,
  options: NewSessionOptions
): PendingCreate => ({
  ...pending,
  options,
  phase: 'creating',
  failure: undefined,
  messages: pending.messages,
});

/**
 * The draft transcript: one user bubble per message, in the order they were typed.
 *
 * The parts mirror `sendTo`'s optimistic bubble exactly (`${id}-text`, `${id}-file-${index}`), so the
 * swap at the handover replaces one rendering of a message with the same rendering of the same
 * message. `delivery` is `failed` for every bubble once the create has failed — the retry replays
 * them together, so a per-message verdict would be a fiction — and `sending` otherwise: a held
 * message is not queued anywhere, it is waiting in this pane.
 */
export const pendingCreateMessages = (pending: PendingCreate): PendingCreateBubble[] => {
  const failed = pending.phase === 'failed';
  return pending.messages.map((message) => {
    const parts: ChatMessage['parts'] = [
      ...(message.text ? [{ type: 'text' as const, id: `${message.id}-text`, text: message.text }] : []),
      ...message.attachments.map((file, index) => ({
        type: 'file' as const,
        id: `${message.id}-file-${index}`,
        file,
      })),
    ];
    const model = message.input.model;
    return {
      id: message.id,
      role: 'user',
      text: message.text,
      parts,
      model: model
        ? { providerID: model.providerID, modelID: model.modelID, variant: message.input.variant }
        : undefined,
      createdAt: message.createdAt,
      completed: true,
      delivery: failed ? 'failed' : 'sending',
      deliveryError: failed ? pending.failure : undefined,
      deliveryNote: !failed && message.held ? HELD_MESSAGE_NOTE : undefined,
    };
  });
};

/**
 * Park a note on the attempt. The composer clears and the note waits with the messages: losing it
 * because the session does not exist yet would make "save for later" a lie at the worst moment.
 */
export const addPendingNote = (
  pending: PendingCreate,
  note: { id: string; text: string }
): PendingCreate => ({
  ...pending,
  notes: [...(pending.notes ?? []), note].slice(-100),
});

/**
 * What **Edit** puts back in the composer: the messages joined the way they were typed, and every
 * attachment in the order it was added.
 *
 * A message with no text still contributes its files — an image sent on its own is a message — but it
 * contributes no line, so joining can't leave the blank-line gaps an empty string would.
 */
export const pendingCreateComposerText = (
  pending: PendingCreate
): { text: string; attachments: FileAttachment[] } => ({
  text: pending.messages
    .map((message) => message.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim(),
  attachments: pending.messages.flatMap((message) => message.attachments),
});
