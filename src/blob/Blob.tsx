import * as React from 'react';
import AvatarTransition from './AvatarTransition';
import BuddyBlob from './BuddyBlob';
import CrystalBlob from './CrystalBlob';
import MosaicBlob from './MosaicBlob';
import LavaBlob from './LavaBlob';
import { effectiveBlobStyle } from './styles';
import { moodFrom, stateFromMood } from './mood';
import { seedIdentity } from './seed';
import type { AvatarIdentity, BallMood, BallState, BlobStyle } from '../types';

type Props = {
  style: BlobStyle;
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  state?: BallState;
  mood?: BallMood;
  interactive?: boolean;
};

/** Picks the blob renderer for the active style so callers don't care which is on. */
export default function Blob({ style: requestedStyle, ...rest }: Props) {
  const style = effectiveBlobStyle(requestedStyle, rest.identity);
  // Renderers memoize on the identity reference; a fresh object per render would defeat that.
  const identity = React.useMemo(
    () => rest.identity ?? seedIdentity(rest.seed),
    [rest.identity, rest.seed]
  );
  // A caller that only knows the coarse state still gets a sensible mood.
  const mood = rest.mood ?? moodFrom(rest.state ?? 'idle', undefined, false);
  const state = rest.state ?? stateFromMood(mood);
  const props = { ...rest, identity, mood, state };
  const rendered =
    style === 'buddy' ? (
      <BuddyBlob {...props} />
    ) : style === 'mosaic' ? (
      <MosaicBlob {...props} />
    ) : style === 'lava' ? (
      <LavaBlob {...props} />
    ) : (
      <CrystalBlob {...props} />
    );
  return <AvatarTransition seed={rest.seed}>{rendered}</AvatarTransition>;
}
