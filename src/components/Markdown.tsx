import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, Root, RootContent } from 'hast';
import { cn } from '@/lib/utils';
import { tokenizeLinks } from './Linkify';
import { useImageViewer, type ImageViewerApi } from './imageViewerContext';
import CopyButton from './CopyButton';

const SKIP_TAGS = new Set(['a', 'code', 'pre']);

/**
 * rehype plugin: turn bare local paths inside prose into links. remark-gfm already
 * autolinks URLs, so this only needs to catch what Linkify would — paths — and leave
 * code and existing anchors alone.
 */
const rehypeLinkPaths = () => (tree: Root) => {
  const visit = (node: Root | Element) => {
    node.children = node.children.flatMap((child): RootContent[] => {
      if (child.type === 'element') {
        if (!SKIP_TAGS.has(child.tagName)) visit(child);
        return [child];
      }
      if (child.type !== 'text') return [child];
      const tokens = tokenizeLinks(child.value);
      if (tokens.every((token) => token.type === 'text')) return [child];
      return tokens.map((token) =>
        token.type === 'text'
          ? { type: 'text', value: token.value }
          : {
              type: 'element',
              tagName: 'a',
              properties: { href: token.value },
              children: [{ type: 'text', value: token.value }],
            }
      );
    });
  };
  visit(tree);
};

const openLink = (event: React.MouseEvent<HTMLAnchorElement>) => {
  const href = event.currentTarget.getAttribute('href');
  event.preventDefault();
  event.stopPropagation();
  if (href) void window.ember.openExternal(href);
};

/** A `src` an `<img>` can show and the viewer can open (data URL or http(s)). */
const renderableSrc = (value: unknown): value is string =>
  typeof value === 'string' && /^(data:|https?:\/\/)/.test(value);

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

const buildComponents = (viewer: ImageViewerApi | null): Components => ({
  // A fenced block gets its own Copy, positioned against the block rather than the message, so a
  // block scrolled sideways does not carry its button off-screen. The control is always visible:
  // unlike a message's footer there is nothing else on a code block to press, and hiding the only
  // affordance behind a hover is a thing people fail to find.
  pre: ({ node, children }) => (
    <div className="group/code relative my-2">
      <pre className="overflow-x-auto rounded-md bg-background/70 px-3 py-2 leading-relaxed">{children}</pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton text={() => codeSource(node)} label="Copy code" done="Copied code" alwaysVisible />
      </div>
    </div>
  ),
  a: ({ node: _node, children, ...props }) => (
    <a
      {...props}
      onClick={openLink}
      title={props.href}
      className="cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current"
    >
      {children}
    </a>
  ),
  // Images from the model are untrusted; no width/height hints, just bounded. A renderable image
  // opens in the lightbox (there is no message gallery for prose, so it opens on its own).
  img: ({ node: _node, alt, src, ...props }) => {
    const openable = Boolean(viewer) && renderableSrc(src);
    return (
      <img
        {...props}
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        className={cn('my-1.5 max-h-72 max-w-full rounded-md', openable && 'cursor-zoom-in')}
        onClick={
          openable
            ? () =>
                viewer?.openOne({
                  id: src as string,
                  url: src as string,
                  filename: alt || 'image',
                  mime: 'image/*',
                })
            : undefined
        }
      />
    );
  },
});

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeLinkPaths];

type Props = {
  text: string;
  className?: string;
};

/** Assistant prose. GitHub-flavoured markdown, raw HTML is never rendered. */
function Markdown({ text, className }: Props) {
  const viewer = useImageViewer();
  const components = React.useMemo(() => buildComponents(viewer), [viewer]);
  return (
    <div
      className={cn(
        'break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
        '[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold',
        '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_hr]:my-3 [&_hr]:border-border',
        '[&_code]:font-mono [&_code]:text-[12px] [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-background/70 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5',
        '[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-background/70 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:leading-relaxed',
        '[&_table]:my-2 [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-[12px] [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default React.memo(Markdown);
