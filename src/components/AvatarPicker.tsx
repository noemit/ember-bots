import * as React from 'react';
import Blob from '../blob/Blob';
import { IDENTITY_COLORS, identityPaletteFor } from '../blob/contrast';
import { themeById } from '../themes';
import { CRYSTAL_SHAPES } from '../blob/crystal';
import { BUDDY_SHAPES } from '../blob/buddy';
import { ACTIVE_BLOB_STYLES, effectiveBlobStyle, type ActiveBlobStyle } from '../blob/styles';
import { MOSAIC_SHAPES } from '../blob/mosaic';
import { LAVA_SHAPES } from '../blob/lava';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AvatarIdentity, AvatarOverride, BlobStyle } from '../types';

type Scope = { key: string; label: string; kind: 'project' | 'task' | 'session' };

type Props = {
  open: boolean;
  title: string;
  style: BlobStyle;
  theme: string;
  allowStyleChoice?: boolean;
  resolvePreview: (scopeKey: string, override: AvatarOverride) => AvatarIdentity;
  identity: AvatarIdentity;
  scopes: Scope[];
  overrides: Record<string, AvatarOverride>;
  onSave: (scopeKey: string, override: AvatarOverride | null, preview: AvatarIdentity) => void;
  onOpenChange: (open: boolean) => void;
};

const COLOR_COUNT = IDENTITY_COLORS.length;

const shapesForStyle = (style: ActiveBlobStyle): string[] => {
  const shapes = style === 'crystal' ? CRYSTAL_SHAPES
    : style === 'buddy' ? BUDDY_SHAPES
      : style === 'lava' ? LAVA_SHAPES : MOSAIC_SHAPES;
  return shapes.map((shape) => shape.name);
};

/** A style choice belongs to this override, never the global appearance preference. */
export function pickerStyleDraft(draft: AvatarOverride, style: ActiveBlobStyle, currentShapeName?: string): AvatarOverride {
  const next = { ...draft, style };
  const shapeName = draft.shapeName ?? currentShapeName;
  // Mask the frozen preview base too: deleting this field would inherit its old shape again.
  if (shapeName !== undefined) next.shapeName = shapesForStyle(style).includes(shapeName) ? shapeName : 'automatic';
  return next;
}

