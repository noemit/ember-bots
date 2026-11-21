import * as React from 'react';
import {
  delegatorModelsError,
  seedDelegatorChoices,
  type DelegatorChoices,
} from '../../lib/delegatorModels';
import {
  delegatorChoices,
  delegatorInstructions,
  presetFor,
  type InstructionPreset,
} from '../../lib/instructionPresets';
import { sessionKey, type Instance, type ModelOption, type Session } from '../../types';
import DelegatorModelChoices from '../DelegatorModelChoices';

type UseInstructionsEditorArgs = {
  composerKey: string | null;
  loadedComposerKey: string | null;
  session: Session | null;
  instance: Instance | null;
  draftInstanceId: string | null;
  draftInstance: Instance | null;
  instanceLabel?: string;
  modelId: string;
  defaultModelId: string | null;
  models: ModelOption[];
  recentModels: string[];
  delegatorModels?: Record<string, DelegatorChoices>;
  onDelegatorModelsChange?: (instanceId: string, choices: DelegatorChoices) => void;
  onModelsRefresh?: (options?: { upstream?: boolean }) => Promise<unknown> | void;
  onOpenProviders?: (instanceId: string) => void;
  onLoadInstructions?: (session: Session) => Promise<{ supported: boolean; instructions?: string }>;
  onSaveInstructions?: (session: Session, instructions: string | null) => Promise<boolean>;
};

