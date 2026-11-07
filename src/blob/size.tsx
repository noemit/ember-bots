import { createContext, useContext } from 'react';
import type { BlobSize } from '../types';

/** Only recognition surfaces opt in; transcript icons and controls keep their compact sizes. */
export const AvatarSizeContext = createContext<BlobSize>('standard');
export const AVATAR_SIZES = [
  { id: 'standard', label: 'Standard', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.25 },
  { id: 'extra-large', label: 'Extra large', scale: 1.5 },
] as const;
export const avatarPixels = (base: number, size: BlobSize): number =>
  Math.round(base * (AVATAR_SIZES.find(option => option.id === size)?.scale ?? 1));
export const useAvatarSize = (base: number): number => avatarPixels(base, useContext(AvatarSizeContext));
