import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../src/components/ui/tooltip';
import SessionRow from '../src/components/SessionRow';
import ProjectCard from '../src/components/ProjectCard';
import type { Project, Session } from '../src/types';

const session: Session = {
  id: 'ses_1',
  instanceId: 'pi:tower',
  title: 'Refactor queue reorder',
  directory: '/workspace/ember-bots',
  created: 1_700_000_000_000,
  updated: 1_700_000_100_000,
};

const project: Project = {
  id: 'proj_1',
  name: 'ember-bots',
  path: '/workspace/ember-bots',
};

const noop = () => {};

describe('rail item hover overlay and hidden box label', () => {
  test('SessionRow omits top headroom padding, hides visible box text, keeps tooltip and markerColor', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionRow
          session={session}
          instanceLabel="Tower"
          projectName="ember-bots"
          preview="Checked the reorder transaction"
          selected={false}
          visibleColumn={false}
          mood="idle"
          reloading={false}
          archiving={false}
          markerColor={3}
          blobStyle="soft"
          onSelect={noop}
          onReload={noop}
          onArchive={noop}
          onCustomizeAppearance={noop}
        />
      </TooltipProvider>,
    );

    expect(html).not.toContain('pt-[30px]');
    expect(html).not.toMatch(/>\s*Tower\s*</);
    expect(html).toContain('title="Refactor queue reorder · /workspace/ember-bots · Tower"');
    expect(html).toContain('data-instance-marker="3"');
    expect(html).toContain('[@media(pointer:coarse)]:hidden');
    expect(html).toContain('[@media(hover:none)]:hidden');
  });

  test('ProjectCard hides visible box text while preserving tooltip and markerColor', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ProjectCard
          project={project}
          instanceId="pi:tower"
          instanceLabel="Tower"
          markerColor={5}
          sessions={[session]}
          moods={{ 'pi:tower::ses_1': 'idle' }}
          visibleKeys={new Set()}
          avatarIdentities={{}}
          blobStyle="soft"
          reloadingKeys={new Set()}
          archivingKeys={new Set()}
          onOpenProject={noop}
          onOpenSession={noop}
          onNewAgent={noop}
          onReload={noop}
          onArchive={noop}
          onArchiveMany={noop}
          onCustomizeAppearance={noop}
        />
      </TooltipProvider>,
    );

    expect(html).not.toMatch(/>\s*Tower\s*</);
    expect(html).toContain('title="ember-bots · /workspace/ember-bots · Tower"');
    expect(html).toContain('data-instance-marker="5"');
  });
});
