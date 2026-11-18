import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ModelPickerBody,
  Row,
  buildModelGroups,
  buildNavigableItems,
  createInitialPickerState,
  initialExpandedProviders,
  narrowedQuerySelection,
  pickModelInState,
  resolveModelCommit,
  stepSelectionInState,
  updateQueryInState,
  type PickerContext,
  type PickerState,
} from '../src/components/ModelPicker';
import { DEFAULT_MODEL, modelRefKey, type ModelOption } from '../src/types';

const makeModel = (
  providerID: string,
  providerName: string,
  modelID: string,
  name: string,
  variants: string[] = ['low', 'high'],
): ModelOption => ({
  providerID,
  modelID,
  label: `${providerName} / ${name}`,
  details: {
    name,
    providerName,
    family: name.split(' ')[0],
    status: 'active',
    contextTokens: 200_000,
    outputTokens: 64_000,
    costInput: 3,
    costOutput: 15,
    reasoning: variants.length > 0,
    toolcall: true,
    attachment: true,
    inputs: ['text', 'image'],
    variants,
  },
});

const catalogue: ModelOption[] = [
  makeModel('anthropic', 'Anthropic', 'claude-sonnet', 'Claude Sonnet'),
  makeModel('anthropic', 'Anthropic', 'claude-opus', 'Claude Opus'),
  makeModel('openai', 'OpenAI', 'gpt-5', 'GPT-5', ['low', 'medium', 'high']),
  makeModel('router', 'OpenRouter', 'glm-5-flash', 'GLM 5 Flash', ['low']),
];

const makeContext = (overrides: Partial<PickerContext> = {}): PickerContext => {
  const models = overrides.models ?? catalogue;
  return {
    models,
    recentModels: [],
    byKey: new Map(models.map((model) => [modelRefKey(model), model])),
    defaultModelId: 'anthropic/claude-sonnet',
    instanceDefaultModelId: 'anthropic/claude-sonnet',
    collapseProviders: true,
    requireConcreteModel: false,
    preserveVariantOnModelChange: false,
    ...overrides,
  };
};

const renderBody = (
  state: PickerState,
  context: PickerContext,
  handlers: Partial<React.ComponentProps<typeof ModelPickerBody>> = {},
) => {
  const noop = () => {};
  const groups = buildModelGroups(context.models, context.recentModels, context.byKey, state.query);
  return renderToStaticMarkup(
    <ModelPickerBody
      state={state}
      models={context.models as ModelOption[]}
      groups={groups}
      byKey={context.byKey}
      defaultModelId={context.defaultModelId}
      instanceDefaultModelId={context.instanceDefaultModelId}
      collapseProviders={context.collapseProviders}
      requireConcreteModel={context.requireConcreteModel}
      refreshing={false}
      onQueryChange={noop}
      onSearchKeyDown={noop}
      onListKeyDown={noop}
      onToggleProvider={noop}
      onRowHover={noop}
      onRowPick={noop}
      onRowCommit={noop}
      onVariantChange={noop}
      onCancel={noop}
      onApply={noop}
      {...handlers}
    />
  );
};

describe('smart provider expansion on open', () => {
  test('auto-expands all provider groups when there are two or fewer providers', () => {
    const twoProviders = catalogue.filter((model) => model.providerID !== 'router');
    const expanded = initialExpandedProviders(twoProviders, DEFAULT_MODEL, 'anthropic/claude-sonnet');
    expect([...expanded].sort()).toEqual(['anthropic', 'openai']);

    const context = makeContext({ models: twoProviders });
    const state = createInitialPickerState(DEFAULT_MODEL, '', context);
    const html = renderBody(state, context);
    expect(html.match(/<button type="button" aria-expanded="true"/g)?.length).toBe(2);
    expect(html).not.toContain('<button type="button" aria-expanded="false"');
    expect(html).toContain('data-model-key="anthropic/claude-sonnet"');
    expect(html).toContain('data-model-key="openai/gpt-5"');
  });

  test('auto-expands only the selected or server-default provider when more than two exist', () => {
    const forConcrete = initialExpandedProviders(catalogue, 'openai/gpt-5', 'anthropic/claude-sonnet');
    expect([...forConcrete]).toEqual(['openai']);

    const forDefault = initialExpandedProviders(catalogue, DEFAULT_MODEL, 'anthropic/claude-sonnet');
    expect([...forDefault]).toEqual(['anthropic']);

    const context = makeContext();
    const state = createInitialPickerState('openai/gpt-5', 'high', context);
    const html = renderBody(state, context);
    expect(html.match(/<button type="button" aria-expanded="true"/g)?.length).toBe(1);
    expect(html.match(/<button type="button" aria-expanded="false"/g)?.length).toBe(2);
    expect(html).toContain('data-model-key="openai/gpt-5"');
    expect(html).not.toContain('data-model-key="anthropic/claude-sonnet"');
    // Right-hand scorecard preview remains intact for the selected model.
    expect(html).toContain('aria-label="Model details"');
    expect(html).toContain('aria-label="Your model experience"');
    expect(html).toContain('>GPT-5</h3>');
  });

  test('falls back to the first alphabetical provider when neither selection nor default resolves', () => {
    const expanded = initialExpandedProviders(catalogue, '', null, null);
    expect([...expanded]).toEqual(['anthropic']);
  });
});

