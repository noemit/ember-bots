import type {
  ChatMessage,
  FileAttachment,
  MessagePart,
  NestedToolCall,
  ReasoningDisplay,
  ToolCall,
} from '../../types';

export const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
};

export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
};

export const formatTokens = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : String(count);

export type ToolBlock = { type: 'tools'; id: string; tool: string; calls: ToolCall[] };

/** Consecutive text (or reasoning) parts collapse into one block; files and tools stay separate. */
export type Block =
  | { type: 'text'; id: string; text: string }
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'file'; id: string; file: FileAttachment }
  | { type: 'ask'; id: string; call: ToolCall }
  | ToolBlock;

export const toBlocks = (parts: MessagePart[]): Block[] => {
  const blocks: Block[] = [];
  parts.forEach((part) => {
    const last = blocks[blocks.length - 1];
    if ((part.type === 'text' || part.type === 'reasoning') && last?.type === part.type) {
      last.text += part.type === 'reasoning' ? `\n\n${part.text}` : part.text;
    } else if (part.type === 'text' || part.type === 'reasoning') {
      blocks.push({ type: part.type, id: part.id, text: part.text });
    } else if (part.type === 'file') {
      blocks.push({ type: 'file', id: part.id, file: part.file });
    } else if (part.call.tool === 'ask') {
      blocks.push({ type: 'ask', id: part.id, call: part.call });
    } else if (last?.type === 'tools' && last.tool === part.call.tool) {
      last.calls.push(part.call);
    } else {
      blocks.push({ type: 'tools', id: part.id, tool: part.call.tool, calls: [part.call] });
    }
  });
  return blocks;
};

/** The blocks that survive the current display prefs (hidden thinking/tools drop out). */
export const visibleBlocks = (
  message: ChatMessage,
  hideToolCalls: boolean,
  reasoningDisplay: ReasoningDisplay,
  showQuestions: boolean
): Block[] =>
  toBlocks(message.parts).filter(
    (block) =>
      (block.type !== 'tools' || !hideToolCalls || block.calls.some((call) => Boolean(call.images?.length))) &&
      (block.type !== 'reasoning' || reasoningDisplay !== 'hidden') &&
      (block.type !== 'ask' || showQuestions)
  );

/** A tool's input as a one-liner when it's a command, otherwise compact JSON. */
export const describeInput = (input: Record<string, unknown>): string => {
  const command = input.command;
  if (typeof command === 'string') return command;
  return JSON.stringify(input, null, 2);
};

export type NestedCall = NestedToolCall;

export const firstScriptLine = (code: string, limit = 80): string => {
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) continue;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return '';
};

export const nestedArgsPreview = (args: string, limit = 110): string => {
  const flat = args.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1)}…`;
};

export const nestedCalls = (call: ToolCall): NestedCall[] => call.nestedCalls ?? [];

const countLabel = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export const toolSummary = (call: ToolCall): string | null => {
  const nested = nestedCalls(call);
  const code = typeof call.input?.code === 'string' ? firstScriptLine(call.input.code) : '';

  if (call.tool === 'codemode') {
    if (nested.length > 0) {
      const running = nested.find((entry) => entry.status === 'running');
      if (running) return `running ${running.name} (${countLabel(nested.length, 'call')})`;
      const settled = `${nested.length} tool ${nested.length === 1 ? 'call' : 'calls'}`;
      return code ? `${settled} · ${code}` : settled;
    }
    return code || null;
  }

  if (call.tool === 'scratchpad') {
    const action = typeof call.input?.action === 'string' ? call.input.action.trim() : '';
    const key = typeof call.input?.key === 'string' ? call.input.key.trim() : '';
    if (action && key) return `${action} "${key}"`;
    if (action) return action;
    return key ? `"${key}"` : null;
  }

  return null;
};

export const groupedToolTitle = (tool: string, count: number): string => {
  const normalized = tool.toLowerCase();
  if (normalized === 'read') return `Read ${count} files`;
  if (normalized === 'edit' || normalized === 'write') return `Edited ${count} files`;
  if (normalized === 'grep' || normalized === 'glob') return `Ran ${count} searches`;
  if (normalized === 'webfetch') return `Fetched ${count} pages`;
  return `${tool} × ${count}`;
};

export const reasoningTail = (text: string, limit = 90): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(-limit);
  const space = cut.indexOf(' ');
  return `…${space >= 0 ? cut.slice(space + 1) : cut}`;
};
