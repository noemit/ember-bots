import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { freezeDraftAppearance, previewDraftAppearance } from '../../lib/draftAppearance';
import { INSTRUCTION_PRESETS, presetFor, type InstructionPreset } from '../../lib/instructionPresets';
import type { AvatarIdentity, BlobStyle, DraftAppearance, Instance } from '../../types';

const AvatarPicker = React.lazy(() => import('../AvatarPicker'));

export function AnnotationDecisionDialog({
  open,
  busy,
  reason,
  error,
  sourceValid,
  onSettle,
  onDiscard,
  onSave,
}: {
  open: boolean;
  busy: boolean;
  reason: string | null;
  error: string | null;
  sourceValid: boolean;
  onSettle: (allowed: boolean) => void;
  onDiscard: () => void;
  onSave: () => Promise<boolean>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onSettle(false);
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-annotation-decision=""
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!busy) onSettle(false);
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Save this annotation for later?</DialogTitle>
          <DialogDescription>
            {reason ??
              'Save keeps your text and its quoted passage in this chat’s For later tray. Escape returns to the editor.'}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
          <Button
            type="button"
            disabled={busy || !sourceValid || Boolean(reason)}
            onClick={async () => {
              const saved = await onSave();
              if (saved) onSettle(true);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PresetPreviewDialog({
  preset,
  onClose,
  onPick,
}: {
  preset: InstructionPreset | null;
  onClose: () => void;
  onPick: (preset: InstructionPreset) => void;
}) {
  return (
    <Dialog
      open={preset !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{preset?.name ?? 'Prompt'}</DialogTitle>
          <DialogDescription>
            {preset?.note ?? 'Exactly what this session is told, before anything you type.'}
          </DialogDescription>
        </DialogHeader>
        {preset?.instructions ? (
          <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
            {preset.instructions}
          </pre>
        ) : null}
        <DialogFooter>
          <Button
            disabled={!preset}
            onClick={() => {
              if (preset) onPick(preset);
              onClose();
            }}
          >
            Use this
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DraftAppearanceDialog({
  draftInstance,
  draftPickerBase,
  open,
  onOpenChange,
  blobStyle,
  theme,
  draftAppearance,
  onDraftAppearanceChange,
}: {
  draftInstance: Instance | null;
  draftPickerBase: AvatarIdentity | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blobStyle: BlobStyle;
  theme: string;
  draftAppearance?: DraftAppearance | null;
  onDraftAppearanceChange?: (appearance: DraftAppearance | null) => void;
}) {
  if (!draftInstance || !draftPickerBase || !onDraftAppearanceChange) return null;
  return (
    <React.Suspense fallback={null}>
      <AvatarPicker
        open={open}
        onOpenChange={onOpenChange}
        title="New bot"
        style={blobStyle}
        theme={theme}
        identity={draftPickerBase}
        scopes={[{ key: 'new-bot', label: 'This new bot', kind: 'session' }]}
        overrides={draftAppearance ? { 'new-bot': draftAppearance.override } : {}}
        resolvePreview={(_scope, override) => previewDraftAppearance(draftPickerBase, override)}
        onSave={(_scope, override, preview) => {
          onDraftAppearanceChange(override ? freezeDraftAppearance(preview, blobStyle) : null);
          onOpenChange(false);
        }}
      />
    </React.Suspense>
  );
}

export function StandingInstructionsDialog({
  open,
  onOpenChange,
  draftInstanceId,
  instructionsDraft,
  setInstructionsDraft,
  setInstructions,
  editingCustomInstructions,
  setEditingCustomInstructions,
  instructionsTextRef,
  instructionsLoading,
  editorWorkerModelError,
  editInstructions,
  pickInstructions,
  workerModelControls,
  saveInstructions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftInstanceId: string | null;
  instructionsDraft: string;
  setInstructionsDraft: (value: string) => void;
  setInstructions: (value: string) => void;
  editingCustomInstructions: boolean;
  setEditingCustomInstructions: (value: boolean) => void;
  instructionsTextRef: React.RefObject<HTMLTextAreaElement | null>;
  instructionsLoading: boolean;
  editorWorkerModelError: string | null;
  editInstructions: () => void;
  pickInstructions: (preset: InstructionPreset, editor: boolean) => void;
  workerModelControls: (value: string, editor: boolean) => React.ReactNode;
  saveInstructions: (text?: string) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Standing instructions</DialogTitle>
          <DialogDescription>
            {draftInstanceId
              ? "What this bot is for. It becomes part of the session's own prompt, before anything you type — not a first message."
              : "What this bot is for. Saved to the session itself and applied from its next turn — not sent as a message."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            {INSTRUCTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-label={preset.name}
                onClick={() => pickInstructions(preset, true)}
                className={cn(
                  'rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-muted/60',
                  !editingCustomInstructions &&
                    presetFor(instructionsDraft)?.id === preset.id &&
                    'border-ring bg-muted/40'
                )}
              >
                <span className="block text-xs font-medium">{preset.name}</span>
                <span className="block text-[11px] text-muted-foreground">{preset.blurb}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                editInstructions();
                setEditingCustomInstructions(true);
                instructionsTextRef.current?.focus();
              }}
              className={cn(
                'rounded-md border px-2.5 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/60',
                editingCustomInstructions && 'border-ring bg-muted/40'
              )}
            >
              Custom (type your own)
            </button>
          </div>
          {!editingCustomInstructions && presetFor(instructionsDraft)?.id === 'delegator'
            ? workerModelControls(instructionsDraft, true)
            : null}
          {instructionsLoading ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Reading this session's current prompt…
            </span>
          ) : null}
          <Textarea
            ref={instructionsTextRef}
            value={instructionsDraft}
            onChange={(event) => {
              editInstructions();
              setInstructionsDraft(event.target.value);
              setEditingCustomInstructions(true);
            }}
            placeholder="Or write your own — leave empty for none."
            aria-label="Standing instructions text"
            className="min-h-32 text-xs"
          />
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            disabled={instructionsLoading}
            onClick={() => {
              setInstructionsDraft('');
              if (draftInstanceId) setInstructions('');
              else void saveInstructions('');
            }}
          >
            Clear
          </Button>
          <Button disabled={instructionsLoading || Boolean(editorWorkerModelError)} onClick={() => void saveInstructions()}>
            {draftInstanceId ? 'Use these' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