describe('keyboard navigation and search Enter commit', () => {
  test('ArrowDown steps through visible rows, auto-expands collapsed groups, and updates scorecard preview', () => {
    const context = makeContext();
    let state = createInitialPickerState(DEFAULT_MODEL, '', context);
    expect(state.selectedKey).toBe(DEFAULT_MODEL);
    expect([...state.expandedProviders]).toEqual(['anthropic']);

    // 1st ArrowDown: Server default -> Claude Sonnet (already expanded under Anthropic).
    state = stepSelectionInState(state, 1, context).state;
    expect(state.selectedKey).toBe('anthropic/claude-sonnet');
    expect(state.hovered).toBe('anthropic/claude-sonnet');

    // 2nd ArrowDown: Claude Sonnet -> Claude Opus.
    state = stepSelectionInState(state, 1, context).state;
    expect(state.selectedKey).toBe('anthropic/claude-opus');
    expect(state.hovered).toBe('anthropic/claude-opus');
    expect(state.expandedProviders.has('openai')).toBe(false);

    // 3rd ArrowDown: steps past Anthropic into collapsed OpenAI -> auto-expands OpenAI and previews GPT-5!
    const steppedIntoOpenAI = stepSelectionInState(state, 1, context);
    state = steppedIntoOpenAI.state;
    expect(steppedIntoOpenAI.targetKey).toBe('openai/gpt-5');
    expect(state.selectedKey).toBe('openai/gpt-5');
    expect(state.hovered).toBe('openai/gpt-5');
    expect(state.expandedProviders.has('openai')).toBe(true);

    const html = renderBody(state, context);
    expect(html).toContain('data-active="true" data-model-key="openai/gpt-5"');
    expect(html).toContain('>GPT-5</h3>');

    // Pressing Enter commits the keyboard-selected model immediately.
    const committed = resolveModelCommit(state, state.selectedKey, context);
    expect(committed.commit).toEqual({ key: 'openai/gpt-5', variant: '' });
  });

  test('ArrowUp from the top wraps to the last provider and auto-expands it', () => {
    const context = makeContext();
    const initial = createInitialPickerState(DEFAULT_MODEL, '', context);
    const wrapped = stepSelectionInState(initial, -1, context);
    expect(wrapped.targetKey).toBe('router/glm-5-flash');
    expect(wrapped.state.selectedKey).toBe('router/glm-5-flash');
    expect(wrapped.state.expandedProviders.has('router')).toBe(true);
  });

  test('deduplicates models shared between Recent and provider groups so ArrowDown never loops', () => {
    const context = makeContext({ recentModels: ['openai/gpt-5'] });
    const groups = buildModelGroups(context.models, context.recentModels, context.byKey, '');
    const items = buildNavigableItems(groups, true);
    expect(items.map((item) => item.key)).toEqual([
      DEFAULT_MODEL,
      'openai/gpt-5',
      'anthropic/claude-sonnet',
      'anthropic/claude-opus',
      'router/glm-5-flash',
    ]);
  });

  test('typing in search auto-highlights the first matching model so Enter commits immediately', () => {
    const context = makeContext();
    const initial = createInitialPickerState(DEFAULT_MODEL, '', context);
    const filtered = updateQueryInState(initial, 'glm', context);
    expect(filtered.selectedKey).toBe('router/glm-5-flash');
    expect(filtered.hovered).toBe('router/glm-5-flash');

    const html = renderBody(filtered, context);
    expect(html).toContain('data-active="true" data-model-key="router/glm-5-flash"');
    expect(html).toContain('>GLM 5 Flash</h3>');

    const committed = resolveModelCommit(filtered, filtered.selectedKey, context);
    expect(committed.commit).toEqual({ key: 'router/glm-5-flash', variant: '' });
  });

  test('narrowed search preserves an already-matching concrete selection and returns null when empty', () => {
    const context = makeContext();
    const claudeGroups = buildModelGroups(context.models, [], context.byKey, 'claude');
    expect(narrowedQuerySelection(claudeGroups, 'anthropic/claude-opus')).toBe('anthropic/claude-opus');

    const emptyGroups = buildModelGroups(context.models, [], context.byKey, 'nothing-matches');
    expect(narrowedQuerySelection(emptyGroups, 'anthropic/claude-opus')).toBeNull();
  });
});

