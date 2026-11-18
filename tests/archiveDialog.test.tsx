import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ArchiveDialogBody,
  archiveQueryReducer,
  filterHiddenSessions,
  type ArchiveDialogBodyProps,
} from '../src/components/ArchiveDialog';
import { Dialog } from '../src/components/ui/dialog';
import { Input } from '../src/components/ui/input';
import { TooltipProvider } from '../src/components/ui/tooltip';
import type { Instance, Project, Session } from '../src/types';

const ensureRenderableGlobals = () => {
  const scope = globalThis as { window?: Record<string, unknown> };
  const current = scope.window ?? {};
  if (typeof current.addEventListener === 'function') return;
  scope.window = {
    ...current,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
};

const instance: Instance = {
  id: 'pi:local',
  label: 'This computer',
  kind: 'pi',
  status: 'ready',
  attachable: true,
};

const projectsByInstance: Record<string, Project[]> = {
  'pi:local': [
    { id: 'proj-kiln', name: 'Kiln Harness', path: '/work/kiln' },
    { id: 'proj-web', name: 'Marketing Site', path: '/work/site' },
  ],
};

const hiddenSessions: Session[] = [
  {
    id: 's-older',
    instanceId: 'pi:local',
    title: 'Fix OAuth callback',
    directory: '/work/kiln/packages/auth',
    archived: 1000,
    updated: 1000,
  },
  {
    id: 's-newer',
    instanceId: 'pi:local',
    title: 'Landing page typography',
    directory: '/work/site',
    archived: 2000,
    updated: 2000,
  },
  {
    id: 's-ops',
    instanceId: 'pi:local',
    title: 'Weekly metrics check',
    directory: '/srv/analytics-pipeline',
    archived: 1500,
    updated: 1500,
  },
];

const previews: Record<string, string> = {
  'pi:local::s-older': 'Rotated refresh token cleanly.',
  'pi:local::s-newer': 'Adjusted heading scale for mobile.',
  'pi:local::s-ops': 'Exported retention CSV summary.',
};

const makeBodyProps = (overrides: Partial<ArchiveDialogBodyProps> = {}): ArchiveDialogBodyProps => ({
  sessions: hiddenSessions,
  query: '',
  onQueryChange: () => {},
  projectsByInstance,
  instances: [instance],
  moods: {},
  previews,
  avatarIdentities: {},
  blobStyle: 'lava',
  instanceDefaults: {},
  reloadingKeys: new Set(),
  archivingKeys: new Set(),
  onRestoreSession: () => {},
  onReload: () => {},
  onArchive: () => {},
  onCustomizeAppearance: () => {},
  ...overrides,
});

const renderBody = (overrides: Partial<ArchiveDialogBodyProps> = {}) => {
  ensureRenderableGlobals();
  return renderToStaticMarkup(
    <TooltipProvider>
      <Dialog open>
        <ArchiveDialogBody {...makeBodyProps(overrides)} />
      </Dialog>
    </TooltipProvider>
  );
};

const findElement = (
  node: unknown,
  predicate: (el: { type?: unknown; props?: Record<string, unknown> }) => boolean
): { type?: unknown; props: Record<string, unknown> } | null => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props && predicate(el)) return el as { type?: unknown; props: Record<string, unknown> };
  return findElement(el.props?.children, predicate);
};

describe('ArchiveDialog search input, filtering, and close reset', () => {
  test('renders Search hidden sessions input only when hidden sessions exist', () => {
    const emptyHtml = renderBody({ sessions: [] });
    expect(emptyHtml).not.toContain('aria-label="Search hidden sessions"');
    expect(emptyHtml).toContain('No hidden sessions here.');

    const populatedHtml = renderBody();
    expect(populatedHtml).toContain('placeholder="Search hidden sessions…"');
    expect(populatedHtml).toContain('aria-label="Search hidden sessions"');
    expect(populatedHtml.indexOf('aria-label="Search hidden sessions"')).toBeLessThan(
      populatedHtml.indexOf('Landing page typography')
    );
  });

  test('filters hidden sessions case-insensitively by title, project, directory, and preview text', () => {
    // Empty or whitespace query returns all sessions sorted newest-first.
    expect(filterHiddenSessions(hiddenSessions, '   ', projectsByInstance, previews).map((s) => s.id)).toEqual([
      's-newer',
      's-ops',
      's-older',
    ]);

    // Match by title (case-insensitive).
    expect(filterHiddenSessions(hiddenSessions, 'OAUTH CALLBACK', projectsByInstance, previews).map((s) => s.id)).toEqual([
      's-older',
    ]);

    // Match by project name (case-insensitive).
    expect(filterHiddenSessions(hiddenSessions, 'kiln harness', projectsByInstance, previews).map((s) => s.id)).toEqual([
      's-older',
    ]);

    // Match by directory path (case-insensitive).
    expect(filterHiddenSessions(hiddenSessions, 'ANALYTICS-PIPELINE', projectsByInstance, previews).map((s) => s.id)).toEqual([
      's-ops',
    ]);

    // Match by preview text (case-insensitive).
    expect(filterHiddenSessions(hiddenSessions, 'heading scale', projectsByInstance, previews).map((s) => s.id)).toEqual([
      's-newer',
    ]);

    // Rendered list reflects the active query and shows a calm empty state when nothing matches.
    const filteredHtml = renderBody({ query: 'retention csv' });
    expect(filteredHtml).toContain('Weekly metrics check');
    expect(filteredHtml).not.toContain('Fix OAuth callback');
    expect(filteredHtml).not.toContain('Landing page typography');

    const noMatchHtml = renderBody({ query: 'nonexistent-topic' });
    expect(noMatchHtml).toContain('aria-label="Search hidden sessions"');
    expect(noMatchHtml).toContain('No hidden sessions match “nonexistent-topic”.');
    expect(noMatchHtml).not.toMatch(/\b(?:archive|archived|archiving|restore|restoring)\b/i);
  });

  test('clears query on Escape or Clear search button and resets query when dialog closes', () => {
    const changes: string[] = [];
    const tree = ArchiveDialogBody(
      makeBodyProps({
        query: 'oauth',
        onQueryChange: (next) => changes.push(next),
      })
    );

    const searchInput = findElement(tree, (el) => el.type === Input);
    expect(searchInput).not.toBeNull();
    let prevented = false;
    let stopped = false;
    (searchInput!.props.onKeyDown as (event: unknown) => void)({
      key: 'Escape',
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(changes).toEqual(['']);

    const clearButton = findElement(tree, (el) => el.props?.['aria-label'] === 'Clear search');
    expect(clearButton).not.toBeNull();
    (clearButton!.props.onClick as () => void)();
    expect(changes).toEqual(['', '']);

    // State reducer resets query whenever the dialog closes and preserves it while open.
    let state = archiveQueryReducer('', { type: 'change', query: 'kiln' });
    expect(state).toBe('kiln');
    state = archiveQueryReducer(state, { type: 'openChange', open: true });
    expect(state).toBe('kiln');
    state = archiveQueryReducer(state, { type: 'openChange', open: false });
    expect(state).toBe('');
  });
});
