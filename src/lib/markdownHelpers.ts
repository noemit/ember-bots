import { defaultUrlTransform } from 'react-markdown';
import type { Element } from 'hast';
import { isSafeRasterDataImageUrl } from './staticHtmlPreview';
import { isExternalWebHref, parseDocCandidate } from './documentExploration';

export const safeMarkdownUrlTransform = (url: string, key: string): string => {
  const trimmed = url.trim();
  if (key === 'src') {
    return isSafeRasterDataImageUrl(trimmed) ? trimmed.replace(/\s+/g, '') : defaultUrlTransform(url);
  }
  if (key === 'href') {
    const allowed = defaultUrlTransform(url);
    if (allowed) return allowed;
    if (isExternalWebHref(trimmed)) return trimmed;
    if (/^file:\/\//i.test(trimmed) && parseDocCandidate(trimmed, { allowSpaces: true })) {
      return trimmed;
    }
    return '';
  }
  return defaultUrlTransform(url);
};

/**
 * The raw source of a code block: the string child of its `code` element, never the rendered text.
 *
 * `textContent` would do for a block with no inline markup — which is the common case — but a syntax
 * highlight or a linkified token would then paste its own annotations, and the whole point of a copy
 * button here is that the fence's contents survive a paste byte for byte.
 */
export const codeSource = (node: Element | undefined): string => {
  const collect = (element: Element): string =>
    element.children
      .map((child) => (child.type === 'text' ? child.value : child.type === 'element' ? collect(child) : ''))
      .join('');
  const code = node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code'
  );
  return code ? collect(code) : '';
};