describe('single-click preview vs double-click immediate commit', () => {
  test('single-click selects and previews without committing; double-click commits target directly', () => {
    const context = makeContext();
    const initial = createInitialPickerState('anthropic/claude-sonnet', 'high', context);

    // Single click updates selection and normalises variant for models without 'high'.
    const picked = pickModelInState(initial, 'router/glm-5-flash', context);
    expect(picked.selectedKey).toBe('router/glm-5-flash');
    expect(picked.selectedVariant).toBe('');
    expect(picked.hovered).toBe('router/glm-5-flash');

    // Double-click directly on another row commits that row immediately even from prior state.
    const doubleClicked = resolveModelCommit(initial, 'openai/gpt-5', context);
    expect(doubleClicked.commit).toEqual({ key: 'openai/gpt-5', variant: 'high' });

    // Queue-edit mode (`preserveVariantOnModelChange`) refuses to commit an incompatible effort on double-click.
    const queueContext = makeContext({ preserveVariantOnModelChange: true, requireConcreteModel: true });
    const blocked = resolveModelCommit(
      createInitialPickerState('openai/gpt-5', 'medium', queueContext),
      'router/glm-5-flash',
      queueContext,
    );
    expect(blocked.state.selectedKey).toBe('router/glm-5-flash');
    expect(blocked.commit).toBeNull();
  });

  test('Row wires mouse enter, single-click, double-click, and Enter key to stabilized key callbacks', () => {
    const events: string[] = [];
    const renderFn = (Row as unknown as { type: (props: React.ComponentProps<typeof Row>) => React.ReactElement }).type;
    const element = renderFn({
      model: catalogue[2],
      selected: false,
      active: true,
      onHover: (key) => events.push(`hover:${key}`),
      onPick: (key) => events.push(`pick:${key}`),
      onCommit: (key) => events.push(`commit:${key}`),
    });

    const outerProps = element.props as {
      onMouseEnter: () => void;
      onDoubleClick: () => void;
      children: React.ReactElement<{
        onClick: () => void;
        onFocus: () => void;
        onKeyDown: (event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void }) => void;
      }>;
    };
    outerProps.onMouseEnter();
    outerProps.children.props.onClick();
    outerProps.onDoubleClick();
    let prevented = false;
    outerProps.children.props.onKeyDown({
      key: 'Enter',
      preventDefault: () => { prevented = true; },
    });

    expect(prevented).toBe(true);
    expect(events).toEqual([
      'hover:openai/gpt-5',
      'pick:openai/gpt-5',
      'commit:openai/gpt-5',
      'commit:openai/gpt-5',
    ]);
  });
});

describe('Row memoization and stable callbacks', () => {
  test('Row is wrapped in React.memo and keeps shallow-equal props for untouched rows during hover', () => {
    expect((Row as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));

    const onHover: (key: string) => void = () => {};
    const onPick: (key: string) => void = () => {};
    const onCommit: (key: string) => void = () => {};

    const collectRowProps = (hoveredKey: string) => {
      const context = makeContext({ collapseProviders: false });
      const state: PickerState = {
        ...createInitialPickerState('anthropic/claude-sonnet', '', context),
        hovered: hoveredKey,
      };
      const groups = buildModelGroups(context.models, context.recentModels, context.byKey, '');
      const tree = ModelPickerBody({
        state,
        models: context.models as ModelOption[],
        groups,
        byKey: context.byKey,
        defaultModelId: context.defaultModelId,
        instanceDefaultModelId: context.instanceDefaultModelId,
        collapseProviders: false,
        requireConcreteModel: false,
        refreshing: false,
        onQueryChange: () => {},
        onSearchKeyDown: () => {},
        onListKeyDown: () => {},
        onToggleProvider: () => {},
        onRowHover: onHover,
        onRowPick: onPick,
        onRowCommit: onCommit,
        onVariantChange: () => {},
        onCancel: () => {},
        onApply: () => {},
      });

      const found = new Map<string, Record<string, unknown>>();
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const element = node as { type?: unknown; props?: Record<string, unknown> };
        if (element.type === Row && element.props) {
          const model = element.props.model as ModelOption;
          found.set(modelRefKey(model), element.props);
        }
        if (element.props?.children) walk(element.props.children);
      };
      walk(tree);
      return found;
    };

    const beforeHover = collectRowProps('anthropic/claude-sonnet');
    const afterHover = collectRowProps('anthropic/claude-opus');
    expect(beforeHover.size).toBe(4);

    const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      return keysA.length === keysB.length && keysA.every((key) => Object.is(a[key], b[key]));
    };

    // Only the old active row and newly hovered row changed `active`; untouched rows are 100% shallow-equal!
    expect(shallowEqual(beforeHover.get('anthropic/claude-sonnet')!, afterHover.get('anthropic/claude-sonnet')!)).toBe(false);
    expect(shallowEqual(beforeHover.get('anthropic/claude-opus')!, afterHover.get('anthropic/claude-opus')!)).toBe(false);
    expect(shallowEqual(beforeHover.get('openai/gpt-5')!, afterHover.get('openai/gpt-5')!)).toBe(true);
    expect(shallowEqual(beforeHover.get('router/glm-5-flash')!, afterHover.get('router/glm-5-flash')!)).toBe(true);
  });

  test('renders Done by default and custom confirmLabel when confirming also launches a run', () => {
    const context = makeContext();
    const state = createInitialPickerState('openai/gpt-5', '', context);
    expect(renderBody(state, context)).toContain('>Done</button>');
    expect(renderBody(state, context, { confirmLabel: 'Run with model' })).toContain('>Run with model</button>');
  });
});