export function useInstructionsEditor({
  composerKey,
  loadedComposerKey,
  session,
  instance,
  draftInstanceId,
  draftInstance,
  instanceLabel,
  modelId,
  defaultModelId,
  models,
  recentModels,
  delegatorModels,
  onDelegatorModelsChange,
  onModelsRefresh,
  onOpenProviders,
  onLoadInstructions,
  onSaveInstructions,
}: UseInstructionsEditorArgs) {
  const [instructions, setInstructions] = React.useState('');
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  const [instructionsDraft, setInstructionsDraft] = React.useState('');
  const [editingCustomInstructions, setEditingCustomInstructions] = React.useState(false);
  const instructionsTextRef = React.useRef<HTMLTextAreaElement>(null);
  const [instructionsByKey, setInstructionsByKey] = React.useState<Record<string, string>>({});
  const [instructionsLoading, setInstructionsLoading] = React.useState(false);
  const instructionsAttempt = React.useRef(0);
  const [previewPreset, setPreviewPreset] = React.useState<InstructionPreset | null>(null);

  React.useLayoutEffect(() => {
    instructionsAttempt.current += 1;
    setInstructionsOpen(false);
    setInstructionsLoading(false);
    return () => {
      instructionsAttempt.current += 1;
    };
  }, [composerKey]);

  const changeInstructionsOpen = (open: boolean) => {
    if (!open) {
      instructionsAttempt.current += 1;
      setInstructionsLoading(false);
    }
    setInstructionsOpen(open);
  };

  const editInstructions = () => {
    instructionsAttempt.current += 1;
    setInstructionsLoading(false);
  };

  const instructionsKey = session ? sessionKey(session) : null;
  const knownInstructions = draftInstanceId
    ? instructions
    : instructionsKey
      ? instructionsByKey[instructionsKey]
      : undefined;
  const instructionsPreset = presetFor(knownInstructions);
  const canEditInstructions = Boolean(
    (draftInstanceId && draftInstance?.kind === 'pi') || (session && !draftInstanceId && instance?.kind === 'pi')
  );

  const instructionInstanceId = draftInstanceId ?? session?.instanceId;
  const previousInstructionInstance = React.useRef(instructionInstanceId);
  React.useEffect(() => {
    if (previousInstructionInstance.current === instructionInstanceId || loadedComposerKey !== composerKey) return;
    previousInstructionInstance.current = instructionInstanceId;
    if (draftInstanceId && presetFor(instructions)?.id === 'delegator') {
      const choices = seedDelegatorChoices(delegatorModels?.[draftInstanceId], modelId, defaultModelId, models);
      setInstructions(delegatorInstructions(choices));
      onDelegatorModelsChange?.(draftInstanceId, choices);
    }
    setInstructionsOpen(false);
  }, [
    instructionInstanceId,
    draftInstanceId,
    instructions,
    delegatorModels,
    modelId,
    defaultModelId,
    models,
    onDelegatorModelsChange,
    loadedComposerKey,
    composerKey,
  ]);

  const seedWorkerModels = () =>
    seedDelegatorChoices(
      instructionInstanceId ? delegatorModels?.[instructionInstanceId] : undefined,
      modelId,
      defaultModelId,
      models
    );

  const rememberWorkerModels = (choices: DelegatorChoices) => {
    if (instructionInstanceId) onDelegatorModelsChange?.(instructionInstanceId, choices);
  };

  const pickInstructions = (preset: InstructionPreset, editor: boolean) => {
    if (editor) editInstructions();
    let next = preset.instructions;
    if (preset.id === 'delegator') {
      const choices = seedWorkerModels();
      next = delegatorInstructions(choices);
      rememberWorkerModels(choices);
    }
    if (editor) {
      setInstructionsDraft(next);
      setEditingCustomInstructions(false);
    } else {
      setInstructions(next);
    }
  };

  const workerModelControls = (value: string, editor: boolean) => (
    <DelegatorModelChoices
      choices={delegatorChoices(value) ?? {}}
      models={models}
      recentModels={recentModels}
      instanceId={instructionInstanceId ?? undefined}
      instanceLabel={draftInstance?.label ?? instanceLabel}
      onRefresh={onModelsRefresh ? () => onModelsRefresh({ upstream: true }) : undefined}
      onAddProviders={
        instructionInstanceId && onOpenProviders ? () => onOpenProviders(instructionInstanceId) : undefined
      }
      onChange={(choices) => {
        if (editor) editInstructions();
        rememberWorkerModels(choices);
        if (editor) setInstructionsDraft(delegatorInstructions(choices));
        else setInstructions(delegatorInstructions(choices));
      }}
    />
  );

  const draftWorkerModelError =
    presetFor(instructions)?.id === 'delegator'
      ? delegatorModelsError(delegatorChoices(instructions) ?? {}, models)
      : null;
  const editorWorkerModelError =
    presetFor(instructionsDraft)?.id === 'delegator'
      ? delegatorModelsError(delegatorChoices(instructionsDraft) ?? {}, models)
      : null;

  const openInstructions = () => {
    setEditingCustomInstructions(!presetFor(knownInstructions));
    setInstructionsOpen(true);
    setInstructionsDraft(knownInstructions ?? '');
    if (draftInstanceId || !session || !onLoadInstructions) return;
    const key = sessionKey(session);
    if (key in instructionsByKey) return;
    setInstructionsLoading(true);
    const attempt = ++instructionsAttempt.current;
    void onLoadInstructions(session)
      .then((result) => {
        if (!result.supported || instructionsAttempt.current !== attempt) return;
        const text = result.instructions ?? '';
        setInstructionsByKey((previous) => ({ ...previous, [key]: text }));
        setInstructionsDraft(text);
        setEditingCustomInstructions(!presetFor(text));
      })
      .catch(() => undefined)
      .finally(() => {
        if (instructionsAttempt.current === attempt) setInstructionsLoading(false);
      });
  };

  const saveInstructions = async (text = instructionsDraft) => {
    if (presetFor(text)?.id === 'delegator' && delegatorModelsError(delegatorChoices(text) ?? {}, models)) return;
    if (draftInstanceId) {
      setInstructions(text);
      setInstructionsOpen(false);
      return;
    }
    if (!session || !onSaveInstructions) {
      setInstructionsOpen(false);
      return;
    }
    const key = sessionKey(session);
    const attempt = instructionsAttempt.current;
    const saved = await onSaveInstructions(session, text || null);
    if (!saved) return;
    setInstructionsByKey((previous) => ({ ...previous, [key]: text }));
    if (instructionsAttempt.current === attempt) setInstructionsOpen(false);
  };

  return {
    instructions,
    setInstructions,
    instructionsOpen,
    changeInstructionsOpen,
    instructionsDraft,
    setInstructionsDraft,
    editingCustomInstructions,
    setEditingCustomInstructions,
    instructionsTextRef,
    instructionsLoading,
    previewPreset,
    setPreviewPreset,
    knownInstructions,
    instructionsPreset,
    canEditInstructions,
    editInstructions,
    pickInstructions,
    workerModelControls,
    draftWorkerModelError,
    editorWorkerModelError,
    openInstructions,
    saveInstructions,
  };
}
