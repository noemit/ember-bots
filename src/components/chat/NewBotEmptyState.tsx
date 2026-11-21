import * as React from 'react';
import { motion } from 'motion/react';
import { Eye, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import Blob from '../../blob/Blob';
import { INSTRUCTION_PRESETS, type InstructionPreset } from '../../lib/instructionPresets';
import type { AvatarIdentity, BlobStyle, Instance } from '../../types';

export function NewBotEmptyState({
  newSessionInstanceId,
  draftInstance,
  draftIdentity,
  draftDirectory,
  blobStyle,
  canEditInstructions,
  instructions,
  instructionsPreset,
  pickInstructions,
  setPreviewPreset,
  openInstructions,
  workerModelControls,
  onCustomizeAppearance,
}: {
  newSessionInstanceId: string | null;
  draftInstance: Instance | null;
  draftIdentity?: AvatarIdentity;
  draftDirectory: string;
  blobStyle: BlobStyle;
  canEditInstructions: boolean;
  instructions: string;
  instructionsPreset?: InstructionPreset;
  pickInstructions: (preset: InstructionPreset, editor: boolean) => void;
  setPreviewPreset: (preset: InstructionPreset | null) => void;
  openInstructions: () => void;
  workerModelControls: (value: string, editor: boolean) => React.ReactNode;
  onCustomizeAppearance: (identity: AvatarIdentity) => void;
}) {
  return (
    <motion.div
      key={newSessionInstanceId ? `new-${newSessionInstanceId}` : 'empty'}
      className="flex flex-1 flex-col items-center justify-start gap-3 overflow-y-auto py-4 text-muted-foreground sm:justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      {draftInstance ? (
        <>
          <button
            type="button"
            aria-label="Customize new bot appearance"
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
            onClick={() => {
              if (draftIdentity) onCustomizeAppearance(draftIdentity);
            }}
          >
            <Blob style={blobStyle} seed={`new:${draftInstance.id}`} identity={draftIdentity} size={48} interactive />
          </button>
          <div className="flex flex-col items-center gap-1 text-center">
            <span className="text-[13px] font-medium text-foreground">New bot on {draftInstance.label}</span>
            <span className="max-w-[420px] truncate text-xs">
              {draftDirectory.trim() || 'Pick a folder below to get started.'}
            </span>
          </div>
          {canEditInstructions ? (
            <div className="flex w-full max-w-[460px] flex-col gap-2 px-4 text-left">
              <span className="px-0.5 text-[11px] font-medium tracking-wide uppercase text-muted-foreground">
                Standing instructions
              </span>
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Standing instructions">
                {INSTRUCTION_PRESETS.map((preset) => {
                  const selected = instructionsPreset?.id === preset.id;
                  return (
                    <div
                      key={preset.id}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                        selected ? 'border-ring bg-muted/40' : 'border-border/70'
                      )}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-label={preset.name}
                        aria-checked={selected}
                        onClick={() => pickInstructions(preset, false)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'size-3.5 flex-none rounded-full border transition-colors',
                            selected ? 'border-ring bg-highlight/70 ring-2 ring-ring/30' : 'border-muted-foreground/50'
                          )}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-foreground">{preset.name}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{preset.blurb}</span>
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setPreviewPreset(preset)}
                        aria-label={`Read the ${preset.name} prompt`}
                        title={`Read the ${preset.name} prompt`}
                        className="flex-none text-muted-foreground hover:text-foreground"
                      >
                        <Eye className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors',
                    instructionsPreset === undefined && instructions.trim()
                      ? 'border-ring bg-muted/40'
                      : 'border-border/70'
                  )}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={instructionsPreset === undefined && Boolean(instructions.trim())}
                    onClick={openInstructions}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 flex-none rounded-full border transition-colors',
                        instructionsPreset === undefined && instructions.trim()
                          ? 'border-ring bg-highlight/70 ring-2 ring-ring/30'
                          : 'border-muted-foreground/50'
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-foreground">Custom (type your own)</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {instructionsPreset === undefined && instructions.trim()
                          ? 'Your own words — click to edit'
                          : 'Write your own standing instructions'}
                      </span>
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={openInstructions}
                    aria-label="Edit custom standing instructions"
                    title="Edit custom standing instructions"
                    className="flex-none text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </div>
              </div>
              {instructionsPreset?.id === 'delegator' ? workerModelControls(instructions, false) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex -space-x-3">
            <Blob style={blobStyle} seed="empty one" size={48} interactive />
            <Blob style={blobStyle} seed="empty two" size={48} interactive />
            <Blob style={blobStyle} seed="empty three" size={48} interactive />
          </div>
          <span className="text-[13px]">Pick a session, or start a new bot.</span>
        </>
      )}
    </motion.div>
  );
}
