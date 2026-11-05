import type { ChatMessage, NestedToolCall, ToolCall } from '../types';

/**
 * The line the transcript shows under the latest message while a turn is in flight (or a prompt is
 * pending). Pure so the wording lives in one place and can be tested, and so the transcript stays
 * presentational.
 *
 * The thinking branch names the chat rather than the model: in a column the session title is what
 * identifies the conversation, while the model is only rarely what the reader is looking for. The
 * title is truncated by CSS, not here, so a screen reader still gets the whole name.
 */
export type ActivityLabelInput = {
  /** The turn is live (`isTurnLive`). */
  busy: boolean;
  sending: boolean;
  lastRole?: ChatMessage['role'];
  /**
   * The last message's delivery state, when it has one. `undefined` means an accepted message waiting
   * for its first reply; `'queued'` and `'failed'` have their own homes (the queue row, the failed
   * bubble) and must not borrow the line.
   */
  lastDelivery?: ChatMessage['delivery'];
  /** The name of a tool still running in the last assistant turn. */
  runningTool?: string | null;
  /**
   * The running tool's call, when the caller has it. A call can say more than its name: a
   * `codemode` script is running one of its nested calls, a `scratchpad` call is acting on a key.
   * Prefer this over `runningTool`; both are accepted so a caller with only a name still works.
   */
  runningCall?: ActivityToolCall | null;
  /** Pending prompt kind, if the session has one. */
  prompt?: 'permission' | 'question' | null;
  /** The session's title, as the column header shows it. */
  title?: string | null;
  /**
   * The host has not said whether this session is busy. The line must not fill that gap with
   * "Starting" or "Thinking": the status row says the status is unknown, and a second line guessing
   * at what is happening would contradict it.
   */
  statusUnknown?: boolean;
  /**
   * A new agent's session is still being created. There is no run to watch and no message in a
   * conversation yet, so the usual vocabulary ("Sending", "Starting") would describe the wrong
   * thing; this says what is actually happening and names the host that has not answered.
   */
  creating?: boolean;
  /** The instance label, so the creating line can name which host is starting the session. */
  instanceLabel?: string;
};

/** What the activity line needs from a running call: its name, its input, and its nested calls. */
export type ActivityToolCall = Pick<ToolCall, 'tool' | 'input' | 'nestedCalls'>;

/** The first non-empty string among `keys`, cut to something a status line can hold. */
const firstText = (input: Record<string, unknown> | undefined, keys: readonly string[]): string => {
  if (!input) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return '';
};

/** A `scratchpad` call's `action key`, as its tool arguments name them. */
const scratchpadDetail = (input: Record<string, unknown> | undefined): string =>
  [
    firstText(input, ['action', 'op', 'operation']),
    firstText(input, ['key', 'name', 'slot', 'id']),
  ]
    .filter(Boolean)
    .join(' ');

/** The nested call a script is waiting on, if one is still running. */
const runningNested = (calls: readonly NestedToolCall[] | undefined): NestedToolCall | undefined =>
  (calls ?? []).find((call) => call.status === 'running');

/**
 * What a running tool should say on the activity line.
 *
 * Most tools say their name (`Running bash`), which is what the host gave. `codemode` and
 * `scratchpad` carry their meaning elsewhere: a script is really doing one of the calls it made
 * (`Running script · read`), and a scratchpad call is really acting on a key (`Scratchpad · get
 * matched`). Both are read from the call itself rather than from a title, which the host supplies as
 * raw input JSON for these two.
 */
export const toolActivityText = (call: ActivityToolCall): string => {
  if (call.tool === 'codemode') {
    const nested = runningNested(call.nestedCalls);
    return nested ? `Running script · ${nested.name}` : 'Running script';
  }
  if (call.tool === 'scratchpad') {
    const detail = scratchpadDetail(call.input);
    return detail ? `Scratchpad · ${detail}` : 'Scratchpad';
  }
  return `Running ${call.tool}`;
};

/**
 * `text` is always rendered in full. When `title` is set it is rendered first, on its own,
 * ellipsized to whatever room the line has left, so a long chat name never pushes the elapsed time
 * or the suffix out of view.
 */
export type ActivityLabel = { text: string; title?: string };

export const deriveActivityLabel = ({
  busy,
  sending,
  lastRole,
  lastDelivery,
  runningTool,
  runningCall,
  prompt,
  title,
  statusUnknown = false,
  creating = false,
  instanceLabel,
}: ActivityLabelInput): ActivityLabel | null => {
  // The draft's message has no conversation behind it yet, so everything below would be about a
  // step that does not exist. This line is the whole answer to "did Enter do anything?".
  if (creating) {
    const host = instanceLabel?.trim();
    return {
      title: title?.trim() || undefined,
      text: host ? `Starting this session on ${host}` : 'Starting this session',
    };
  }
  if (prompt === 'permission') return { text: 'Waiting for approval' };
  if (prompt === 'question') return { text: 'Waiting for an answer' };
  // A send in flight is a state in its own right, and it predates `busy`: the request is out before
  // any run exists to watch. Checking it first is what keeps a brand-new session from looking
  // untouched while its message is on the way.
  if (sending && lastRole === 'user') return { text: 'Sending' };
  // Sent, accepted, and nothing running yet — the second or so a new session spends before its first
  // token. Without a line here the column holds a message and no sign of life, which reads as "this
  // never started". Not for a parked message (its queue row explains it) or a failed one (it has a
  // bubble with a reason), which is why this reads the message rather than a clock.
  if (!busy) {
    if (statusUnknown) return null;
    return lastRole === 'user' && lastDelivery === undefined ? { text: 'Starting' } : null;
  }
  if (runningCall) return { text: toolActivityText(runningCall) };
  if (runningTool) return { text: `Running ${runningTool}` };
  const named = title?.trim();
  return named ? { text: '· thinking', title: named } : { text: 'Thinking' };
};
