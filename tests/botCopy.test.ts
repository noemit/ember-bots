import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ONBOARDING_STEPS, workspaceHint } from '../src/lib/onboarding';
import { activityEmptyCopy } from '../src/lib/instanceHealth';
import { agentMessageBudgetRefusal, directoryEmptyCopy, hostDirectoryNote } from '../src/lib/agentDirectory';

/** Product vocabulary is separate from protocol names (`agent`, `agents`, `first-agent`). */
const expectBotCopy = (copy: string) => {
  expect(copy).toMatch(/\bbots?\b/i);
  expect(copy).not.toMatch(/\bagents?\b/i);
  expect(copy).not.toMatch(/\ban bot\b|undefined|null|!/i);
};

describe('bot product terminology', () => {
  test('the composer uses the requested placeholder and a matching accessible name', () => {
    const composer = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
    expect(composer).toContain("'Message your bot..'");
    expect(composer).toContain("'Message your bot'");
    expect(composer).not.toContain('Message the agent');
    // Internal protocol access stays intact; a terminology change must not rename wire fields.
    expect(composer).toContain('session.agent');
  });

  test('setup names the bot while keeping the persisted step id', () => {
    expect(ONBOARDING_STEPS.find(step => step.id === 'first-agent')?.title).toBe('First bot');
    expectBotCopy(workspaceHint(null));
  });

  test('directory and activity recovery copy uses bots rather than API terminology', () => {
    expectBotCopy(agentMessageBudgetRefusal());
    expectBotCopy(directoryEmptyCopy([]));
    expectBotCopy(hostDirectoryNote({ state: 'agents', agents: [] })!);
    expectBotCopy(activityEmptyCopy({ state: 'connected', endpointCount: 1 }));
  });
});


test('renderer literal copy uses bots without renaming protocol tokens or instruction filenames', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const technicalValues = new Set([
    '/agent', 'pi.agent', 'session.agent.selected', 'agents',
    'new-agent', 'first-agent', '--connection-agent', 'User-Agent',
  ]);
  const violations: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!/\.tsx?$/.test(path)) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        // Comments, type names and identifiers are not product copy. Template fragments are:
        // keeping them separate also avoids mistaking interpolation identifiers for displayed text.
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
          const text = node.text.trim();
          const fixturePath = relative(root, path) === 'dev/mockLegacy.ts' && /^\/workspace\/agent(?:\/|$)/.test(text);
          if (!technicalValues.has(text) && !fixturePath && /\bagents?\b/i.test(text.replaceAll('AGENTS.md', ''))) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            violations.push(`${relative(root, path)}:${line}: ${text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  scan(root);
  expect(violations).toEqual([]);
});
