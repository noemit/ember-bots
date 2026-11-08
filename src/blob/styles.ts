import type { BlobStyle } from '../types';

/** Retired styles remain valid saved preferences; retirement is presentation-only. */
export const ACTIVE_BLOB_STYLES = ['buddy', 'crystal', 'mosaic', 'lava'] as const;
export type ActiveBlobStyle = (typeof ACTIVE_BLOB_STYLES)[number];

export const effectiveBlobStyle = (style: BlobStyle): ActiveBlobStyle =>
  style === 'scribble' ? 'buddy' : style;
