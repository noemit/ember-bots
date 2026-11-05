/**
 * Image-gallery helpers for the transcript viewer. Pure: the renderable images of a message (and of
 * a whole conversation) in reading order, plus the small view math the zoom/pan surface needs. No
 * React, so it is unit-tested directly (see `gallery.test.ts`).
 *
 * An image "id" is stable per message so a thumbnail can find itself in the gallery: a file part
 * uses its part id, a tool-result image uses `<callId>:<index>`.
 */
import type { ChatMessage, FileAttachment } from '../types';

export type ViewerImage = {
  id: string;
  url: string;
  filename: string;
  mime: string;
  /** The tool that produced it, when it came from a tool result. */
  tool?: string;
};

/** A data URL or an http(s) URL with an image mime — what an `<img>` can actually show. */
export const isRenderableImage = (file: FileAttachment): boolean =>
  file.mime.startsWith('image/') && /^(data:|https?:\/\/)/.test(file.url);

/**
 * Every renderable image a message carried, in part order. File parts and tool-result images
 * interleave the way they render, so next/previous follows the transcript.
 */
export const galleryForMessage = (message: ChatMessage): ViewerImage[] => {
  const images: ViewerImage[] = [];
  for (const part of message.parts) {
    if (part.type === 'file') {
      if (isRenderableImage(part.file)) {
        images.push({
          id: part.id,
          url: part.file.url,
          filename: part.file.filename,
          mime: part.file.mime,
        });
      }
    } else if (part.type === 'tool') {
      (part.call.images ?? []).forEach((file, index) => {
        if (!isRenderableImage(file)) return;
        images.push({
          id: `${part.id}:${index}`,
          url: file.url,
          filename: file.filename,
          mime: file.mime,
          tool: part.call.tool,
        });
      });
    }
  }
  return images;
};

/**
 * Every renderable image in a conversation, in transcript order. The viewer opens on one of these,
 * so next/previous walk the whole chat rather than only the message you clicked: two screenshots in
 * two different turns are one gallery.
 */
export const galleryForConversation = (messages: readonly ChatMessage[]): ViewerImage[] =>
  messages.flatMap(galleryForMessage);

/** Step through a gallery, wrapping at both ends. Empty galleries stay at 0. */
export const neighborIndex = (count: number, index: number, delta: number): number => {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
};

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

/** Zoom/pan state: the image transform is `translate(x, y) scale(scale)`. */
export type ImageView = { scale: number; x: number; y: number };

export const IDENTITY_VIEW: ImageView = { scale: 1, x: 0, y: 0 };

/**
 * Zoom to `nextScale` while holding the point under the pointer still: the offset scales with
 * the ratio, so the feature under the cursor doesn't drift. Clamped to `[MIN_SCALE, MAX_SCALE]`;
 * at 1× the pan resets so the image is centred again.
 */
export const zoomAt = (
  view: ImageView,
  pointerX: number,
  pointerY: number,
  nextScale: number
): ImageView => {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  if (scale === view.scale) return view;
  if (scale === MIN_SCALE) return IDENTITY_VIEW;
  const ratio = scale / view.scale;
  return {
    scale,
    x: pointerX - (pointerX - view.x) * ratio,
    y: pointerY - (pointerY - view.y) * ratio,
  };
};
