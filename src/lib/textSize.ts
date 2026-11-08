/** The three named sizes every text setting offers. */
export const TEXT_SIZES = ['small', 'medium', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const isTextSize = (value: unknown): value is TextSize =>
  typeof value === 'string' && (TEXT_SIZES as readonly string[]).includes(value);

export const textSizeLabel = (size: TextSize): string =>
  size === 'small' ? 'Small' : size === 'large' ? 'Large' : 'Medium';

/** Conversation prose, in CSS pixels — the numeric setting the reader already had. */
export const CHAT_PX: Record<TextSize, number> = { small: 13, medium: 14, large: 16 };
/** The composer's textarea, in CSS pixels. Medium is the 18px the composer has always used. */
export const COMPOSER_PX: Record<TextSize, number> = { small: 16, medium: 18, large: 20 };
/**
 * Interface chrome (rail, headers, menus, settings) as a scale factor. Every surface in the app is
 * written in px, so this is applied as a layout zoom rather than a root font-size; a rem-only
 * adjustment would leave most of the chrome unchanged.
 */
export const INTERFACE_SCALE: Record<TextSize, number> = { small: 0.92, medium: 1, large: 1.08 };

/**
 * The named size closest to a stored pixel value, so a reader who picked "15px" before these
 * presets existed keeps the size they actually chose as nearly as the presets allow.
 */
export const nearestChatSize = (px: number | undefined): TextSize => {
  const value = typeof px === 'number' && Number.isFinite(px) ? px : CHAT_PX.medium;
  let best: TextSize = 'medium';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const size of TEXT_SIZES) {
    const distance = Math.abs(CHAT_PX[size] - value);
    // Ties go to the larger preset: a reader who stored 13.5 asked for slightly more, not less.
    if (distance <= bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
};

/** Every size variable the app reads, derived from the three settings. */
export const textSizeVars = (
  input: { chatPx?: number; composer?: TextSize; interface?: TextSize }
): Record<string, string> => ({
  '--conversation-text-size': (input.chatPx ?? CHAT_PX.medium) + 'px',
  '--composer-text-size': COMPOSER_PX[input.composer ?? 'medium'] + 'px',
  '--interface-zoom': String(INTERFACE_SCALE[input.interface ?? 'medium']),
});

/**
 * Apply the sizes to the document. Called from one effect so a settings change and a theme change
 * can never disagree about who owns the root style properties.
 */
export const applyTextSizes = (
  root: HTMLElement,
  input: Parameters<typeof textSizeVars>[0] & { viewport?: { width: number; height: number } }
): void => {
  for (const [name, value] of Object.entries(textSizeVars(input))) root.style.setProperty(name, value);
  // The zoomed body cannot express "one window" in its own units without knowing the window.
  if (input.viewport) {
    root.style.setProperty('--viewport-width', input.viewport.width + 'px');
    root.style.setProperty('--viewport-height', input.viewport.height + 'px');
  }
};

/** The preset a chip/segmented control should show as selected. */
export const composerSizeOf = (value: TextSize | undefined): TextSize => value ?? 'medium';
export const interfaceSizeOf = (value: TextSize | undefined): TextSize => value ?? 'medium';
