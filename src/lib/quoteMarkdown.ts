import type { Element, Root, RootContent } from 'hast';

/** Preserve parser provenance, including linkified leaves. No substring relocation. */
export const rehypeQuotePositions = () => (tree: Root, file: { value: unknown }) => {
  const source = String(file.value);
  const visit = (node: Root | Element) => {
    node.children = node.children.map((child): RootContent => {
      if (child.type === 'element') {
        if (child.tagName === 'code' && node.type === 'element' && node.tagName !== 'pre') {
          // Inline code's text child has no position. Its parent owns the parser range,
          // including the backtick delimiters. Map only byte-exact interiors; CommonMark
          // whitespace normalization must not be mistaken for source offsets.
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const raw = start === undefined || end === undefined ? '' : source.slice(start, end);
          const ticks = raw.match(/^`+/)?.[0];
          const value = child.children.length === 1 && child.children[0].type === 'text' ? child.children[0].value : null;
          if (ticks && start !== undefined && raw.endsWith(ticks) && raw.length >= ticks.length * 2 && raw.slice(ticks.length, -ticks.length) === value) {
            child.children = [{
              type: 'element', tagName: 'span',
              properties: { 'data-quote-start': start + ticks.length, 'data-quote-end': start + raw.length - ticks.length },
              children: child.children,
            }];
          } else child.properties['data-quote-unsupported'] = true;
        } else if (!['code', 'pre'].includes(child.tagName)) visit(child);
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
