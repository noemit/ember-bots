import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { modelRefKey, type ModelOption } from '../types';
import { delegatorModelsError, type DelegatorChoices } from '../lib/delegatorModels';
import { Button } from './ui/button';
import { ModelPickerFallback } from './ModelPickerFallback';
const ModelPicker = React.lazy(() => import('./ModelPicker'));

type Props = {
  choices: DelegatorChoices;
  models: ModelOption[];
  recentModels: string[];
  instanceId?: string;
  instanceLabel?: string;
  onChange: (choices: DelegatorChoices) => void;
  onRefresh?: () => Promise<unknown> | void;
  onAddProviders?: () => void;
};

/** The standard model picker, constrained to concrete identities for worker routing. */
export default function DelegatorModelChoices({ choices, models, recentModels, instanceId, instanceLabel, onChange, onRefresh, onAddProviders }: Props) {
  const [editing, setEditing] = React.useState<'harder' | 'easier' | null>(null);
  const error = delegatorModelsError(choices, models);
  return <div className="flex flex-col gap-2" role="group" aria-label="Ultra Delegator models">
    {(['harder', 'easier'] as const).map(role => {
      const label = role === 'harder' ? 'Harder tasks' : 'Easier tasks';
      const key = choices[role] ? modelRefKey(choices[role]!) : '';
      const model = models.find(model => modelRefKey(model) === key);
      return <div key={role} className="flex items-center justify-between gap-2 text-xs">
        <span>{label}</span>
        <Button variant="outline" size="sm" className="min-w-0 max-w-[70%]" aria-label={label} aria-haspopup="dialog" onClick={() => setEditing(role)}>
          <span className="truncate" title={key}>{model?.details.name ?? (key ? `${key} (unavailable)` : 'Choose model')}</span><ChevronDown className="size-3 shrink-0" />
        </Button>
      </div>;
    })}
    <p className="text-[11px] text-muted-foreground">Remembered on {instanceLabel ?? 'this instance'} for new Ultra Delegator choices.</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {editing ? <React.Suspense fallback={<ModelPickerFallback />}>
      <ModelPicker open instanceId={instanceId} instanceLabel={instanceLabel} models={models} recentModels={recentModels}
        value={choices[editing] ? modelRefKey(choices[editing]!) : ''} requireConcreteModel collapseProviders
        onRefresh={onRefresh} onAddProviders={onAddProviders} onOpenChange={open => { if (!open) setEditing(null); }}
        onSelect={key => {
          const model = models.find(model => modelRefKey(model) === key);
          if (model) onChange({ ...choices, [editing]: { providerID: model.providerID, modelID: model.modelID } });
          setEditing(null);
        }} />
    </React.Suspense> : null}
  </div>;
}
