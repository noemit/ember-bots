import { describe, expect, test } from 'bun:test';
import {
  contextAround,
  linkKindFor,
  linkTitle,
  linksFromDigests,
  linksFromItems,
  LINK_CONTEXT_LIMIT,
  SHARED_LINK_LIMIT,
} from './src/lib/sharedLinks';
import type { UnreadItem } from './src/lib/unreadDigest';

const item = (id: string, excerpt: string): Pick<UnreadItem, 'id' | 'excerpt'> => ({ id, excerpt });

describe('linkKindFor', () => {
  test('a loopback address is a running app, whatever its path', () => {
    expect(linkKindFor('localhost:5179')).toBe('app');
    expect(linkKindFor('http://127.0.0.1:3000/preview')).toBe('app');
    expect(linkKindFor('http://[::1]:8080/')).toBe('app');
  });

  test('a document extension is a report, before the generic page rule', () => {
    expect(linkKindFor('https://example.com/cron-spike-report.html')).toBe('report');
    expect(linkKindFor('https://example.com/flap-trace.jsonl')).toBe('report');
    expect(linkKindFor('https://example.com/brief.pdf')).toBe('report');
  });

  test('anything else on the web is a page, and a path is a file', () => {
    expect(linkKindFor('https://example.com/about')).toBe('page');
    expect(linkKindFor('www.example.com')).toBe('page');
    expect(linkKindFor('/workspace/ember/README.md')).toBe('file');
  });
});

describe('linkTitle', () => {
  test('prefers the last path segment when it looks like a name', () => {
    expect(linkTitle('https://example.com/reports/q3.html')).toBe('q3.html');
    expect(linkTitle('https://example.com/reports/')).toBe('example.com');
  });

  test('falls back to the host, without www and without a query', () => {
    expect(linkTitle('https://www.example.com/?tab=2')).toBe('example.com');
    expect(linkTitle('www.example.com/licences')).toBe('example.com');
  });
});

describe('contextAround', () => {
  test('a short message is its own context', () => {
    expect(contextAround('See localhost:3000 for the app.', 'localhost:3000')).toBe(
      'See localhost:3000 for the app.'
    );
  });

  test('a long message is cut around the link and marked at both ends', () => {
    const text = `${'alpha '.repeat(40)}the link http://localhost:5179 sits here ${'beta '.repeat(40)}`;
    const context = contextAround(text, 'http://localhost:5179');
    expect(context.length).toBeLessThanOrEqual(LINK_CONTEXT_LIMIT + 2);
    expect(context).toContain('http://localhost:5179');
    expect(context.startsWith('…')).toBe(true);
    expect(context.endsWith('…')).toBe(true);
  });

  test('a link the caller cannot find still yields a readable head', () => {
    const text = 'x'.repeat(LINK_CONTEXT_LIMIT * 2);
    expect(contextAround(text, 'missing').endsWith('…')).toBe(true);
  });
});

describe('linksFromItems', () => {
  const sources = [
    {
      sessionKey: 'hearth::16',
      at: 900,
      items: [item('e10', 'Open http://localhost:5179 and compare it with https://example.com/report.html.')],
    },
    {
      sessionKey: 'hearth::11',
      at: 400,
      items: [item('e4', 'The licence list lives at https://example.com/licences.')],
    },
  ];

  test('every link becomes one row, carrying the message it came from', () => {
    const links = linksFromItems(sources);
    expect(links).toHaveLength(3);
    const app = links.find((link) => link.url === 'http://localhost:5179');
    expect(app?.kind).toBe('app');
    expect(app?.sessionKey).toBe('hearth::16');
    expect(app?.messageId).toBe('e10');
    expect(app?.context).toContain('localhost:5179');
    expect(links.find((link) => link.url === 'https://example.com/report.html')?.kind).toBe('report');
  });

  test('the same link from two sessions is one row, and the newer one wins', () => {
    const links = linksFromItems([
      { sessionKey: 'old', at: 100, items: [item('e1', 'see https://example.com/x')] },
      { sessionKey: 'new', at: 500, items: [item('e9', 'the newer mention of https://example.com/x')] },
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].sessionKey).toBe('new');
    expect(links[0].messageId).toBe('e9');
  });

  test('the newest link leads and the list is bounded', () => {
    const many = Array.from({ length: SHARED_LINK_LIMIT + 5 }, (_, index) => ({
      sessionKey: 'hearth::1',
      at: index,
      items: [item(`e${index}`, `https://example.com/${index}`)],
    }));
    const links = linksFromItems(many);
    expect(links).toHaveLength(SHARED_LINK_LIMIT);
    expect(links[0].url).toBe(`https://example.com/${many.length - 1}`);
  });

  test('a local path is a file, not a page', () => {
    const links = linksFromItems([
      { sessionKey: 'hearth::1', at: 1, items: [item('e1', 'the docs are at /workspace/ember/README.md')] },
    ]);
    expect(links[0].kind).toBe('file');
    expect(links[0].title).toBe('README.md');
  });

  test('digest-shaped input goes through the same derivation', () => {
    const links = linksFromDigests(
      {
        'hearth::16': {
          version: 10,
          complete: true,
          items: [
            {
              id: 'e10',
              ordinal: 10,
              at: 1,
              kind: 'message',
              excerpt: 'https://example.com/a',
              truncated: false,
              tags: [],
            },
          ],
        },
      },
      () => 900
    );
    expect(links.map((link) => link.url)).toEqual(['https://example.com/a']);
  });
});
