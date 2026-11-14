import type { Element, Root, RootContent } from 'hast';

/** Preserve parser provenance before linkification splits text. No substring relocation. */
export const rehypeQuotePositions = () => (tree: Root, file: { value: unknown }) => {
  const source = String(file.value);
  const visit = (node: Root | Element) => {
    node.children = node.children.map((child): RootContent => {
      if (child.type === 'element') {
        if (!['code', 'pre'].includes(child.tagName)) visit(child);
        return child;
      }
      if (child.type !== 'text') return child;
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) return child; // generated block separators
      const exact = source.slice(start, end) === child.value;
      return {
        type: 'element', tagName: 'span',
        properties: exact ? { 'data-quote-start': start, 'data-quote-end': end } : { 'data-quote-unsupported': true },
        children: [child],
      };
    });
  };
  visit(tree);
};