export default function AvatarPicker({
  open,
  title,
  style: storedStyle,
  theme,
  allowStyleChoice = false,
  resolvePreview,
  identity,
  scopes,
  overrides,
  onSave,
  onOpenChange,
}: Props) {
  const colors = React.useMemo(() => {
    const palette = themeById(theme).palette;
    return identityPaletteFor([palette.panel, palette.elev, palette.bg]);
  }, [theme]);
  const [scopeKey, setScopeKey] = React.useState(scopes[0]?.key ?? '');
  const [draft, setDraft] = React.useState<AvatarOverride>({});

  const firstScopeKey = scopes[0]?.key ?? '';
  const scopeKind = scopes.find((scope) => scope.key === scopeKey)?.kind ?? 'session';
  const scopeSignature = scopes.map((scope) => scope.key).join('\u0000');
  // Read the latest overrides without making them an effect dependency: the settings map gets a
  // fresh reference after any app settings write, which must not wipe an in-progress selection.
  const overridesRef = React.useRef(overrides);
  overridesRef.current = overrides;

  React.useEffect(() => {
    if (open) setScopeKey(firstScopeKey);
  }, [open, identity.sessionKey, firstScopeKey, scopeSignature]);

  React.useEffect(() => {
    if (open && scopeKey) setDraft({ ...(overridesRef.current[scopeKey] ?? {}) });
  }, [open, scopeKey]);

  const previewIdentity = (patch: AvatarOverride): AvatarIdentity =>
    resolvePreview(scopeKey, { ...draft, ...patch });
  const preview = previewIdentity({});
  const style = effectiveBlobStyle(storedStyle, preview);
  const shapes = shapesForStyle(style);
  const previewColor = preview.color ?? colors[preview.colorIndex ?? 0];
  const chosenColor = draft.color ?? (draft.colorIndex !== undefined ? colors[draft.colorIndex] : previewColor);
  const colorOverridden = scopeKind !== 'session' && chosenColor !== previewColor;
  const hasOverride = draft.style !== undefined || draft.color !== undefined || draft.colorIndex !== undefined || draft.shapeName !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[500px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-h-[86vh] sm:max-w-[500px]">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle>Customize appearance</DialogTitle>
          <DialogDescription className="truncate">{title}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 touch-pan-y flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-medium">Apply to</span>
              <Select value={scopeKey} onValueChange={setScopeKey}>
                <SelectTrigger size="sm" className="w-[min(220px,58vw)]" aria-label="Appearance scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((scope) => (
                    <SelectItem key={scope.key} value={scope.key}>{scope.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {allowStyleChoice
                ? 'Only this new bot uses these choices. Existing bots won’t change.'
                : scopeKind === 'project'
                ? 'Shared by every session in this project or folder.'
                : scopeKind === 'task'
                  ? 'Used only by this scheduled task.'
                  : 'Used only by this session.'}
            </span>
          </div>

          <div className="flex items-center gap-4 rounded-xl border bg-muted/30 p-4">
            <Blob
              style={style}
              seed={identity.sessionKey}
              identity={preview}
              size={56}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">Preview</span>
              <span className="text-xs text-muted-foreground">
                Color and shape help you recognize this chat wherever it appears.
              </span>
              {colorOverridden ? (
                <span className="text-xs text-muted-foreground">
                  This chat uses a separate colour. Choose This session to change it here.
                </span>
              ) : null}
            </div>
          </div>

          {allowStyleChoice ? (
            <div role="group" aria-label="Bot style" className="flex flex-col gap-2">
              <span className="text-xs font-medium">Bot style</span>
              <div className="grid grid-cols-4 gap-2">
                {ACTIVE_BLOB_STYLES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={style === option}
                    onClick={() => setDraft((prev) => pickerStyleDraft(prev, option, preview.shapeName))}
                    className={cn(
                      'min-h-10 rounded-lg border text-xs transition-colors hover:bg-muted',
                      style === option && 'border-highlight bg-muted ring-2 ring-highlight/30'
                    )}
                  >
                    {option[0].toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <section className="flex flex-col gap-2">
            <span className="text-xs font-medium">Color</span>
            <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              Custom color
              <input type="color" aria-label="Custom bot color" value={chosenColor} onChange={(event) => setDraft((prev) => ({ ...prev, color: event.target.value, colorIndex: undefined }))} className="h-8 w-12 cursor-pointer rounded border bg-transparent" />
            </label>
            <div className="grid grid-cols-6 gap-2">
              {Array.from({ length: COLOR_COUNT }, (_, colorIndex) => {
                const selected = !draft.color && draft.colorIndex === colorIndex;
                const color = colors[colorIndex];
                return (
                  <button
                    key={colorIndex}
                    type="button"
                    title={`Color ${colorIndex + 1}`}
                    aria-label={`Color ${colorIndex + 1}`}
                    aria-pressed={selected}
                    onClick={() => setDraft((prev) => ({ ...prev, colorIndex, color: undefined }))}
                    className={cn(
                      'flex h-10 items-center justify-center rounded-lg border transition-colors hover:bg-muted',
                      selected && 'border-highlight ring-2 ring-highlight/30'
                    )}
                  >
                    <span className="size-5 rounded-full" style={{ backgroundColor: color }} />
                  </button>
                );
              })}
            </div>
          </section>

          {shapes.length > 0 ? (
            <section className="flex flex-col gap-2">
              <span className="text-xs font-medium">Shape</span>
              <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-7">
                {shapes.map((shapeName) => {
                  const selected = draft.shapeName === shapeName;
                  return (
                    <button
                      key={shapeName}
                      type="button"
                      title={shapeName}
                      aria-label={shapeName}
                      aria-pressed={selected}
                      onClick={() => setDraft((prev) => ({ ...prev, shapeName }))}
                      className={cn(
                        'flex aspect-square items-center justify-center rounded-lg border transition-colors hover:bg-muted',
                        selected && 'border-highlight bg-muted ring-2 ring-highlight/30'
                      )}
                    >
                      <Blob
                        style={style}
                        seed={identity.sessionKey}
                        identity={previewIdentity({ shapeName })}
                        size={30}
                      />
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button
            variant="outline"
            disabled={!overrides[scopeKey]}
            onClick={() => {
              onSave(scopeKey, null, resolvePreview(scopeKey, {}));
              onOpenChange(false);
            }}
          >
            Reset
          </Button>
          <Button
            disabled={!scopeKey || !hasOverride}
            onClick={() => {
              onSave(scopeKey, draft, preview);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
