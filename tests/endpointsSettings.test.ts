import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EndpointsSettings, {
  canRemoveEndpoint,
  commitEndpoints,
  confirmRemoveEndpoint,
  initialEndpointLocation,
  type EndpointsSettingsProps,
} from '../src/components/EndpointsSettings';
import type { EmberSettingsPatch, Instance, PiEndpoint } from '../src/types';

const localEndpoint: PiEndpoint = {
  id: 'pi:local',
  label: 'This computer',
  url: 'http://127.0.0.1:3002',
  token: 'local-secret-token',
};

const remoteEndpoint: PiEndpoint = {
  id: 'pi:studio',
  label: 'Studio Mac',
  url: 'http://100.64.0.10:3002',
  token: 'remote-secret-token',
};

const instances: Instance[] = [
  { id: 'pi:local', label: 'This computer', url: localEndpoint.url, kind: 'pi', status: 'ready' },
  { id: 'pi:studio', label: 'Studio Mac', url: remoteEndpoint.url, kind: 'pi', status: 'ready' },
];

function withDesktopBridge<T>(run: () => T): T {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = {
    ember: {
      capabilities: { endpointManagement: true },
      testPiEndpoint: async () => ({ outcome: 'ready', host: 'Studio Mac', message: 'ok' }),
      piRequest: async () => ({ ok: true, status: 200, data: {} }),
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

const renderSettings = (props: Partial<EndpointsSettingsProps> & Pick<EndpointsSettingsProps, 'endpoints'>) =>
  withDesktopBridge(() =>
    renderToStaticMarkup(
      React.createElement(EndpointsSettings, {
        instances,
        onChange: () => undefined,
        ...props,
      }),
    ),
  );

describe('EndpointsSettings UX safeguards', () => {
  test('hides silent no-op Remove on built-in pi:local while keeping Remove on remote endpoints', () => {
    expect(canRemoveEndpoint(localEndpoint)).toBe(false);
    expect(canRemoveEndpoint(remoteEndpoint)).toBe(true);

    const html = renderSettings({ endpoints: [localEndpoint, remoteEndpoint] });
    expect(html).toContain('Edit This computer');
    expect(html).not.toContain('Remove This computer');
    expect(html).toContain('Remove Studio Mac');

    // Even if removal state points at pi:local, neither confirmation nor deletion can fire.
    const guardedHtml = renderSettings({
      endpoints: [localEndpoint, remoteEndpoint],
      initialRemovingId: 'pi:local',
    });
    expect(guardedHtml).not.toContain('aria-label="Remove This computer"');

    let changed = false;
    const noopResult = confirmRemoveEndpoint([localEndpoint, remoteEndpoint], 'pi:local', () => {
      changed = true;
    });
    expect(noopResult).toEqual({ nextRemoving: null, promise: null });
    expect(changed).toBe(false);
  });

  test('requires inline Confirm remove / Cancel confirmation before deleting a remote endpoint', async () => {
    const idleHtml = renderSettings({ endpoints: [localEndpoint, remoteEndpoint] });
    expect(idleHtml).not.toContain('aria-label="Remove Studio Mac"');
    expect(idleHtml).not.toContain('Confirm remove');

    const confirmingHtml = renderSettings({
      endpoints: [localEndpoint, remoteEndpoint],
      initialRemovingId: 'pi:studio',
    });
    expect(confirmingHtml).toContain('role="group" aria-label="Remove Studio Mac"');
    expect(confirmingHtml).toContain('Confirm remove');
    expect(confirmingHtml).toContain('Cancel');
    expect(confirmingHtml).toContain('Studio Mac');
    expect(confirmingHtml).toContain('Ember');
    expect(confirmingHtml).toContain('conversations stay on that host');
    expect(confirmingHtml).not.toMatch(/HTTP [0-9]|undefined|null|stack|!/);

    const patches: EmberSettingsPatch[] = [];
    let refreshed = 0;
    const confirmed = confirmRemoveEndpoint(
      [localEndpoint, remoteEndpoint],
      'pi:studio',
      (patch) => {
        patches.push(patch);
      },
      () => {
        refreshed += 1;
      },
    );
    expect(confirmed.nextRemoving).toBeNull();
    await confirmed.promise;
    expect(patches).toEqual([{ piEndpoints: [localEndpoint] }]);
    expect(refreshed).toBe(1);
  });

  test('defaults Add computer or container to remote when pi:local is already in endpoints', () => {
    expect(initialEndpointLocation([])).toBe('local');
    expect(initialEndpointLocation([remoteEndpoint])).toBe('local');
    expect(initialEndpointLocation([localEndpoint])).toBe('remote');
    expect(initialEndpointLocation([localEndpoint, remoteEndpoint])).toBe('remote');

    const withLocalHtml = renderSettings({ endpoints: [localEndpoint] });
    expect(withLocalHtml).toMatch(/aria-pressed="true"[^>]*>On another computer or container<\/button>/);
    expect(withLocalHtml).toMatch(/aria-pressed="false"[^>]*>On this computer<\/button>/);
    expect(withLocalHtml).toContain('Computer or container name');
    expect(withLocalHtml).toContain('Kiln URL');
    expect(withLocalHtml).toContain('Bearer token');
    expect(withLocalHtml).not.toContain('Ember includes a local Kiln. No network setup is needed.');

    const withoutLocalHtml = renderSettings({ endpoints: [remoteEndpoint] });
    expect(withoutLocalHtml).toMatch(/aria-pressed="true"[^>]*>On this computer<\/button>/);
    expect(withoutLocalHtml).toContain('Ember includes a local Kiln. No network setup is needed.');
  });

  test('refreshes instances after onChange settles instead of racing a 50ms timer', async () => {
    const code = readFileSync(new URL('../src/components/EndpointsSettings.tsx', import.meta.url), 'utf8');
    expect(code).not.toContain('setTimeout');

    let resolveSave!: () => void;
    const events: string[] = [];
    const pending = commitEndpoints(
      [localEndpoint, remoteEndpoint],
      () =>
        new Promise<void>((resolve) => {
          events.push('save:start');
          resolveSave = () => {
            events.push('save:done');
            resolve();
          };
        }),
      () => {
        events.push('refresh');
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['save:start']);
    resolveSave();
    await pending;
    expect(events).toEqual(['save:start', 'save:done', 'refresh']);

    let refreshedOnFailure = false;
    await commitEndpoints(
      [localEndpoint],
      () => Promise.reject(new Error('disk full')),
      () => {
        refreshedOnFailure = true;
      },
    );
    expect(refreshedOnFailure).toBe(false);
  });
});
