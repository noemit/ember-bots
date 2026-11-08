import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { archiveEmptyCopy } from '../src/lib/instanceHealth';
import { sessionVisibilityFailure } from '../src/lib/sessionVisibility';
import { entryLine } from '../src/lib/activityView';

const source = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

describe('session hiding copy', () => {
  test('failures name the host and a recovery without jargon', () => {
    for (const hidden of [true, false]) {
      const copy = sessionVisibilityFailure('Tower', hidden);
      expect(copy).toContain('Tower');
      expect(copy).toMatch(/retry/i);
      expect(copy).toMatch(hidden ? /\bhide\b/ : /\bunhide\b/);
      expect(copy).not.toMatch(/archive|restore|undefined|null|HTTP|!|something went wrong/i);
    }
    expect(sessionVisibilityFailure(undefined, true)).toMatch(/host/i);
  });

  test('empty and unavailable lists explain the next step', () => {
    for (const state of ['no-endpoints', 'checking', 'no-answers', 'ready'] as const) {
      const copy = archiveEmptyCopy({ state, endpointCount: 1 });
      expect(copy).not.toMatch(/archiv|restor|undefined|HTTP|!/i);
      expect(copy).toMatch(/settings|waiting|retry|hide session/i);
    }
  });

  test('session controls expose hide terminology, never deletion icons', () => {
    for (const name of ['SessionRow', 'ChatView', 'LeftRail', 'ProjectCard', 'GroupRow', 'ProjectCleanupMenu', 'ArchiveSessionDialog']) {
      const code = source('src/components/' + name + '.tsx');
      expect(code).toContain('EyeOff');
      expect(code).not.toMatch(/Trash2|ArchiveRestore/);
    }
    expect(source('src/components/SessionRow.tsx')).toMatch(/archived \? Eye : EyeOff/);
    for (const name of ['SessionNotes', 'QueuedMessageList', 'ProvidersSettings', 'EndpointsSettings']) {
      expect(source('src/components/' + name + '.tsx')).toContain('Trash2');
    }
  });

  test('UI text has no old archive or restore wording (internal identifiers stay intact)', () => {
    const paths = ['App', ...['ArchiveDialog', 'ArchiveSessionDialog', 'SessionRow', 'ChatView', 'LeftRail', 'ProjectCard', 'GroupRow', 'ProjectCleanupMenu', 'SettingsPanel'].map(name => 'components/' + name)];
    for (const path of paths) {
      const ast = ts.createSourceFile(path + '.tsx', source('src/' + path + '.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          expect(node.text).not.toMatch(/\b(?:archive|archived|archiving|restore|restoring)\b/i);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  });

  test('old activity milestones display hiding without rewriting user content', () => {
    const entry = { id: 'a', at: 1, instanceId: 'local', type: 'openchamber:session-archived', summary: 'session archived' };
    expect(entryLine(entry)).toMatch(/hidden/);
    expect(entryLine({ ...entry, type: 'message', summary: 'Archive my files' })).toBe('Archive my files');
  });
});
