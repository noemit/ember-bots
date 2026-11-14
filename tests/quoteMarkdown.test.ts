import { expect, test } from 'bun:test';
import { rehypeQuotePositions } from '../src/lib/quoteMarkdown';
import type { Root, Element } from 'hast';

const text = (value: string, start: number, end: number) => ({ type: 'text' as const, value, position: { start: { line: 1, column: 1, offset: start }, end: { line: 1, column: 1, offset: end } } });
test('parser offsets distinguish repeated words and reject transformed leaves rather than guessing', () => {
  const source = 'same **same** &amp;';
  const tree: Root = { type: 'root', children: [text('same ', 0, 5), { type: 'element', tagName: 'strong', properties: {}, children: [text('same', 7, 11)] }, text(' &', 13, 19)] };
  rehypeQuotePositions()(tree, { value: source });
  expect((tree.children[0] as Element).properties).toEqual({ 'data-quote-start': 0, 'data-quote-end': 5 });
  expect(((tree.children[1] as Element).children[0] as Element).properties).toEqual({ 'data-quote-start': 7, 'data-quote-end': 11 });
  expect((tree.children[2] as Element).properties).toEqual({ 'data-quote-unsupported': true });
});
test('code is not mapped and generated paragraph whitespace is not given false provenance', () => {
  const code: Element = { type: 'element', tagName: 'code', properties: {}, children: [text('same', 1, 5)] };
  const whitespace = { type: 'text' as const, value: '\n' };
  const tree: Root = { type: 'root', children: [code, whitespace] };
  rehypeQuotePositions()(tree, { value: '`same`' });
  expect(code.children[0].type).toBe('text');
  expect(tree.children[1]).toBe(whitespace);
});
