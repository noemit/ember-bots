import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Ember-owned conversation metadata that pi does not model: the display title (rename
 * actions), the archive mark (archive/restore actions) and its cascade batch, and the
 * coagent crew fields. Conversation-scoped, latest history, fresh on forks. Every field is
 * optional and absent means the plain default (untitled, active, an ordinary leader session
 * that may delegate).
 *
 * Crew membership is a first-class field, never overloaded onto pi's `owner` (task ownership)
 * or `parent` (fork lineage):
 * - `kind: "worker"` is a hidden crew member; `kind: "peer"` is an ownerless, addressable one.
 * - `lead` is the immediate leader, retained as history on a promoted peer.
 * - `delegates` is stored (not derived) so the summary is cheap and the choice survives restarts;
 *   workers may request siblings directly under their root supervisor.
 * - `archiveBatch` ties a cascade archive (leader + workers + grandchildren) together so undo
 *   restores exactly that batch.
 * - `promotedTo` is set on a worker after a human promotes it; the fork is the peer that now
 *   carries the name, while the worker stays as hidden history.
 */
export type HearthMeta = {
  /** Actual spawn requester; does not grant rights to arbitrary siblings. */
  creatorId?: number;
  /** Explicit human stop, unlike ordinary idleness. Async answers never restart it. */
  stoppedAt?: number;
  title?: string;
  /** Epoch ms when the conversation was archived; absent means active. */
  archived?: number;
  /** The archive operation that cascaded this row; absent when archived directly. */
  archiveBatch?: string;
  /** Absent on ordinary sessions. Workers are hidden; peers are addressable. */
  kind?: "worker" | "peer";
  /** Immediate leader. Retained on a promoted peer as history. */
  lead?: { conversationId: number; host: string };
  /** Whether this conversation offers the `session` tool + crew section. */
  delegates?: boolean;
  /** Set on a worker when a human promoted it; the ownerless peer fork that now carries its name. */
  promotedTo?: number;
  /** Epoch ms timestamps of recent `agents send` messages, backing the 60/hour loop budget. */
  agentMessagesSentAt?: number[];
};

export const MetaDoc = defineDoc<HearthMeta>({
  kind: "hearth.meta",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** True when the conversation is archived (Ember keeps it out of the rail). */
export const isArchived = (meta: HearthMeta | undefined): boolean => Boolean(meta?.archived);
