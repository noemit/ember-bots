import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionCard } from '../src/components/Transcript';
import { piApprovalToPermissionRequest, type PiApproval } from '../src/lib/piMapping';
import { rememberPiInstances } from '../src/piApi';

const renderApproval = (approval: PiApproval, endpointId = 'pi:local'): string => {
  rememberPiInstances([{ id: endpointId, kind: 'pi' }]);
  const request = piApprovalToPermissionRequest(endpointId, approval);
  return renderToStaticMarkup(<PermissionCard request={request} onReply={async () => true} />);
};

describe('PermissionCard rendering for S1 gated tools', () => {
  test('renders schedule create/update/remove approvals with unattended YOLO warning, schedule details, and no jargon', () => {
    const html = renderApproval({
      conversationId: '10',
      key: '42',
      tool: 'schedule',
      arguments: {
        action: 'create',
        name: 'Nightly audit',
        schedule: { kind: 'weekly', time: '22:30', weekdays: [1, 4], timezone: 'Europe/Berlin' },
        cwd: '/home/em/project',
        prompt: 'Run bun test and summarise failures.',
      },
    });
    expect(html).toContain('Approval needed');
    expect(html).toContain('schedule');
    expect(html).toMatch(/unattended/i);
    expect(html).toMatch(/YOLO/i);
    expect(html).toContain('Nightly audit');
    expect(html).toContain('weekly Mon,Thu 22:30 Europe/Berlin');
    expect(html).toContain('/home/em/project');
    expect(html).toContain('Run bun test and summarise failures.');
    expect(html).toContain('Allow once');
    expect(html).toContain('Deny');
    // Command-only remembered rules dialog is withheld on non-bash tools.
    expect(html).not.toContain('Allow similar…');
    expect(html).not.toMatch(/undefined|null|NaN/);

    const removeHtml = renderApproval({
      conversationId: '10',
      key: '43',
      tool: 'schedule',
      arguments: { action: 'remove', task: 'Nightly audit' },
    });
    expect(removeHtml).toContain('remove');
    expect(removeHtml).toContain('Nightly audit');
    expect(removeHtml).toMatch(/YOLO/i);
    expect(removeHtml).not.toMatch(/undefined|null|NaN/);
  });

  test('renders agents send approval with recipient and message preview', () => {
    const html = renderApproval({
      conversationId: '10',
      key: '44',
      tool: 'agents',
      arguments: {
        action: 'send',
        name: 'Builder',
        message: 'Deploy staging branch now.',
      },
    });
    expect(html).toContain('Approval needed');
    expect(html).toContain('agents');
    expect(html).toContain('Builder');
    expect(html).toContain('Deploy staging branch now.');
    expect(html).not.toContain('Allow similar…');
    expect(html).not.toMatch(/undefined|null|NaN/);
  });

  test('renders MCP tool approvals (both namespaced and collapsed) cleanly, while keeping Allow similar… on bash', () => {
    const mcpHtml = renderApproval({
      conversationId: '10',
      key: '45',
      tool: 'playwright__navigate',
      arguments: { url: 'https://example.com' },
    });
    expect(mcpHtml).toContain('playwright__navigate');
    expect(mcpHtml).toContain('navigate');
    expect(mcpHtml).toContain('playwright');
    expect(mcpHtml).toContain('https://example.com');
    expect(mcpHtml).not.toContain('Allow similar…');
    expect(mcpHtml).not.toMatch(/undefined|null|NaN/);

    const collapsedHtml = renderApproval({
      conversationId: '10',
      key: '46',
      tool: 'browser',
      arguments: { action: 'click', target: '#submit' },
    });
    expect(collapsedHtml).toContain('browser');
    expect(collapsedHtml).toContain('#submit');
    expect(collapsedHtml).not.toMatch(/undefined|null|NaN/);

    const bashHtml = renderApproval({
      conversationId: '10',
      key: '47',
      tool: 'bash',
      arguments: { command: 'ls -la' },
    });
    expect(bashHtml).toContain('ls -la');
    expect(bashHtml).toContain('Allow similar…');
  });
});
