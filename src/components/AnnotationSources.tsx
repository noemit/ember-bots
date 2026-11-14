import type { QuoteLink } from '../types';

export default function AnnotationSources({ links, onNavigate }: { links: QuoteLink[]; onNavigate?: (link: QuoteLink, direction: 'source' | 'destination') => void }) {
  if (!links.length) return null;
  const buttons = links.map((link, index) => <button key={link.id} type="button" data-quote-link="" className="rounded px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted" onClick={() => onNavigate?.(link, 'source')} aria-label={'Open quoted source: ' + link.source.quote}>{links.length > 1 ? String(index + 1) + '. ' : ''}Open quoted source: {link.source.quote.slice(0, 50)}</button>);
  return links.length > 1 ? <details data-quote-link=""><summary className="cursor-pointer text-xs text-muted-foreground">Choose a quoted source ({links.length})</summary>{buttons}</details> : <>{buttons}</>;
}
