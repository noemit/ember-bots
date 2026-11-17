import type { ThinkingSide } from './mosaicThinkingPlan';

export type MosaicProfile = {
  algorithm: 'independent-trails-v2'; mode: 'tuned'; beatMs: number;
  hold: { min: number; max: number }; appearance: { min: number; max: number };
  cycleSeconds: number; pairChance: number; sides: readonly ThinkingSide[]; touchChance: number;
  opacity: { min: number; max: number };
  rainbow: { enabled: boolean; cycle: { min: number; max: number }; passSeconds: number;
    peakOpacity: number; staggerSeconds: number; direction: 'seeded'; phase: number };
  units: { readonly [key: string]: string };
  constraints: { maxBirthCells: 2; birthPairs: 'opposite-only'; minimumBirthIntervalBeats: 1;
    trailBudget: 64; distanceCells: readonly [1, 2]; outsideBody: true; insideCanvas: true;
    avoidActiveCoordinateReuse: false };
};
const common = {
  algorithm: 'independent-trails-v2', mode: 'tuned', beatMs: 100,
  appearance: { min: 1, max: 1 }, cycleSeconds: 40,
  sides: ['left', 'right', 'top', 'bottom'], opacity: { min: .1, max: 1 },
  units: { beatMs: 'milliseconds', hold: 'beats', appearance: 'beats between births',
    cycleSeconds: 'seconds (target; rounded up to next birth)', rainbowCycle: 'seconds',
    rainbowPass: 'seconds', rainbowStagger: 'seconds', rainbowPhase: 'fraction', opacity: 'fraction', probability: 'fraction' },
  constraints: { maxBirthCells: 2, birthPairs: 'opposite-only', minimumBirthIntervalBeats: 1,
    trailBudget: 64, distanceCells: [1, 2], outsideBody: true, insideCanvas: true,
    avoidActiveCoordinateReuse: false },
} as const;
const rainbow = { cycle: { min: 2, max: 15 }, passSeconds: 1.6, peakOpacity: .7,
  staggerSeconds: .1, direction: 'seeded', phase: 0 } as const;
/** Approved v3 profiles. Preview theme/seed/activeMood are deliberately not production defaults. */
export const MOSAIC_PROFILES = {
  thinking: { ...common, hold: { min: 1, max: 18 }, pairChance: .45, touchChance: .95,
    rainbow: { ...rainbow, enabled: true } },
  busy: { ...common, hold: { min: 3, max: 3 }, pairChance: .44, touchChance: 0,
    rainbow: { ...rainbow, enabled: false } },
} as const satisfies Record<'thinking' | 'busy', MosaicProfile>;
