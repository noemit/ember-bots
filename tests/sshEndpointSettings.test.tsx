import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EndpointsSettings from '../src/components/EndpointsSettings';
import type { Instance, PiEndpoint } from '../src/types';

describe('EndpointsSettings SSH UI', () => {
  test('renders Over SSH option, Update via SSH on older SSH Kilns, and uninstall command on persistent Remove', () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      ember: {
        capabilities: { endpointManagement: true },
        testPiEndpoint: async () => ({ outcome: 'ready', host: 'Tower', message: 'Connected' }),
        listSshHosts: async () => [],
        probeSshHost: async () => ({ outcome: 'unreachable', target: 'tower', message: 'unreachable' }),
        setupSshKiln: async () => ({ ok: false, code: 'error', message: 'error' }),
      },
    };
    try {
      const endpoints: PiEndpoint[] = [
        {
          id: 'pi:ssh-tower',
          label: 'Tower',
          url: 'http://127.0.0.1:43100',
          token: 'tok',
          ssh: {
            target: 'tower',
            remotePort: 3002,
            lifetime: 'service',
            binaryPath: '/home/em/.local/bin/tinder',
          },
        },
      ];
      const instances: Instance[] = [
        {
          id: 'pi:ssh-tower',
          label: 'Tower',
          kind: 'pi',
          url: 'http://127.0.0.1:43100',
          status: 'ready',
          attachable: true,
          version: '1.0.0',
        },
      ];

      const html = renderToStaticMarkup(
        <EndpointsSettings
          endpoints={endpoints}
          instances={instances}
          onChange={() => {}}
          initialRemovingId="pi:ssh-tower"
        />
      );

      expect(html).toContain('Over SSH');
      expect(html).toContain('Update via SSH');
      expect(html).toContain('via SSH (tower · Background service)');
      expect(html).toContain('systemctl --user disable --now ember-kiln.service');
      expect(html).toContain('keeps running');
    } finally {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  });
});
