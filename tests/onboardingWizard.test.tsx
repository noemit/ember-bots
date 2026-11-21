import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import OnboardingWizard from '../src/components/OnboardingWizard';
import ProvidersSettings from '../src/components/ProvidersSettings';
import type { OnboardingState, OnboardingStepId } from '../src/lib/onboarding';
import type { Instance, InstanceDefaults, ModelOption, PiEndpoint } from '../src/types';

const baseState: OnboardingState = {
  localReady: true,
  canRotate: true,
  remoteReady: false,
  targetInstanceId: 'pi:local',
};

const piInstance: Instance = {
  id: 'pi:local',
  label: 'This computer',
  url: 'http://127.0.0.1:3002',
  status: 'ready',
  kind: 'pi',
};

const openchamberInstance: Instance = {
  id: 'local',
  label: 'This computer',
  url: 'http://127.0.0.1:3000',
  status: 'ready',
  kind: 'openchamber',
};

const endpoint: PiEndpoint = {
  id: 'pi:local',
  label: 'This computer',
  url: 'http://127.0.0.1:3002',
  token: 'secret',
};

const offeredModels: ModelOption[] = [
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
];

function withMockWindow<T>(run: () => T): T {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  const existing = typeof previous === 'object' && previous !== null ? (previous as Record<string, unknown>) : {};
  scope.window = {
    ...existing,
    ember: {
      piRequest: async () => ({ status: 200, json: { providers: [] } }),
      openExternal: async () => undefined,
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

function renderWizard(overrides: {
  open?: boolean;
  startAtWelcome?: boolean;
  initialStepOverride?: OnboardingStepId;
  state?: OnboardingState;
  instances?: Instance[];
  endpoints?: PiEndpoint[];
  models?: ModelOption[];
  instanceDefaults?: Record<string, InstanceDefaults>;
} = {}) {
  return withMockWindow(() =>
    renderToStaticMarkup(
      <OnboardingWizard
        open={overrides.open ?? true}
        startAtWelcome={overrides.startAtWelcome ?? true}
        initialStepOverride={overrides.initialStepOverride}
        state={overrides.state ?? baseState}
        instanceDefaults={overrides.instanceDefaults ?? {}}
        models={overrides.models ?? offeredModels}
        onRefreshModels={() => undefined}
        localProblem={null}
        instances={overrides.instances ?? [piInstance]}
        endpoints={overrides.endpoints ?? [endpoint]}
        onDismiss={() => undefined}
        onRetryLocal={async () => undefined}
        onRefreshInstances={() => undefined}
        onChange={() => undefined}
        onStartAgent={() => undefined}
      />
    )
  );
}

describe('OnboardingWizard UX, Dialog containment, responsive layout & copy', () => {
  test('renders nothing when closed and preserves Radix modal dialog contract when open', () => {
    expect(renderWizard({ open: false })).toBe('');

    const html = renderWizard({ startAtWelcome: true });
    expect(html).toContain('data-testid="onboarding"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="onboarding-title"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('id="onboarding-title"');
    expect(html).toContain('data-testid="onboarding-surface"');
    expect(html).toContain('data-testid="onboarding-next"');

    // Radix FocusScope makes the dialog container focusable (tabindex="-1") and DialogDescription uses a span rather than a <p> so Welcome <p> font-size checks stay >= 16px.
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/<span class="sr-only" id="radix-[^"]+">/);
    expect(html).toContain('Skip for now');
    expect(html).toContain('1. Ember and Kiln');
    expect(html).toContain('2. Where to run Kiln');
    expect(html).toContain('3. Your token');
    expect(html).toContain('4. Choose an AI');
    expect(html).toContain('5. First bot');
    expect(html).toContain('6. Yours to use');
  });

  test('stacks step pills above content below 768px with tightened mobile padding instead of a 260px sidebar squeeze', () => {
    const html = renderWizard({ startAtWelcome: true });

    // Outer split stacks vertically on mobile and becomes two columns only from md (768px) upward.
    expect(html).toContain('flex min-h-0 flex-1 flex-col md:flex-row');

    // Step list becomes a horizontal scrollable pill strip on mobile and a 240px/260px sidebar on md/lg.
    expect(html).toMatch(/<ol[^>]*w-full[^>]*overflow-x-auto[^>]*border-b[^>]*md:w-\[240px\][^>]*md:border-r[^>]*md:border-b-0[^>]*lg:w-\[260px\]/);

    // Step summaries hide inside compact mobile pills and reappear on md+.
    expect(html).toContain('hidden text-base leading-snug text-muted-foreground md:block');

    // Scrollable step body tightens horizontal padding to px-4 on mobile (343px+ at 375px viewport) and md:px-8 on desktop.
    expect(html).toContain('min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7');
  });

  test('points remote sharing copy at Settings → Remote access → Share this Kiln', () => {
    const html = renderWizard({
      startAtWelcome: false,
      state: { localReady: false, canRotate: false, remoteReady: false, targetInstanceId: null },
    });

    expect(html).toContain('Settings → Remote access → Share this Kiln');
    expect(html).not.toContain('Settings → Instances → Share this Kiln');
  });

  test('styles #onboarding-default-model as the single default-model summary on Choose an AI', () => {
    const defaults: Record<string, InstanceDefaults> = {
      local: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } },
      'pi:local': { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } },
    };

    const wizardHtml = renderWizard({
      startAtWelcome: false,
      state: { localReady: true, canRotate: true, remoteReady: false, targetInstanceId: 'local' },
      instances: [openchamberInstance, piInstance],
      instanceDefaults: defaults,
    });

    expect(wizardHtml).toContain('id="onboarding-default-model"');
    expect(wizardHtml).toContain('Default model for This computer');
    expect(wizardHtml).toContain('Refresh models');
    // OnboardingWizard suppresses ProvidersSettings' duplicate "New chats default to ..." line.
    expect(wizardHtml).not.toContain('New chats default to');

    // Standalone Settings -> Providers keeps its default-model summary line intact.
    const settingsHtml = withMockWindow(() =>
      renderToStaticMarkup(
        <ProvidersSettings
          endpoints={[endpoint]}
          instances={[piInstance]}
          instanceDefaults={defaults}
        />
      )
    );
    expect(settingsHtml).toContain('New chats default to anthropic/claude-sonnet-4-5.');
  });

  test('simplifies disconnected-Kiln steps 4 and 5 and clarifies bundled Kiln failure copy', () => {
    const disconnected: OnboardingState = {
      localReady: false,
      canRotate: false,
      remoteReady: false,
      targetInstanceId: null,
    };

    const connectionHtml = renderWizard({
      startAtWelcome: false,
      state: disconnected,
      instances: [],
      endpoints: [],
      models: [],
    });
    expect(connectionHtml).toContain('Included Kiln is not ready on this computer');
    expect(connectionHtml).toContain('Ember ships with a local Kiln');
    expect(connectionHtml).toContain('Retry');

    const providersHtml = renderWizard({
      startAtWelcome: false,
      initialStepOverride: 'providers',
      state: disconnected,
      instances: [],
      endpoints: [],
      models: [],
    });
    expect(providersHtml).toContain('data-testid="onboarding-providers-disconnected"');
    expect(providersHtml).toContain('Where to run Kiln');
    expect(providersHtml).toContain('Connect a Kiln first');
    expect(providersHtml).not.toContain('Open OpenCode');

    const firstAgentHtml = renderWizard({
      startAtWelcome: false,
      initialStepOverride: 'first-agent',
      state: disconnected,
      instances: [],
      endpoints: [],
      models: [],
    });
    expect(firstAgentHtml).toContain('data-testid="onboarding-first-agent-disconnected"');
    expect(firstAgentHtml).toContain('Where to run Kiln');
    expect(firstAgentHtml).toContain('Connect a Kiln first');
    expect(firstAgentHtml).not.toContain('>Continue<');
  });
});
