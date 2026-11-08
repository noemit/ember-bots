import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import ComposerIdentity from '../src/components/ComposerIdentity';

const identity = { sessionKey: 'host::chat', colorSeed: 'colour', shapeSeed: 'shape', motionSeed: 'motion' };
const render = (props: Partial<Parameters<typeof ComposerIdentity>[0]> = {}) => renderToStaticMarkup(
  <ComposerIdentity name="A long conversation title" seed="host::chat" identity={identity} style="buddy" mood="idle" {...props} />
);

describe('current bot actions', () => {
  for (const layout of [{ docked: true, compact: true }, { docked: true }, { docked: false }]) {
    test('named keyboard actions in ' + JSON.stringify(layout), () => {
      const html = render({ ...layout, onHide: () => {}, onNewBot: () => {} });
      expect(html).toContain('aria-label="Hide session"');
      expect(html).toContain('aria-label="New bot in this folder"');
      expect(html.match(/<button /g)).toHaveLength(2);
      const hideButton = html.match(/<button[^>]*aria-label="Hide session"[^>]*>[\s\S]*?<\/button>/)?.[0];
      expect(hideButton).toContain('lucide-eye-off');
      expect(hideButton).toContain('focus-visible:outline-ring');
      expect(hideButton).not.toContain('tabindex="-1"');
      expect(html).toContain('group-focus-within/identity:opacity-100');
      expect(html).toContain('[@media(hover:none)]:opacity-100');
      // Wide identities reserve action width; mini controls sit below the centred blob.
      expect(html).toContain(layout.compact ? 'absolute top-[calc(100%-8px)]' : 'shrink-0');
    });
  }
  test('shared action band blocks parent activation for docked and inline identities', () => {
    const source = ts.createSourceFile('ComposerIdentity.tsx', readFileSync(new URL('../src/components/ComposerIdentity.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const guarded = new Set<string>();
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'data-composer-identity-actions')) {
        for (const prop of node.attributes.properties) {
          if (!ts.isJsxAttribute(prop) || !prop.initializer) continue;
          const name = prop.name.getText(source);
          if (['onPointerDown', 'onClick', 'onDoubleClick', 'onKeyDown'].includes(name)) {
            expect(prop.initializer.getText(source)).toContain('stopPropagation()');
            guarded.add(name);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(guarded.size).toBe(4);
  });
  test('unavailable actions do not become dead buttons', () => {
    expect(render()).not.toContain('<button ');
    const html = render({ onHide: () => {}, hiding: true });
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('aria-label="New bot in this folder"');
  });
});
