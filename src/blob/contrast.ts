import { IDENTITY_COLORS } from '../../electron/avatarPalette';
export { IDENTITY_COLORS, AVATAR_COLOR_COUNT } from '../../electron/avatarPalette';

/**
 * How far a blob must stand out from the theme surface behind it.
 *
 * This used to be 3 (the WCAG 1.4.11 graphics minimum), which turned out to be the wrong bar: a blob
 * is a large flat disc, not a glyph or a 2px icon, and enforcing text-grade contrast against the
 * background squeezed the palette's lightness range hard enough to collapse colours into each other
 * — the opposite of what the floor was protecting. 1.6 keeps a disc clearly distinct from the
 * surface while leaving the palette room to span light and dark. The *face* contrast is the one that
 * has to stay high, and it is checked separately (`FACE_INK` against every palette colour).
 */
const MIN_CONTRAST = 1.6;

/**
 * Where the palette sits on the lightness axis for a theme: brighter blobs on a dark surface, more
 * mid-toned ones on a light one. Applied as a target band, not a clamp, so a colour's own character
 * survives — a deep red stays deep on a light theme, it just stops being near-black.
 */
const LIGHTNESS_BAND = {
  dark: { min: 0.6, max: 0.82 },
  // Lighter than the mid range alone would give: The avatars paint near-black marks on the disc, and a
  // mid-dark tone on a light surface drops the face below readable contrast. 0.5 keeps the disc
  // visibly tinted against a pale background and still gives the ink room.
  light: { min: 0.5, max: 0.72 },
} as const;
/** Base palette floor: no two identity colours are closer than this in OKLab (≈ just-noticeable). */
export const MIN_IDENTITY_DISTANCE = 0.1;
/** Theme-adjusted floor: contrast correction must not collapse colours into near-duplicates. */
export const MIN_THEME_DISTANCE = 0.05;

type Rgb = [number, number, number];
type Oklab = [number, number, number];
type Oklch = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgbToHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;

const srgbToLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (channel: number): number =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export const contrastRatio = (a: string, b: string): number => {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/*
 * OKLab/OKLCH (Björn Ottosson) gives a roughly perceptually uniform space, so equal steps look
 * like equal colour differences. Colours are chosen and adjusted here rather than in HSL, where
 * hue steps near green and blue are perceptually much smaller than near red and yellow.
 */
const linearToOklab = ([r, g, b]: Rgb): Oklab => {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
};

const oklabToLinear = ([L, a, b]: Oklab): Rgb => {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const oklabToRgb = (lab: Oklab): Rgb => {
  const [r, g, b] = oklabToLinear(lab);
  return [linearToSrgb(r) * 255, linearToSrgb(g) * 255, linearToSrgb(b) * 255];
};

const rgbToOklab = (rgb: Rgb): Oklab =>
  linearToOklab(rgb.map((c) => srgbToLinear(c / 255)) as Rgb);

const oklchToRgb = ([L, chroma, hue]: Oklch): Rgb => {
  const radians = (hue * Math.PI) / 180;
  return oklabToRgb([L, chroma * Math.cos(radians), chroma * Math.sin(radians)]);
};

const rgbToOklch = (rgb: Rgb): Oklch => {
  const [L, a, b] = rgbToOklab(rgb);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};

const inGamut = ([r, g, b]: Rgb): boolean =>
  r >= -0.5 && r <= 255.5 && g >= -0.5 && g <= 255.5 && b >= -0.5 && b <= 255.5;

const oklabDistance = (a: Oklab, b: Oklab): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Perceptual (OKLab) distance between two hex colours; 0.1 is roughly a just-noticeable step. */
export const perceptualDistance = (a: string, b: string): number =>
  oklabDistance(rgbToOklab(hexToRgb(a)), rgbToOklab(hexToRgb(b)));

/** OKLCH hue of a hex colour in degrees [0, 360); IDENTITY_COLORS is sorted by this (rainbow order). */
export const colorHue = (hex: string): number => rgbToOklch(hexToRgb(hex))[2];

/** A hex colour as OKLCH `[lightness, chroma, hue°]`. */
export const hexToOklch = (hex: string): [number, number, number] => rgbToOklch(hexToRgb(hex));

/** OKLCH back to hex, pulling chroma in until the colour fits sRGB rather than clipping a channel. */
export const oklchToHexColor = (lightness: number, chroma: number, hue: number): string =>
  oklchToHex(lightness, chroma, ((hue % 360) + 360) % 360);


export const INSTANCE_MARKER_COLORS = [
  '#3D4EC7', '#A13DB8', '#D13F78', '#C84A3A', '#C66A24', '#9A7A12',
  '#4F8A2F', '#20866F', '#247F9E', '#3474C8', '#6757C2', '#8C4A9E',
];

/** Reduce chroma until the OKLCH triple maps back into sRGB. */
const oklchToHex = (lightness: number, chroma: number, hue: number): string => {
  let current = chroma;
  let rgb = oklchToRgb([lightness, current, hue]);
  for (let step = 0; step < 24 && !inGamut(rgb); step += 1) {
    current *= 0.95;
    rgb = oklchToRgb([lightness, current, hue]);
  }
  return rgbToHex(rgb);
};


const meetsContrast = (hex: string, surfaces: string[]): boolean =>
  surfaces.every((surface) => contrastRatio(hex, surface) >= MIN_CONTRAST);

/**
 * The extreme OKLCH lightness at which a colour still clears MIN_CONTRAST against every surface:
 * the largest safe lightness on a light theme, the smallest safe lightness on a dark theme. Hue and
 * chroma are held so the adjustment stays recognisably the same colour.
 */
const contrastBoundary = (hex: string, surfaces: string[]): number => {
  const dark = luminance(hexToRgb(surfaces[0])) < 0.35;
  const [, chroma, hue] = rgbToOklch(hexToRgb(hex));
  const safeEdge = dark ? 1 : 0;
  const unsafeEdge = dark ? 0 : 1;
  if (!meetsContrast(oklchToHex(safeEdge, chroma, hue), surfaces)) return safeEdge;
  if (meetsContrast(oklchToHex(unsafeEdge, chroma, hue), surfaces)) return unsafeEdge;
  let safe = safeEdge;
  let unsafe = unsafeEdge;
  for (let step = 0; step < 40; step += 1) {
    const mid = (safe + unsafe) / 2;
    if (meetsContrast(oklchToHex(mid, chroma, hue), surfaces)) safe = mid;
    else unsafe = mid;
  }
  return safe;
};

/**
 * Nudge a single colour's lightness — away from the surfaces it sits on — until it clears
 * MIN_CONTRAST against every one of them. Prefer {@link adjustPaletteForContrast} when adjusting a
 * whole palette: this per-colour clamp can push distinct colours onto the same lightness.
 */
export const ensureContrast = (hex: string, surfaces: string[]): string => {
  if (meetsContrast(hex, surfaces)) return hex;
  const [, chroma, hue] = rgbToOklch(hexToRgb(hex));
  return oklchToHex(contrastBoundary(hex, surfaces), chroma, hue);
};

/**
 * Adjust a whole palette for the theme's surfaces without collapsing its colours together.
 *
 * A per-colour clamp moves each entry only as far as it must, so entries with the same hue end up
 * pinned to the same boundary and read as duplicates. Instead this clamps every entry into its own
 * feasible lightness interval, then repeatedly pushes the closest pair apart along lightness —
 * splitting the required gap by the room each colour has — until the palette clears
 * {@link MIN_THEME_DISTANCE} or no further separation is possible.
 */
export const adjustPaletteForContrast = (colors: string[], surfaces: string[]): string[] => {
  const dark = luminance(hexToRgb(surfaces[0])) < 0.35;
  const oklch = colors.map((color) => rgbToOklch(hexToRgb(color)));
  const boundaries = colors.map((color) => contrastBoundary(color, surfaces));

  // Dark surfaces require lightness above the boundary, light surfaces below it.
  const lower = oklch.map(([lightness], index) =>
    dark ? Math.max(lightness, boundaries[index]) : 0.02
  );
  const upper = oklch.map(([lightness], index) =>
    dark ? 0.98 : Math.min(lightness, boundaries[index])
  );
  const band = dark ? LIGHTNESS_BAND.dark : LIGHTNESS_BAND.light;
  const lightness = oklch.map(([value], index) => {
    const clamped = Math.max(lower[index], Math.min(upper[index], value));
    // Nudge into the theme's band, so dark themes read as bright discs and light themes as
    // mid-toned ones, while a colour already inside the band is left exactly as sampled.
    return Math.max(band.min, Math.min(band.max, clamped));
  });

  const labAt = (index: number): Oklab =>
    rgbToOklab(hexToRgb(oklchToHex(lightness[index], oklch[index][1], oklch[index][2])));
  const labs = colors.map((_, index) => labAt(index));
  // Aim past the floor so rounding to hex still leaves the palette comfortably above it.
  const target = MIN_THEME_DISTANCE + 0.01;

  for (let iteration = 0; iteration < 400; iteration += 1) {
    let first = 0;
    let second = 1;
    let closest = Infinity;
    for (let i = 0; i < labs.length; i += 1) {
      for (let j = i + 1; j < labs.length; j += 1) {
        const distance = oklabDistance(labs[i], labs[j]);
        if (distance < closest) {
          closest = distance;
          first = i;
          second = j;
        }
      }
    }
    if (closest >= target) break;

    if (lightness[first] > lightness[second]) {
      const swap = first;
      first = second;
      second = swap;
    }
    const need = target - closest + 0.005;
    const firstRoom = lightness[first] - lower[first];
    const secondRoom = upper[second] - lightness[second];
    const room = firstRoom + secondRoom;
    if (room <= 1e-6) break;
    lightness[first] -= Math.min(firstRoom, (need * firstRoom) / room);
    lightness[second] += Math.min(secondRoom, (need * secondRoom) / room);
    labs[first] = labAt(first);
    labs[second] = labAt(second);
  }

  return colors.map((_, index) =>
    oklchToHex(lightness[index], oklch[index][1], oklch[index][2])
  );
};

/**
 * The palette adjusted for a theme, then corrected so the *face* always reads.
 *
 * Background contrast was deliberately relaxed to 1.6 — a blob is a big flat disc, not a glyph — but
 * that relaxation must not be paid for by the marks drawn on top of it. The avatars paint near-black marks
 * onto the disc, so every entry is nudged lighter until it clears {@link MIN_FACE_CONTRAST} against
 * that ink. Lightening (never darkening) is the right direction: the disc must stay distinct from a
 * light surface, and a dark mark on a light-toned disc is the combination the reference sheet uses.
 */
export const MIN_FACE_CONTRAST = 3;

const lightenForInk = (hex: string, ink: string, minimum: number): string => {
  if (contrastRatio(hex, ink) >= minimum) return hex;
  const [lightness, chroma, hue] = rgbToOklch(hexToRgb(hex));
  for (let step = 1; step <= 30; step += 1) {
    const candidate = oklchToHex(Math.min(0.97, lightness + step * 0.015), chroma, hue);
    if (contrastRatio(candidate, ink) >= minimum) return candidate;
  }
  return oklchToHex(0.97, chroma, hue);
};

/** Shared face ink, kept here so the palette can be checked against it. */
export const FACE_INK = '#16130f';

/** Theme-adjusted blob palette, index-aligned with IDENTITY_COLORS. */
export const identityPaletteFor = (surfaces: string[]): string[] =>
  adjustPaletteForContrast(IDENTITY_COLORS, surfaces).map((color) =>
    lightenForInk(color, FACE_INK, MIN_FACE_CONTRAST)
  );

export const instanceMarkerPaletteFor = (surfaces: string[]): string[] =>
  adjustPaletteForContrast(INSTANCE_MARKER_COLORS, surfaces);
