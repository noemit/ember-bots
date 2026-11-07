import { describe, expect, test } from 'bun:test';
import { blobColor } from '../src/blob/color';
import {
  AVATAR_COLOR_COUNT,
  colorHue,
  contrastRatio,
  IDENTITY_COLORS,
  identityPaletteFor,
  instanceMarkerPaletteFor,
  FACE_INK,
  MIN_FACE_CONTRAST,
  MIN_IDENTITY_DISTANCE,
  MIN_THEME_DISTANCE,
  perceptualDistance,
} from '../src/blob/contrast';
import { allocateProjectColors, avatarColorKeys, hashString, mulberry32, resolveAvatarIdentity } from '../src/blob/seed';
import { BUDDY_COLORS } from '../src/blob/buddy';
import { THEMES } from '../src/themes';
import type { Project, Session } from '../src/types';

describe('theme accessibility', () => {
  test('offers only the neutral color options', () => {
    expect(THEMES.map((theme) => theme.name)).toEqual(['Stone', 'Clay', 'Graphite']);
  });

  test('keeps normal and muted text at WCAG AA contrast on every surface', () => {
    for (const theme of THEMES) {
      const { bg, panel, elev, text, dim } = theme.palette;
      for (const surface of [bg, panel, elev]) {
        expect(contrastRatio(text, surface), `${theme.id} text on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(dim, surface), `${theme.id} muted text on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.palette.warning, surface), `${theme.id} warning on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('keeps highlighted and user bubble text at WCAG AA contrast', () => {
    for (const theme of THEMES) {
      expect(
        contrastRatio(theme.palette.highlightText, theme.palette.highlight),
        `${theme.id} highlight text`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.palette.userBubbleText, theme.palette.userBubble),
        `${theme.id} user bubble text`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('theme text tokens', () => {
  /**
   * Every token the UI can render as *text* has to clear 4.5:1 on each surface it lands on. The
   * stone palette shipped a mid-blue accent (3.0–3.4:1), a bright green and a diff green/red pair
   * that only worked on dark surfaces — this is the guard against that class of bug returning.
   */
  test('every text and state token clears 4.5:1 on every surface', () => {
    for (const theme of THEMES) {
      const surfaces: Array<[string, string]> = [
        ['bg', theme.palette.bg],
        ['panel', theme.palette.panel],
        ['elev', theme.palette.elev],
      ];
      const tokens: Array<[string, string]> = [
        ['foreground', theme.palette.text],
        ['muted', theme.palette.dim],
        ['highlight', theme.palette.highlight],
        ['success', theme.palette.success],
        ['warning', theme.palette.warning],
        ['danger', theme.palette.danger],
        ['diffAdd', theme.palette.diffAdd],
        ['diffDel', theme.palette.diffDel],
      ];
      for (const [token, color] of tokens) {
        for (const [surface, hex] of surfaces) {
          expect(
            contrastRatio(color, hex),
            `${theme.id}: ${token} (${color}) on ${surface} (${hex})`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test('text on the accent and in the user bubble stays legible', () => {
    for (const theme of THEMES) {
      expect(
        contrastRatio(theme.palette.highlightText, theme.palette.highlight),
        `${theme.id}: highlight-foreground on highlight`
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.palette.userBubbleText, theme.palette.userBubble),
        `${theme.id}: user bubble text`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('blob colours', () => {
  test('keeps avatar and instance marker colors distinguishable from every surface', () => {
    // 3 was the text-grade bar and proved too strict: it squeezed the palette's lightness until
    // colours collapsed into each other. A blob is a large flat disc, so the requirement is that it
    // reads as separate from the surface, not that it passes WCAG for glyphs.
    for (const theme of THEMES) {
      const surfaces = [theme.palette.panel, theme.palette.elev, theme.palette.bg];
      for (const color of [...identityPaletteFor(surfaces), ...instanceMarkerPaletteFor(surfaces)]) {
        for (const surface of surfaces) {
          expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(1.6);
        }
      }
    }
  });

  test('dark themes get brighter blobs and light themes more mid-toned ones', () => {
    // The complaint that started this: colours that only worked on one theme.
    const lightness = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const themes = THEMES.filter((theme) => theme.palette?.bg);
    let darkSeen = 0;
    let lightSeen = 0;
    for (const theme of themes) {
      const surfaces = [theme.palette.panel, theme.palette.elev, theme.palette.bg];
      const adjusted = identityPaletteFor(surfaces);
      const isDark = lightness(theme.palette.bg) < 0.5;
      const average = adjusted.reduce((sum, c) => sum + lightness(c), 0) / adjusted.length;
      if (isDark) {
        darkSeen += 1;
        // Clearly brighter than the surface it sits on.
        expect(average).toBeGreaterThan(lightness(theme.palette.bg) + 0.35);
      } else {
        lightSeen += 1;
        // Present but not washed out: a mid tone, not near-black and not invisible.
        expect(average).toBeGreaterThan(0.3);
        expect(average).toBeLessThan(0.85);
      }
    }
    // The suite should actually have exercised both kinds, or the assertion above proves nothing.
    expect(darkSeen).toBeGreaterThan(0);
    expect(lightSeen).toBeGreaterThan(0);
  });

  test('every adjusted colour keeps the face readable', () => {
    // Relaxing background contrast must not be paid for by the marks on top of the disc.
    for (const theme of THEMES) {
      const surfaces = [theme.palette.panel, theme.palette.elev, theme.palette.bg];
      for (const color of identityPaletteFor(surfaces)) {
        expect(contrastRatio(color, FACE_INK)).toBeGreaterThanOrEqual(MIN_FACE_CONTRAST);
      }
    }
  });

  test('adjusting for one theme does not collapse the palette into duplicates', () => {
    // The old floor pinned same-hue entries to a shared lightness boundary and they read as one.
    for (const theme of THEMES) {
      const surfaces = [theme.palette.panel, theme.palette.elev, theme.palette.bg];
      const adjusted = identityPaletteFor(surfaces);
      expect(new Set(adjusted).size).toBe(adjusted.length);
      let closest = Infinity;
      for (let i = 0; i < adjusted.length; i += 1) {
        for (let j = i + 1; j < adjusted.length; j += 1) {
          closest = Math.min(closest, perceptualDistance(adjusted[i], adjusted[j]));
        }
      }
      expect(closest).toBeGreaterThanOrEqual(0.05);
    }
  });

  test('keeps the base identity palette perceptually spread', () => {
    expect(IDENTITY_COLORS).toHaveLength(AVATAR_COLOR_COUNT);
    expect(AVATAR_COLOR_COUNT).toBeGreaterThanOrEqual(24);
    expect(new Set(IDENTITY_COLORS).size).toBe(AVATAR_COLOR_COUNT);
    for (let i = 0; i < IDENTITY_COLORS.length; i += 1) {
      for (let j = i + 1; j < IDENTITY_COLORS.length; j += 1) {
        expect(
          perceptualDistance(IDENTITY_COLORS[i], IDENTITY_COLORS[j]),
          `${IDENTITY_COLORS[i]} vs ${IDENTITY_COLORS[j]}`
        ).toBeGreaterThanOrEqual(MIN_IDENTITY_DISTANCE);
      }
    }
  });

  test('orders the identity palette as a rainbow', () => {
    for (let index = 1; index < IDENTITY_COLORS.length; index += 1) {
      expect(
        colorHue(IDENTITY_COLORS[index]),
        `${IDENTITY_COLORS[index]} should follow ${IDENTITY_COLORS[index - 1]}`
      ).toBeGreaterThanOrEqual(colorHue(IDENTITY_COLORS[index - 1]));
    }
  });

  test('keeps every theme-adjusted palette free of near-duplicates', () => {
    for (const theme of THEMES) {
      const surfaces = [theme.palette.panel, theme.palette.elev, theme.palette.bg];
      for (const palette of [identityPaletteFor(surfaces), instanceMarkerPaletteFor(surfaces)]) {
        expect(new Set(palette).size).toBe(palette.length);
        for (let i = 0; i < palette.length; i += 1) {
          for (let j = i + 1; j < palette.length; j += 1) {
            expect(
              perceptualDistance(palette[i], palette[j]),
              `${theme.id}: ${palette[i]} vs ${palette[j]}`
            ).toBeGreaterThanOrEqual(MIN_THEME_DISTANCE);
          }
        }
      }
    }
  });

  test('allocates every project color before cycling, keeps current keys, and prunes stale ones', () => {
    const keys = Array.from({ length: AVATAR_COLOR_COUNT + 1 }, (_, index) => `project:local::${String(index).padStart(2, '0')}`);
    const assignments = allocateProjectColors(keys, { [keys[10]]: 13, 'project:local::gone': 7 });
    expect(new Set(keys.slice(0, AVATAR_COLOR_COUNT).map((key) => assignments[key])).size).toBe(AVATAR_COLOR_COUNT);
    expect(assignments[keys[10]]).toBe(13);
    expect(assignments['project:local::gone']).toBeUndefined();
    expect(Object.values(assignments).every((index) => index >= 0 && index < AVATAR_COLOR_COUNT)).toBe(true);
  });

  test('allocates directory-only projects distinct colors alongside configured projects', () => {
    const projects: Project[] = [{ id: 'ember', name: 'Ember', path: '/workspace/ember' }];
    const sessions: Session[] = [
      { id: 'one', instanceId: 'local', directory: '/workspace/ember' },
      { id: 'two', instanceId: 'local', directory: '/workspace/habit' },
      { id: 'three', instanceId: 'local', directory: '/workspace/agent' },
    ];
    const keys = avatarColorKeys({ local: projects }, sessions);
    expect(keys).toContain('project:local::ember');
    expect(keys).toContain('directory:local::/workspace/habit');
    const assignments = allocateProjectColors(keys, {});
    expect(new Set(keys.map((key) => assignments[key])).size).toBe(keys.length);
  });

  test('preserves legacy colors when no grouped identity is supplied', () => {
    for (const seed of ['alpha', 'beta', 'gamma']) {
      const buddyRng = mulberry32(hashString(`buddy:${seed}`));
      expect(blobColor('buddy', seed)).toBe(
        BUDDY_COLORS[Math.floor(buddyRng() * BUDDY_COLORS.length)].fill
      );
      const crystalRng = mulberry32(hashString(`crystal:${seed}`));
      crystalRng();
      expect(blobColor('crystal', seed)).toBe(`var(--blob-${Math.floor(crystalRng() * IDENTITY_COLORS.length)})`);
    }
  });

  test('keeps each chat recognizable with its own stable color across projects and styles', () => {
    const projects: Project[] = [{ id: 'ember', name: 'Ember', path: '/workspace/ember' }];
    const first: Session = { id: 'one', instanceId: 'local', directory: '/workspace/ember' };
    const second: Session = { id: 'two', instanceId: 'local', directory: '/workspace/ember/src' };
    const firstIdentity = resolveAvatarIdentity(first, projects, {}, {});
    const secondIdentity = resolveAvatarIdentity(second, projects, {}, {});

    expect(firstIdentity.colorSeed).not.toBe(secondIdentity.colorSeed);
    expect(firstIdentity.shapeSeed).not.toBe(secondIdentity.shapeSeed);
    expect(resolveAvatarIdentity(first, [], {}, {}).colorIndex).toBe(firstIdentity.colorIndex);
    expect(resolveAvatarIdentity(first, projects, {}, {}).colorIndex).toBe(firstIdentity.colorIndex);
    expect(blobColor('crystal', firstIdentity)).not.toBe(blobColor('crystal', secondIdentity));
    expect(blobColor('buddy', firstIdentity)).not.toBe(blobColor('buddy', secondIdentity));
    expect(blobColor('buddy', firstIdentity)).toBe(blobColor('crystal', firstIdentity));
    const grouped = blobColor('buddy', firstIdentity).match(/^var\(--blob-(\d+)\)$/);
    expect(grouped).not.toBeNull();
    expect(Number(grouped?.[1])).toBeGreaterThanOrEqual(0);
    expect(Number(grouped?.[1])).toBeLessThan(AVATAR_COLOR_COUNT);
  });

  test('uses scheduled tasks for shape and sessions for motion', () => {
    const first: Session = { id: 'run-one', instanceId: 'local', directory: '/workspace/ember' };
    const second: Session = { id: 'run-two', instanceId: 'local', directory: '/workspace/ember' };
    const taskKey = 'task:local::ember::daily-review';
    const bindings = {
      'local::run-one': taskKey,
      'local::run-two': taskKey,
    };
    const firstIdentity = resolveAvatarIdentity(first, [], bindings, {});
    const secondIdentity = resolveAvatarIdentity(second, [], bindings, {});

    expect(firstIdentity.shapeSeed).toBe(secondIdentity.shapeSeed);
    expect(firstIdentity.motionSeed).not.toBe(secondIdentity.motionSeed);
  });

  test('applies project, task, then session overrides per trait', () => {
    const session: Session = { id: 'run', instanceId: 'local', directory: '/workspace/ember' };
    const projects: Project[] = [{ id: 'ember', name: 'Ember', path: '/workspace/ember' }];
    const taskKey = 'task:local::ember::daily-review';
    const identity = resolveAvatarIdentity(
      session,
      projects,
      { 'local::run': taskKey },
      {
        'project:local::ember': { colorIndex: 1, shapeName: 'tree' },
        [taskKey]: { colorIndex: 2 },
        'session:local::run': { shapeName: 'cloud' },
      }
    );

    expect(identity.colorIndex).toBe(2);
    expect(identity.shapeName).toBe('cloud');
  });
});


test('explicit chat colors are the same identity in every blob style and glow', () => {
  const identity = resolveAvatarIdentity({ id: 'one', instanceId: 'local' }, [], {}, { 'session:local::one': { color: '#d25b87' } });
  for (const style of ['buddy', 'crystal', 'lava', 'mosaic', 'scribble'] as const) expect(blobColor(style, identity)).toBe('#d25b87');
});


test('a chat swatch replaces an inherited custom color without changing its shape', () => {
  const session = { id: 'one', instanceId: 'local', directory: '/work' };
  const identity = resolveAvatarIdentity(session, [], {}, {
    'directory:local::/work': { color: '#d25b87', shapeName: 'cloud' },
    'session:local::one': { colorIndex: 3 },
  });
  expect(identity.color).toBeUndefined();
  expect(identity.colorIndex).toBe(3);
  expect(identity.shapeName).toBe('cloud');
});
