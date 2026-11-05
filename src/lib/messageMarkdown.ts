/**
 * One message as Markdown, for the copy button in its footer.
 *
 * The wire text is already Markdown — `Markdown.tsx` renders it with `react-markdown` — so this is a
 * join over the message's parts, never a conversion. Copying the rendered prose through the DOM would
 * escape it and flatten code fences, which is exactly what makes a hand selection useless for pasting
 * into a note.
 *
 * "Fully" is the interesting word, and a message is more than its prose: `MessagePart` carries text,
 * reasoning, files and tool calls with their inputs and outputs. The defaults are deliberately narrow —
 * **prose only** — because a tool's output can be tens of thousands of characters, and pasting that
 * into a note by accident is worse than leaving it out. The rest is one option away, folded behind
 * `<details>` so the pasted text still reads as a message rather than as a transcript dump.
 */
import type { ChatMessage } from '../types';

export type MarkdownCopyOptions = {
  /** Include the agent's reasoning blocks, folded behind `<details>`. */
  includeReasoning?: boolean;
  /** Include tool calls, their input and their output, folded behind `<details>`. */
  includeTools?: boolean;
};

/** A URL worth putting in Markdown: a link, not a megabyte of inline base64. */
const isLinkable = (url: string | undefined): url is string =>
  typeof url === 'string' && /^(https?:|file:)/i.test(url);

const fence = (body: string, language?: string): string => {
  // A fence inside the body would end the block early: use one longer than the longest run.
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language ?? ''}\n${body.replace(/\n+$/, '')}\n${ticks}`;
};

const details = (summary: string, body: string): string =>
  `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;

/** The tool's input as the block a reader would want: a shell command, or its JSON. */
const toolBlocks = (call: { tool: string; input?: Record<string, unknown>; output?: string; error?: string }): string[] => {
  const blocks: string[] = [];
  const command = typeof call.input?.command === 'string' ? call.input.command : undefined;
  if (command) blocks.push(fence(command, 'bash'));
  else if (call.input && Object.keys(call.input).length > 0) {
    blocks.push(fence(JSON.stringify(call.input, null, 2), 'json'));
  }
  if (call.output) blocks.push(fence(call.output));
  if (call.error) blocks.push(`> ${call.error.replace(/\n/g, '\n> ')}`);
  return blocks;
};

/**
 * The message as Markdown. Empty when there is nothing to copy (an assistant turn whose only parts
 * are tools, with tools excluded) — the caller uses that to decide whether to offer the button.
 */
export const messageMarkdown = (message: ChatMessage, options: MarkdownCopyOptions = {}): string => {
  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      const text = part.text.trim();
      if (text) blocks.push(text);
      continue;
    }
    if (part.type === 'reasoning') {
      if (!options.includeReasoning) continue;
      const text = part.text.trim();
      if (text) blocks.push(details('Reasoning', text));
      continue;
    }
    if (part.type === 'file') {
      // A named file, or a link when the host gave it a URL worth following. Never a `data:` payload:
      // an inline base64 image is not something to paste into a document.
      const { file } = part;
      blocks.push(
        isLinkable(file.url)
          ? `${file.mime.startsWith('image/') ? '!' : ''}[${file.filename}](${file.url})`
          : `- ${file.filename}`
      );
      continue;
    }
    if (part.type === 'tool') {
      if (!options.includeTools) continue;
      const body = toolBlocks(part.call);
      if (body.length > 0) blocks.push(details(`${part.call.tool}`, body.join('\n\n')));
    }
  }
  return blocks.join('\n\n');
};

/** A cheap test for "is there prose to copy" — used to decide whether the button renders at all. */
export const hasMarkdownToCopy = (message: ChatMessage): boolean =>
  message.parts.some((part) => part.type === 'text' && part.text.trim().length > 0);
