/**
 * Palettes are neutral first: surfaces, text and borders are grays/beiges, and the one
 * main accent (`highlight`) is reserved for indicators — activity dots, focus rings,
 * selection ticks and the wordmark. Questions and approvals share a stronger, hue-shifted
 * secondary accent (`attention`); errors keep their own red. User bubbles stay softer.
 */
import { identityPaletteFor, instanceMarkerPaletteFor } from './blob/contrast';

export type ThemePalette = {
  bg: string;
  panel: string;
  elev: string;
  text: string;
  dim: string;
  border: string;
  highlight: string;
  highlightText: string;
  /** Secondary accent for questions/approvals, distinct from the main accent and error red. */
  attention: string;
  attentionText: string;
  /**
   * Readable green for connected/ready states. The vivid `emerald-*` utilities the components used
   * are tuned for dark surfaces; on a light theme they land near 1.3:1, so the state colour has to
   * come from the palette instead.
   */
  success: string;
  /** Diff add/remove line text: distinct from `success`/`danger` because it sits on a tinted row. */
  diffAdd: string;
  diffDel: string;
  warning: string;
  userBubble: string;
  userBubbleText: string;
  danger: string;
  dangerText: string;
};

export type ThemeGroup = 'neutral';

export type Theme = {
  id: string;
  name: string;
  group: ThemeGroup;
  dark: boolean;
  palette: ThemePalette;
};

export const DEFAULT_THEME_ID = 'stone';

export const THEME_GROUPS: Array<{ id: ThemeGroup; name: string }> = [
  { id: 'neutral', name: 'Colors' },
];

export const THEMES: Theme[] = [
  {
    id: 'stone',
    name: 'Stone',
    group: 'neutral',
    dark: false,
    palette: {
      bg: '#e2e2df',
      panel: '#d9d9d5',
      elev: '#d0d0cb',
      text: '#232322',
      dim: '#50504d',
      border: '#c4c4be',
      // Deep enough to be read *as text* (wordmark, "Needs input", Now-strip actions, badges),
      // which the previous mid-blue was not: it measured 3.0–3.4:1 on stone's surfaces.
      highlight: '#1e40af',
      highlightText: '#ffffff',
      attention: '#6524cf',
      attentionText: '#ffffff',
      success: '#065f46',
      diffAdd: '#065f46',
      diffDel: '#991b1b',
      warning: '#713700',
      userBubble: '#c1cee0',
      userBubbleText: '#232322',
      danger: '#9e2f2f',
      dangerText: '#ffffff',
    },
  },
  {
    id: 'clay',
    name: 'Clay',
    group: 'neutral',
    dark: true,
    palette: {
      bg: '#37322d',
      panel: '#3f3933',
      elev: '#4a433c',
      text: '#f1ebe2',
      dim: '#c2b7a7',
      border: '#534b42',
      highlight: '#f0a35e',
      highlightText: '#2a241d',
      attention: '#2dd4aa',
      attentionText: '#111111',
      success: '#34d399',
      diffAdd: '#6ee7b7',
      diffDel: '#fca5a5',
      warning: '#f0b36b',
      userBubble: '#604d3d',
      userBubbleText: '#f1ebe2',
      // Rose-red separates errors from the warm orange highlight and mint attention badges.
      danger: '#ff94a8',
      dangerText: '#111111',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    group: 'neutral',
    dark: true,
    palette: {
      bg: '#101214',
      panel: '#16191d',
      elev: '#1f2329',
      text: '#e6e9ed',
      dim: '#8d96a1',
      border: '#262c34',
      highlight: '#4cc2ff',
      highlightText: '#06121c',
      attention: '#a78bfa',
      attentionText: '#111111',
      success: '#34d399',
      diffAdd: '#6ee7b7',
      diffDel: '#fca5a5',
      warning: '#f0b36b',
      userBubble: '#30434f',
      userBubbleText: '#e6e9ed',
      danger: '#ff6b6b',
      dangerText: '#111111',
    },
  },
];

export const themeById = (id: string): Theme =>
  THEMES.find((theme) => theme.id === id) ?? THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? THEMES[0];

const toCssVars = (palette: ThemePalette): Record<string, string> => ({
  // Blobs sit on the rail (panel), selected rows (elev) and the chat header (bg).
  ...Object.fromEntries(
    identityPaletteFor([palette.panel, palette.elev, palette.bg]).map((color, index) => [`--blob-${index}`, color])
  ),
  ...Object.fromEntries(
    instanceMarkerPaletteFor([palette.panel, palette.elev, palette.bg]).map((color, index) => [`--instance-marker-${index}`, color])
  ),
  '--background': palette.bg,
  '--foreground': palette.text,
  '--card': palette.panel,
  '--card-foreground': palette.text,
  '--popover': palette.panel,
  '--popover-foreground': palette.text,
  // Neutral: buttons read as ink on paper rather than a splash of colour.
  '--primary': palette.text,
  '--primary-foreground': palette.bg,
  '--user-bubble': palette.userBubble,
  '--user-bubble-foreground': palette.userBubbleText,
  '--warning': palette.warning,
  '--secondary': palette.elev,
  '--secondary-foreground': palette.text,
  '--muted': palette.elev,
  '--muted-foreground': palette.dim,
  '--accent': palette.elev,
  '--accent-foreground': palette.text,
  '--destructive': palette.danger,
  '--destructive-foreground': palette.dangerText,
  '--border': palette.border,
  '--input': palette.border,
  '--ring': palette.highlight,
  '--sidebar': palette.panel,
  '--highlight': palette.highlight,
  '--highlight-foreground': palette.highlightText,
  '--attention': palette.attention,
  '--attention-foreground': palette.attentionText,
  '--success': palette.success,
  '--diff-add': palette.diffAdd,
  '--diff-del': palette.diffDel,
});

export const applyTheme = (id: string): void => {
  const theme = themeById(id);
  const root = document.documentElement;
  Object.entries(toCssVars(theme.palette)).forEach(([key, value]) =>
    root.style.setProperty(key, value)
  );
  // Pigment on light paper; emitted colour on dark surfaces, without a grey wash.
  root.style.setProperty('--composer-glow-blend', theme.dark ? 'color-dodge' : 'multiply');
  root.classList.toggle('dark', theme.dark);
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
};
