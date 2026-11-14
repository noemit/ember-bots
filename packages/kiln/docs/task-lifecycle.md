# Explicit worker tasks

The coordinator defines an outcome, the worker records its completion claim, and the human or coordinator reviews the evidence. These are separate actions. Retrieving an outcome, acknowledging a notice, marking a message read, ending an assistant reply, or idling does not verify or complete an explicit task.

## Tool contract

New `session spawn` workers using the default `report: "thread"` carry `taskLifecycle: "explicit"`. Workers created before this protocol, delivery-less workers, explicit legacy `report: "always"` / `"on-failure"` workers, and side-question workers retain final-reply settlement. Do not migrate existing idle workers into Done.

The worker checks its own assignment without a crew member name:

```json
{"action":"status"}
```

The response includes `task`, `title`, `state`, `done`, and `completion`. A worker completes only itself:

```json
{"action":"complete","task":"42:1730000000000","summary":"Fixed login retry handling","evidence":"auth.ts; bun test test/auth.test.ts passed","remaining":"No live-provider check"}
```

`task` is required for complete. `summary`, `evidence`, and `remaining` are required nonblank text, capped at 4,000 / 3,000 / 1,000 characters respectively. Say `none` when there are no remaining limitations. `name` is forbidden for complete. The tool schema exposes these fields directly; no codemode is needed. Missing or stale assignment versions, stopped/failed tasks, and a pending corrections/commands inbox are refused with a recovery step. Nonblocking Questions are not a completion blocker.

Complete commits the structured outcome, the existing bounded result report, an immutable worker `hearth.task-completion` history entry and the coordinator's metadata-only `hearth.thread-result` together. Only after that commit succeeds does the tool return `control.terminate`. It never invokes abort, clears the inbox, cancels a command, or kills a process. The SDK final boundary retains queued inputs and starts their next run; concurrent tool calls finish normally and the round terminates only if every call requests termination. A completion claim can therefore precede a concurrent command finishing: record that limitation honestly. Programs deliberately left running remain attributable to their conversation.

A coordinator with existing requester/supervisor access can explicitly reopen with a correction:

```json
{"action":"reopen","name":"login","task":"42:1730000000000","message":"Also cover an expired token"}
```

`message` is required for reopen and capped at 16,000 characters. Its optional `task` is a compare-and-set guard. Existing authorized `message` / `agents send` corrections also rearm the task. An authenticated human's ordinary input submission to a Done, failed or stopped explicit worker reopens it in the same transaction as admission. Exact submission retries do not reassign again. Unrelated siblings cannot reopen another requester's task. A worker cannot reopen itself with this action.

The stable task identity is its worker conversation and owning crew key. `task` and the conversation summary's `task.id` are **assignment-version tokens**, not stable cross-reopen IDs: they use `conversationId:(taskAt ?? spawnedAt)`. A correction preserves the conversation/key/title, clears the current completion, advances that token, and retains prior outcomes in worker history. A genuinely different purpose belongs in a new spawn. Initial and coordinator direction prompts carry the current version; workers can always inspect their own status.

## Persistence and admission

`CrewEntry.completion` contains `{summary,evidence,remaining,task,requestId,at}`. Done requires an explicit lifecycle, `state: "reported"`, and a completion matching the current assignment. Existing state values and report/wait/results receipts remain compatible. Result retrieval is independent of Done, verification and human reading; notices remain versioned and metadata-only.

`hearth.task-calls` retains at most 64 successful tool-call-ID to assignment-token receipts, without duplicate outcome payloads or denied-call receipts. Eviction cannot admit a stale assignment because complete requires its token. Same-assignment repeats do not append another result. A reassignment watermark also refuses tool calls originating at or before the correction's assistant entry, including a delayed first invocation. Full outcomes live in the worker's immutable history, not an unbounded latest-only receipt map.

Questions retain their actual `taskOwnerId`, `taskKey` and assignment token derived from `taskAt ?? spawnedAt`. Their answer admission transaction holds explicit Done even if someone resumes the Question. A Question is a correlated continuation, not authorization to reopen a task. After an explicit reassignment, an old assignment's answer stays held for review rather than being silently rebound to new work.

## Conversation summary wire

Explicit workers expose an optional summary field:

```ts
task?: {
  id: string; // assignment version
  title: string; // stable outcome title, independent of conversation rename
  status: 'working' | 'waiting' | 'blocked' | 'done' | 'stopped' | 'failed';
  completion?: { summary: string; evidence: string; remaining: string; task: string; requestId: string; at: number };
}
```

Only pending blocking questions/approvals produce `blocked`; nonblocking Questions do not. An idle, unfinished explicit task is `waiting`, not automatically waiting for a human. Failed and stopped stay distinct, neither is Done. Older workers omit this field.

## Spawn policy

This implementation does not change the ten-minute post-wake cooldown, the burst cap or hourly spawn budget. The cooldown can block distinct new tasks. A future task-aware exception could admit a reviewed distinct outcome from an explicit human/coordinator direction while retaining the burst/hourly safeguards; task completion itself must not authorize unlimited spawning.

## Checks

`bun run check` in `packages/kiln` includes `test/taskLifecycle.test.ts`, legacy `test/threadCoordination.test.ts`, flat ownership `test/flatWorkers.test.ts`, Questions admission tests, and authenticated HTTP `test/wireActions.test.ts`. Fixtures use in-memory or temporary SQLite stores and faux providers, never live host state.
