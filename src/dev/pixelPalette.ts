/**
 * The drawing palette: seven hues plus black and white, and two relatives of each.
 *
 * Every row works the same way, so the matrix reads as a colour system rather than a heap of
 * swatches: **base**, a **darker** version, and a **desaturated** version. For black and white the
 * two relatives are extra greys instead, since "darker" and "desaturated" mean nothing at the ends of
 * the lightness range.
 *
 * The relatives are computed in OKLCH, not RGB. Darkening in RGB drops a hue into mud unevenly —
 * a yellow goes brown while a blue barely moves — whereas holding the hue angle and cutting lightness
 * keeps each column recognisably the same colour, which is what makes a drawing hang together.
 */

/** One matrix row: a base colour and its two relatives, all as `#rrggbb`. */
export type PaletteRow = {
  /** What a person reads in the label. */
  name: string;
  /** `[base, darker, desaturated]` — the swatch strip under the name. */
  swatches: [string, string, string];
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** `#rrggbb` → `[r, g, b]` in 0–1. Tolerates a leading `#` or not, and 3-digit shorthand. */
const toRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = Number.parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const toHex = ([r, g, b]: [number, number, number]): string =>
  '#' + [r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');

/** sRGB byte → linear light, the transfer function OKLCH is defined against. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB → OKLab (Björn Ottosson's matrices), then the polar form. */
const toOklch = (hex: string): { l: number; c: number; h: number } => {
  const [r, g, b] = toRgb(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
};

/** OKLCH → sRGB, clamped into gamut by chroma reduction where the naive conversion overshoots. */
const fromOklch = ({ l, c, h }: { l: number; c: number; h: number }): string => {
  const rad = (h * Math.PI) / 180;
  for (let chroma = c; chroma >= 0; chroma -= 0.01) {
    const A = Math.cos(rad) * chroma;
    const B = Math.sin(rad) * chroma;
    const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb: [number, number, number] = [
      fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
      fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
      fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    ];
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return toHex(rgb);
  }
  // Fully desaturated: the achromatic case, which always fits.
  return toHex([l, l, l]);
};

/** The same hue, darker — lightness held down, chroma eased so it does not go neon in the dark. */
const darker = (hex: string): string => {
  const { l, c, h } = toOklch(hex);
  return fromOklch({ l: Math.max(0.12, l * 0.62), c: c * 0.92, h });
};

/** The same hue, desaturated — chroma cut, lightness moved only slightly so it still separates. */
const desaturated = (hex: string): string => {
  const { l, c, h } = toOklch(hex);
  return fromOklch({ l: Math.min(0.96, l + 0.05), c: c * 0.34, h });
};

/**
 * The seven hues.
 *
 * Chosen for the things this art actually draws: ink and clothing, skin and plaster, leaf and gold,
 * lipstick and glass. Each is a mid-lightness, mid-chroma colour so its darker relative still reads
 * and its desaturated relative still belongs to the same family.
 */
const HUES: readonly { name: string; base: string }[] = [
  { name: 'Red', base: '#c4384a' },
  { name: 'Orange', base: '#d97a2b' },
  { name: 'Yellow', base: '#e8c35a' },
  { name: 'Green', base: '#3f8f4a' },
  { name: 'Cyan', base: '#2f9fc4' },
  { name: 'Blue', base: '#3d5fa8' },
  { name: 'Violet', base: '#8b4fa8' },
];

/**
 * The matrix, in reading order: black and white first (the two the art uses most), then the hues.
 *
 * Black runs light → dark across its greys so the strip doubles as a ramp; white runs the other way,
 * so the two ends meet in the middle at a mid grey rather than repeating it.
 */
export const PALETTE: readonly PaletteRow[] = [
  { name: 'Black', swatches: ['#14111a', '#2e2a38', '#494455'] },
  { name: 'White', swatches: ['#fffdf5', '#e8e2d4', '#c9c2b6'] },
  ...HUES.map(({ name, base }) => ({
    name,
    swatches: [base, darker(base), desaturated(base)] as [string, string, string],
  })),
];

/** Flat list, for anything that just wants every colour in order. */
export const PALETTE_FLAT: readonly string[] = PALETTE.flatMap((row) => row.swatches);
