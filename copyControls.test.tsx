/** Copy shortcuts preserve Markdown and disappear with metadata only at the footer. */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Element } from 'hast';
import Markdown, { codeSource } from './src/components/Markdown';
import { MessageFooter } from './src/components/Transcript';
import type { ChatMessage } from './src/types';

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: 'Here is the thing.',
  parts: [],
  completed: true,
  ...over,
});

/** `MessageFooter` returns null or a line; null is the state this file cares about most. */
const footerMarkup = (m: ChatMessage, showMetadata: boolean) =>
  renderToStaticMarkup(<MessageFooter message={m} showMetadata={showMetadata} />);

describe('the message footer', () => {
  test('a bare message draws no footer line, but the message still offers Copy', () => {
    // Details turned off and nothing pinned: there is no metadata to draw, so the line does not
    // exist. Copy is not in it — it lives in the hover gutter — so it survives the footer going.
    expect(footerMarkup(message(), false)).toBe('');
    expect(footerMarkup(message({ text: 'still copyable' }), false)).toBe('');
  });

  test('an assistant turn with no recorded model says so rather than drawing nothing', () => {
    // "Model unavailable" is information: a turn with no model on it is worth noticing, and the
    // footer is the only place that says it. Details *off* is what stills the line.
    expect(footerMarkup(message(), true)).toContain('Model unavailable');
  });

  test('a message with cost and timestamp draws one line carrying them', () => {
    const markup = footerMarkup(
      message({
        model: { providerID: 'hearth', modelID: 'big-window' },
        cost: 0.042,
        createdAt: 1_000,
        completedAt: 121_000,
      }),
      true
    );
    expect(markup).toContain('$0.04');
    expect(markup).toContain('2m');
    // A message without copyable parts offers no empty copy action.
    expect(markup).not.toContain('aria-label="Copy"');
  });

  test('a copyable reply offers footer shortcuts without restoring message pins', () => {
    const m = message({ parts: [{ type: 'text', text: 'Here is the thing.' }] });
    const markup = renderToStaticMarkup(<MessageFooter message={m} showMetadata onReply={() => {}} />);
    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain('aria-label="Reply to this message"');
    expect(markup).not.toContain('Pin this message');
    expect(footerMarkup(m, false)).toBe('');
  });
});

describe('a fenced code block', () => {
  const fence = (body: string, lang = 'bash') => `Before.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\nAfter.\n`;

  test('gets its own Copy button, labelled for a screen reader', () => {
    const markup = renderToStaticMarkup(<Markdown text={fence('ls -la')} />);
    expect(markup).toContain('aria-label="Copy code"');
    // The announcement is a live region, empty until something happens.
    expect(markup).toContain('role="status"');
  });

  test('one control per block', () => {
    const two = `${fence('one')}\n${fence('two')}`;
    const markup = renderToStaticMarkup(<Markdown text={two} />);
    expect(markup.match(/aria-label="Copy code"/g)?.length).toBe(2);
  });

  test('inline code does not get a button', () => {
    const markup = renderToStaticMarkup(<Markdown text="Just `npm run build` inline." />);
    expect(markup).not.toContain('Copy code');
    expect(markup).toContain('<code');
  });

  test('the button sits against the block, not the message', () => {
    // A wrapper that is `relative` and scrolls with nothing: the control is positioned inside the
    // block's own box, so a long line scrolling sideways cannot carry it off-screen.
    const markup = renderToStaticMarkup(<Markdown text={fence('a very long line')} />);
    expect(markup).toContain('group/code relative');
    expect(markup).toContain('absolute right-1.5 top-1.5');
  });
});

describe('what a code block copies', () => {
  /** The `code` element inside a `pre`, as rehype hands it to the component. */
  const codeIn = (children: Element['children']): Element => ({
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [{ type: 'element', tagName: 'code', properties: {}, children }],
  });

  test('the raw source, indentation and blank lines intact', () => {
    const source = 'def main():\n    if True:\n\n        print("hi")\n';
    expect(codeSource(codeIn([{ type: 'text', value: source }]))).toBe(source);
  });

  test('joins text around a highlighted element rather than reading the DOM', () => {
    // A syntax highlighter wraps tokens in spans; `textContent` would work here too, but the point
    // is that the renderer never has to be consulted for the source.
    const node = codeIn([
      { type: 'text', value: 'let ' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['hljs-keyword'] },
        children: [{ type: 'text', value: 'x' }],
      },
      { type: 'text', value: ' = 1;\n' },
    ]);
    expect(codeSource(node)).toBe('let x = 1;\n');
  });

  test('nothing to copy is an empty string, not a crash', () => {
    expect(codeSource(undefined)).toBe('');
    expect(codeSource({ type: 'element', tagName: 'pre', properties: {}, children: [] })).toBe('');
  });
});
