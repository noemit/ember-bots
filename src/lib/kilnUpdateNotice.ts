import { version } from '../../packages/kiln/package.json';
import type { Instance } from '../types';

// The packaged harness uses the same manifest. An Ember release number is not a Kiln version.
export const BUNDLED_KILN_VERSION = version;
export type KilnUpdateState = 'not-applicable' | 'unavailable' | 'unknown' | 'older' | 'equal' | 'newer';

// Recommend stable releases only. A prerelease or an old host reporting only a commit is
// information we can't compare, not an instruction to change channels. Build metadata has no rank.
const stableParts = (value: string | undefined): number[] | null => {
  if (!value || value.length > 80) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
const bundled = stableParts(BUNDLED_KILN_VERSION);

/** Read-only observation, never a compatibility gate or a latest-release lookup. */
export const kilnUpdateState = (instance: Instance): KilnUpdateState => {
  if (instance.kind !== 'pi' || instance.id === 'pi:local' || instance.bundledKiln) return 'not-applicable';
  if (instance.status !== 'ready') return 'unavailable';
  const reported = stableParts(instance.version);
  if (!reported || !bundled) return 'unknown';
  for (let i = 0; i < bundled.length; i++) {
    if (reported[i] < bundled[i]) return 'older';
    if (reported[i] > bundled[i]) return 'newer';
  }
  return 'equal';
};
