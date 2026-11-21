import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  hasActiveTextSelection,
  isExternalWebHref,
  parseDocCandidate,
  tokenizeProseDocCandidates,
  useDocumentExploration,
} from '../lib/documentExploration';

/**
 * URLs plus absolute POSIX paths under the roots agents usually mention. `localhost:3000`
 * and `www.example.com` count too — agents print them without a scheme all the time, and
 * `openExternal` prepends `http://`. Paths stop at whitespace and closing quotes/brackets;
 * the trailing-punctuation trim below handles sentences like "see /Users/me/file.ts."
 * Windows paths are skipped on purpose: they come from remote instances and can't be
 * revealed locally anyway.
 */
const LINK_PATTERN =
  /https?:\/\/[^\s<>"'`]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s<>"'`]*|www\.[\w-]+(?:\.[\w-]+)+[^\s<>"'`]*|(?:~|\/(?:Users|home|Volumes|tmp|var|opt|etc|Applications|private|workspace|root|srv|mnt))(?:\/[^\s<>"'`()[\]]+)+/g;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;

export type LinkToken = { type: 'text'; value: string } | { type: 'link'; value: string };

export const tokenizeLinks = (text: string): LinkToken[] => {
  const tokens: LinkToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let value = match[0];
    // Keep balanced parentheses (Wikipedia-style URLs) but drop sentence punctuation.
    const trimmed = value.replace(TRAILING_PUNCTUATION, '');
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    value = opens > closes && value[trimmed.length] === ')' ? `${trimmed})` : trimmed;
    if (start > cursor) tokens.push({ type: 'text', value: text.slice(cursor, start) });
    tokens.push({ type: 'link', value });
    cursor = start + value.length;
  }
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
  return tokens;
};

type Props = {
  text: string;
  className?: string;
};

/** Renders text with URLs, local paths, and Kiln-verified document references as links. */
export default function Linkify({ text, className }: Props) {
  const docs = useDocumentExploration();
  const tokens = React.useMemo(() => tokenizeLinks(text), [text]);

  const docCandidates = React.useMemo(() => {
    if (!docs?.supported) return [];
    const found = new Set<string>();
    for (const token of tokens) {
      if (token.type === 'link') {
        if (!isExternalWebHref(token.value)) {
          const parsed = parseDocCandidate(token.value);
          if (parsed) found.add(parsed.requestPath);
        }
      } else {
        for (const sub of tokenizeProseDocCandidates(token.value)) {
          if (sub.type === 'doc') found.add(sub.candidate.requestPath);
        }
      }
    }
    return [...found];
  }, [tokens, docs?.supported]);

  React.useEffect(() => {
    if (docs?.supported && docCandidates.length > 0) {
      docs.requestResolve(docCandidates);
    }
  }, [docs, docCandidates]);

  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === 'link') {
          const docHit =
            docs?.supported && !isExternalWebHref(token.value) ? docs.lookup(token.value) : null;
          if (docHit) {
            return (
              <a
                key={index}
                href={docHit.resolved.resolvedPath}
                data-doc-link="true"
                title={`Preview ${docHit.resolved.resolvedPath}`}
                onClick={(event) => {
                  event.preventDefault();
                  if (hasActiveTextSelection()) return;
                  event.stopPropagation();
                  docs?.openResolved(docHit.resolved, docHit.fragment);
                }}
                className={cn(
                  'cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current',
                  className
                )}
              >
                {token.value}
              </a>
            );
          }
          return (
            <a
              key={index}
              href={token.value}
              title={isExternalWebHref(token.value) ? token.value : `Reveal in Finder: ${token.value}`}
              onClick={(event) => {
                if (hasActiveTextSelection()) {
                  event.preventDefault();
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                void window.ember.openExternal(token.value);
              }}
              className={cn(
                'cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current',
                className
              )}
            >
              {token.value}
            </a>
          );
        }

        const subTokens = docs?.supported ? tokenizeProseDocCandidates(token.value) : [{ type: 'text' as const, value: token.value }];
        return (
          <React.Fragment key={index}>
            {subTokens.map((sub, subIndex) => {
              if (sub.type === 'doc') {
                const hit = docs?.lookup(sub.value);
                if (hit) {
                  return (
                    <a
                      key={subIndex}
                      href={hit.resolved.resolvedPath}
                      data-doc-link="true"
                      title={`Preview ${hit.resolved.resolvedPath}`}
                      onClick={(event) => {
                        event.preventDefault();
                        if (hasActiveTextSelection()) return;
                        event.stopPropagation();
                        docs?.openResolved(hit.resolved, hit.fragment);
                      }}
                      className={cn(
                        'cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current',
                        className
                      )}
                    >
                      {sub.value}
                    </a>
                  );
                }
              }
              return <React.Fragment key={subIndex}>{sub.value}</React.Fragment>;
            })}
          </React.Fragment>
        );
      })}
    </>
  );
}
