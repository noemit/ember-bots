import Blob from '../blob/Blob';
import { useAvatarSize } from '../blob/size';
import type { AvatarIdentity, BallMood, BlobStyle } from '../types';

/** The destination stays beside the message, even when its conversation header is far away. */
export default function ComposerIdentity({ name, seed, identity, style, mood }: {
  name: string;
  seed: string;
  identity: AvatarIdentity;
  style: BlobStyle;
  mood: BallMood;
}) {
  const size = useAvatarSize(32);
  return <div data-composer-identity className="flex min-w-0 items-center gap-2 px-3 pt-2">
    <Blob style={style} seed={seed} identity={identity} size={size} mood={mood} interactive={false} />
    <span className="min-w-0 truncate text-xs font-medium text-foreground" title={name}>{name}</span>
  </div>;
}
