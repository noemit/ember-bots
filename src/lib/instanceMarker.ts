import { INSTANCE_MARKER_COLORS } from '../blob/contrast';
import type { InstanceDefaults } from '../types';

/**
 * The colour of an instance's underline, or undefined for none.
 *
 * **No underline unless one is chosen.** The underline is a deliberate mark: it is how you tell at a
 * glance which Hearth a session is running on, which matters when several are live at once. But it
 * also adds chrome to every row, so it must be something you asked for rather than something the app
 * decided to draw. An unset `markerColor` therefore means *no marker*, and the picker's default
 * state is Off.
 *
 * `markerColor` is a palette index. Random colours are offered as a convenience in the picker (see
 * `suggestMarkerColor`) but are still an explicit choice, never applied on their own.
 */
export const MARKER_OFF = -1;

const hash = (value: string): number => {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** A stable colour for an instance id, offered by the picker as a one-click suggestion. */
export const suggestMarkerColor = (instanceId: string): number =>
  hash(instanceId) % INSTANCE_MARKER_COLORS.length;

/**
 * The underline colour to render, or undefined when the instance is unmarked — which is the default.
 * An explicit choice always wins; whatever a past version defaulted to is not honoured.
 */
export const instanceMarkerColor = (
  _instanceId: string,
  defaults: InstanceDefaults | undefined
): number | undefined => {
  const chosen = defaults?.markerColor;
  if (chosen === undefined || chosen === MARKER_OFF) return undefined;
  if (chosen < 0 || chosen >= INSTANCE_MARKER_COLORS.length) return undefined;
  return chosen;
};
