import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import OnboardingWizard from '../src/components/OnboardingWizard';
import { blobColor } from '../src/blob/color';
import type { OnboardingState } from '../src/lib/onboarding';

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

const state: OnboardingState = {
  localReady: true,
  canRotate: true,
  remoteReady: false,
  targetInstanceId: 'local',
};

describe('OnboardingWizard decorative backdrop', () => {
  test('uses a lightweight zero-filter CSS radial gradient glow instead of a 400px blurred LavaBlob SVG filter', () => {
    ensureRenderableGlobals();
    const html = renderToStaticMarkup(
      <OnboardingWizard
        open
        startAtWelcome
        state={state}
        instanceDefaults={{}}
        models={[]}
        onRefreshModels={() => undefined}
        localProblem={null}
        instances={[{ id: 'local', label: 'This computer', kind: 'pi', status: 'ready', attachable: true }]}
        endpoints={[]}
        onDismiss={() => undefined}
        onRetryLocal={async () => undefined}
        onRefreshInstances={() => undefined}
        onChange={() => undefined}
        onStartAgent={() => undefined}
      />
    );

    expect(html).toContain('data-testid="onboarding"');
    expect(html).toContain('data-testid="onboarding-lava-glow"');
    expect(html).not.toContain('blob-lava');
    expect(html).not.toContain('blur-[48px]');
    expect(html).not.toContain('<filter');
    expect(html).not.toContain('feTurbulence');
    expect(html).not.toContain('feMorphology');

    const glowMatch = /data-testid="onboarding-lava-glow"[^>]*style="([^"]+)"/.exec(html);
    expect(glowMatch).not.toBeNull();
    expect(glowMatch![1]).toContain('radial-gradient');
    expect(glowMatch![1]).toContain(blobColor('lava', 'onboarding-fireglow'));

    // Welcome step's visible Buddy avatar and setup copy still render intact.
    expect(html).toContain('blob-buddy');
    expect(html).toContain('Where the work happens');
  });
});
