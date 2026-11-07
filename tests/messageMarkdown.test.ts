import { describe, expect, test } from 'bun:test';
import { hasMarkdownToCopy, messageMarkdown } from '../src/lib/messageMarkdown';
import type { ChatMessage, MessagePart } from '../src/types';

/**
 * Copying a message has to give back the Markdown that was written, not the prose it rendered as: a
 * fence stays a fence, asterisks stay asterisks. And "fully" has a boundary — a tool's output can be
 * tens of thousands of characters, so it is opt-in.
 */
const message = (parts: MessagePart[]): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
  parts,
});

const text = (value: string, id = 'p'): MessagePart => ({ type: 'text', id, text: value });
const reasoning = (value: string): MessagePart => ({ type: 'reasoning', id: 'r', text: value });
const tool = (tool: string, input?: Record<string, unknown>, output?: string, error?: string): MessagePart => ({
  type: 'tool',
  id: 't',
  call: { id: 'c1', tool, status: 'completed', input, output, error },
});
const file = (filename: string, url: string, mime = 'image/png'): MessagePart => ({
  type: 'file',
  id: 'f',
  file: { filename, url, mime },
});

describe('a message as Markdown', () => {
  test('the prose comes back as source, fences and all', () => {
    const source = 'Fix the retry loop:\n\n```ts\nwhile (n < 3) n += 1;\n```\n\nThen **re-run** the tests.';
    expect(messageMarkdown(message([text(source)]))).toBe(source);
  });

  test('parts keep their order, with a blank line between blocks', () => {
    const markdown = messageMarkdown(
      message([text('First.'), tool('bash', { command: 'ls' }, 'a.ts'), text('Second.')])
    );
    expect(markdown).toBe('First.\n\nSecond.');
  });

  test('reasoning and tools are opt-in, and folded when asked for', () => {
    const parts = [reasoning('thinking hard'), tool('bash', { command: 'ls -la' }, 'total 0'), text('Done.')];
    expect(messageMarkdown(message(parts))).toBe('Done.');

    const withReasoning = messageMarkdown(message(parts), { includeReasoning: true });
    expect(withReasoning).toContain('<details><summary>Reasoning</summary>');
    expect(withReasoning).toContain('thinking hard');

    const withTools = messageMarkdown(message(parts), { includeTools: true });
    expect(withTools).toContain('<details><summary>bash</summary>');
    expect(withTools).toContain('```bash\nls -la\n```');
    expect(withTools).toContain('total 0');
    // Prose stays outside the fold, in order.
    expect(withTools.indexOf('Done.')).toBeGreaterThan(withTools.indexOf('</details>'));
  });

  test('a fence inside a tool output cannot end the block early', () => {
    const markdown = messageMarkdown(message([tool('bash', { command: 'cat x.md' }, '```\ninner\n```')]), {
      includeTools: true,
    });
    // The outer fence is longer than the inner one, so the body survives intact.
    expect(markdown).toContain('````\n```\ninner\n```\n````');
  });

  test('a failed tool keeps its error as a quote', () => {
    const markdown = messageMarkdown(message([tool('bash', { command: 'false' }, 'nope', 'exit 1')]), {
      includeTools: true,
    });
    expect(markdown).toContain('> exit 1');
  });

  test('a user message keeps its words and names its files, without inlining them', () => {
    const markdown = messageMarkdown(
      message([text('Look at this'), file('shot.png', 'data:image/png;base64,AAAA')])
    );
    expect(markdown).toBe('Look at this\n\n- shot.png');
    expect(markdown).not.toContain('base64');
    // A hosted file is a link (an image link when it is an image).
    expect(messageMarkdown(message([file('doc.pdf', 'https://example.com/doc.pdf', 'application/pdf')]))).toBe(
      '[doc.pdf](https://example.com/doc.pdf)'
    );
  });

  test('nothing to copy is empty, and says so to the caller', () => {
    const toolsOnly = message([tool('bash', { command: 'ls' }, 'out')]);
    expect(messageMarkdown(toolsOnly)).toBe('');
    expect(hasMarkdownToCopy(toolsOnly)).toBe(false);
    expect(hasMarkdownToCopy(message([text('   ')]))).toBe(false);
    expect(hasMarkdownToCopy(message([text('hello')]))).toBe(true);
  });
});
