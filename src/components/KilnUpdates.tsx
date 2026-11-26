import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BUNDLED_KILN_VERSION, kilnUpdateState, type KilnUpdateState } from '../lib/kilnUpdateNotice';
import type { Instance } from '../types';

type Props = {
  instances: readonly Instance[];
  onRefreshInstances?: (purpose: 'versions') => void;
};

function statusLabel(state: Exclude<KilnUpdateState, 'not-applicable'>, connection: Instance['status']): string {
  switch (state) {
    case 'older': return 'Update recommended';
    case 'equal': return 'Matches the included Kiln';
    case 'newer': return 'Newer than the included Kiln';
    case 'unknown': return 'Ember couldn’t compare versions. Check the version on this host.';
    case 'unavailable': return connection === 'checking' ? 'Checking connection…' : 'Version unavailable. Check this host’s connection.';
  }
}

/** Read the same instance snapshot as the toolbar; only an explicit refresh reprobes the hosts. */
export default function KilnUpdates({ instances, onRefreshInstances }: Props) {
  const hosts = instances.flatMap((instance) => {
    const state = kilnUpdateState(instance);
    return state === 'not-applicable' ? [] : [{ instance, state }];
  });

  return (
    <section aria-label="Kiln updates" className="space-y-3 rounded-lg border p-5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Kiln updates</h3>
        {hosts.length > 0 && onRefreshInstances ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onRefreshInstances('versions')}>
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Refresh versions
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground">
        This Ember includes Kiln {BUNDLED_KILN_VERSION}. The versions below come from the hosts, not an online update
        check. Ember compares them with the included version, not a minimum requirement. It won’t install updates
        on these hosts or restart their Kilns.
      </p>
      {hosts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No other Kilns to compare. The included Kiln updates with Ember.</p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Kiln versions by host">
          {hosts.map(({ instance, state }) => (
            <li key={instance.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <div className="wrap-anywhere font-medium">{instance.label || instance.id}</div>
                {state !== 'unavailable' && instance.version ? (
                  <div className="truncate text-xs text-muted-foreground" title={instance.version}>Reported: {instance.version}</div>
                ) : null}
              </div>
              <span className={state === 'older' ? 'text-xs font-medium' : 'text-xs text-muted-foreground'}>
                {statusLabel(state, instance.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hosts.some(({ state }) => state === 'older') ? (
        <div className="space-y-1 rounded-md bg-muted/40 p-3 text-xs">
          <h4 className="font-medium">How to update an older Kiln</h4>
          <p className="text-muted-foreground">
            Let active chats and tasks finish first. On that host, use its usual update method:
            update its Ember app or standalone Tinder, or redeploy its container with the updated image.
            Keep the existing Kiln data directory or volume.
          </p>
          <p className="text-muted-foreground">
            Once the host reconnects, {onRefreshInstances ? 'choose Refresh versions here.' : 'choose Reprobe instances in the Instances menu.'}
          </p>
        </div>
      ) : null}
    </section>
  );
}
