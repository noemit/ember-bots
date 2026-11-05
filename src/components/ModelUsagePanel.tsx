import * as React from 'react';
import { ChartColumn } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { retryModelStats, summarizeUsage, useModelStats, type ModelUsage } from '@/lib/modelStats';
import type { ModelList } from '../api';
import { modelRefKey, type Instance } from '../types';

type Props = {
  instances: Instance[];
  modelsByInstance: Record<string, ModelList>;
};

const ALL = '__all';
const RANGES = [7, 30, 90];

const seconds = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);
const rate = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value)} tok/s`);
const cost = (usage: ModelUsage) =>
  usage.costSamples ? `$${usage.totalCost.toFixed(usage.totalCost < 1 ? 3 : 2)}` : '—';

/**
 * What every model Ember has seen reply to, across all instances: calls, median time, throughput,
 * provider-reported cost, and which reasoning levels were asked for.
 *
 * A panel, not a dialog: it is the **Usage** tab's content, and the same component would serve a
 * dialog if one is ever wanted again.
 */
export default function ModelUsagePanel({ instances, modelsByInstance }: Props) {
  const { records, error } = useModelStats();
  const [instanceId, setInstanceId] = React.useState(ALL);
  const [days, setDays] = React.useState(30);

  const usage = React.useMemo(
    () => summarizeUsage(records, { days, instanceId: instanceId === ALL ? undefined : instanceId }),
    [records, days, instanceId]
  );
  const catalogue = React.useMemo(() => {
    const map = new Map<string, { label: string; provider: string }>();
    Object.values(modelsByInstance).forEach((list) =>
      list.models.forEach((model) => {
        map.set(modelRefKey(model), {
          label: model.details.name || model.label,
          provider: model.details.providerName,
        });
      })
    );
    return map;
  }, [modelsByInstance]);
  const instanceLabels = React.useMemo(
    () => new Map(instances.map((instance) => [instance.id, instance.label])),
    [instances]
  );
  const total = usage.reduce((sum, entry) => sum + entry.count, 0);
  const totalCost = usage.reduce((sum, entry) => sum + entry.totalCost, 0);

  return (
    <section
      data-testid="usage-panel"
      className="flex min-h-0 w-full flex-1 flex-col gap-3"
      aria-label="Model usage"
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[14px] font-semibold tracking-wide text-highlight">Usage</h1>
        <p className="text-[12px] text-muted-foreground">
          Every model Ember has seen reply, across your instances.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={instanceId} onValueChange={setInstanceId}>
          <SelectTrigger size="sm" className="w-[170px] text-xs" aria-label="Instance">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All instances</SelectItem>
            {instances.map((instance) => (
              <SelectItem key={instance.id} value={instance.id}>
                {instance.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
          <SelectTrigger size="sm" className="w-[130px] text-xs" aria-label="Date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((range) => (
              <SelectItem key={range} value={String(range)}>
                Last {range} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {total} calls · {usage.length} models{totalCost > 0 ? ` · $${totalCost.toFixed(2)} reported` : ''}
        </span>
      </div>

      {error ? (
        <div role="alert" className="text-xs text-destructive">
          {error}{' '}
          <button type="button" onClick={() => void retryModelStats()} className="underline">
            Retry
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {usage.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-muted-foreground">
            <ChartColumn className="size-5" />
            No model calls observed in this range.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {usage.map((entry) => {
              const key = modelRefKey(entry);
              const known = catalogue.get(key);
              const share = total ? entry.count / total : 0;
              return (
                <li key={key} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium" title={key}>
                      {known?.label ?? entry.modelID}
                    </span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {known?.provider ?? entry.providerID}
                    </span>
                    <span className="ml-auto flex-none text-[11px] tabular-nums text-muted-foreground">
                      {entry.count} · {Math.round(share * 100)}%
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-highlight"
                      style={{ width: `${Math.max(share * 100, 1)}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground">
                    <span>median {seconds(entry.duration)}</span>
                    <span>{rate(entry.rate)}</span>
                    <span>{cost(entry)}</span>
                    {entry.errors ? <span className="text-destructive">{entry.errors} errors</span> : null}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {entry.variants.map(([variant, count]) => `${variant || 'default'} ${count}`).join(' · ')}
                    {instanceId === ALL
                      ? ` — ${entry.instances
                          .map(([id, count]) => `${instanceLabels.get(id) ?? id} ${count}`)
                          .join(' · ')}`
                      : ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Only sessions Ember has loaded are counted. Calls are single model turns, not whole tasks;
        cost is what providers reported.
      </p>
    </section>
  );
}
