import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';
import {
  InstanceDefaultsSettings,
  allInstancesBypassEnabled,
  confirmFleetYoloOn,
  fleetYoloConfirmationCopy,
  toggleFleetYoloAction,
} from '../src/components/SettingsPanel';
import type { EmberSettings, Instance, InstanceDefaults } from '../src/types';

const localInstance: Instance = {
  id: 'pi:local',
  label: 'This computer',
  url: 'http://127.0.0.1:3002',
  kind: 'pi',
  status: 'ready',
};

const remoteInstance: Instance = {
  id: 'pi:studio',
  label: 'Studio Mac',
  url: 'http://100.64.0.10:3002',
  kind: 'pi',
  status: 'ready',
};

const renderDefaults = ({
  instances = [localInstance, remoteInstance],
  instanceDefaults = {},
  initialConfirmingYoloAll = false,
}: {
  instances?: Instance[];
  instanceDefaults?: Record<string, InstanceDefaults>;
  initialConfirmingYoloAll?: boolean;
} = {}) => {
  const settings: EmberSettings = {
    ...DEFAULT_SETTINGS,
    instanceDefaults,
  };
  return renderToStaticMarkup(
    React.createElement(InstanceDefaultsSettings, {
      instances,
      projectsByInstance: {},
      modelsByInstance: {},
      recentModelsByInstance: {},
      settings,
      onChange: () => undefined,
      initialConfirmingYoloAll,
    }),
  );
};

describe('InstanceDefaultsSettings fleet-wide YOLO confirmation', () => {
  test('requires inline Confirm YOLO on all / Cancel confirmation before enabling YOLO across instances', () => {
    const existingDefaults: Record<string, InstanceDefaults> = {
      'pi:local': { directory: '/workspace/app', bypass: false },
      'pi:studio': { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } },
    };

    expect(allInstancesBypassEnabled([localInstance, remoteInstance], existingDefaults)).toBe(false);

    // Clicking Turn YOLO on stages inline confirmation without writing bypass: true yet.
    const staged = toggleFleetYoloAction([localInstance, remoteInstance], existingDefaults);
    expect(staged).toEqual({ confirming: true });

    const idleHtml = renderDefaults({ instanceDefaults: existingDefaults });
    expect(idleHtml).toContain('Edit first connection…');
    expect(idleHtml).toContain('Turn YOLO on');
    expect(idleHtml).not.toContain('Confirm YOLO on all');

    const confirmHtml = renderDefaults({
      instanceDefaults: existingDefaults,
      initialConfirmingYoloAll: true,
    });
    expect(confirmHtml).toContain('role="group"');
    expect(confirmHtml).toContain('aria-label="Turn YOLO on across computers and containers"');
    expect(confirmHtml).toContain('Confirm YOLO on all');
    expect(confirmHtml).toContain('Cancel');
    expect(confirmHtml).toContain('all 2 computers and containers');
    expect(confirmHtml).toContain('Existing chats keep their settings.');
    expect(confirmHtml).not.toMatch(/HTTP [0-9]|undefined|null|stack|!|\b(?:archive|restore)\b/i);

    // Confirming enables bypass on every connected host while preserving existing host defaults.
    const next = confirmFleetYoloOn([localInstance, remoteInstance], existingDefaults);
    expect(next).toEqual({
      'pi:local': { directory: '/workspace/app', bypass: true },
      'pi:studio': { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, bypass: true },
    });
  });

  test('names a single host cleanly in confirmation copy and turns YOLO off immediately without confirmation', () => {
    const singleCopy = fleetYoloConfirmationCopy([localInstance]);
    expect(singleCopy).toContain('This computer');
    expect(singleCopy).not.toContain('all 1 ');
    expect(singleCopy).not.toMatch(/!/);

    const allOnDefaults: Record<string, InstanceDefaults> = {
      'pi:local': { directory: '/workspace/app', bypass: true },
      'pi:studio': { bypass: true },
    };
    expect(allInstancesBypassEnabled([localInstance, remoteInstance], allOnDefaults)).toBe(true);

    const allOnHtml = renderDefaults({
      instanceDefaults: allOnDefaults,
      initialConfirmingYoloAll: true,
    });
    expect(allOnHtml).toContain('Turn YOLO off');
    expect(allOnHtml).not.toContain('Confirm YOLO on all');

    const disabled = toggleFleetYoloAction([localInstance, remoteInstance], allOnDefaults);
    expect(disabled).toEqual({
      confirming: false,
      nextDefaults: {
        'pi:local': { directory: '/workspace/app', bypass: false },
        'pi:studio': { bypass: false },
      },
    });
  });
});
