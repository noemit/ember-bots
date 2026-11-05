import { describe, expect, test } from 'bun:test';
import {
  MAX_SCALE,
  galleryForConversation,
  galleryForMessage,
  isRenderableImage,
  neighborIndex,
  zoomAt,
  type ImageView,
} from './src/lib/gallery';
import type { ChatMessage, FileAttachment } from './src/types';

const image = (filename: string, url = `data:image/png;base64,${filename}`, mime = 'image/png'): FileAttachment => ({
  filename,
  mime,
  url,
});

const message = (parts: ChatMessage['parts']): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: '',
  parts,
});

describe('galleryForConversation', () => {
  test('collects images across messages in reading order', () => {
    const first = message([
      { type: 'file', id: 'f1', file: image('one.png') },
      { type: 'tool', id: 't1', call: { id: 'c1', tool: 'view', status: 'completed', images: [image('two.png')] } },
    ]);
    const second = { ...message([{ type: 'file', id: 'f2', file: image('three.png') }]), id: 'm2' };
    const gallery = galleryForConversation([first, second]);
    expect(gallery.map((entry) => entry.filename)).toEqual(['one.png', 'two.png', 'three.png']);
    // Ids stay what a thumbnail searches for, so a click can find itself.
    expect(gallery.map((entry) => entry.id)).toEqual(['f1', 't1:0', 'f2']);
  });

  test('a conversation with no images yields an empty gallery, so no pager is offered', () => {
    expect(galleryForConversation([message([{ type: 'text', id: 'x', text: 'hi' }])])).toEqual([]);
  });
});

describe('isRenderableImage', () => {
  test('accepts data and http(s) images, rejects other mimes and schemes', () => {
    expect(isRenderableImage(image('a.png'))).toBe(true);
    expect(isRenderableImage({ filename: 'a.png', mime: 'image/png', url: 'https://x/a.png' })).toBe(true);
    expect(isRenderableImage({ filename: 'a.txt', mime: 'text/plain', url: 'data:text/plain,hi' })).toBe(false);
    expect(isRenderableImage({ filename: 'a.png', mime: 'image/png', url: 'file:///a.png' })).toBe(false);
  });
});

describe('galleryForMessage', () => {
  test('collects file and tool images in part order with stable ids', () => {
    const gallery = galleryForMessage(
      message([
        { type: 'text', id: 't', text: 'hi' },
        { type: 'file', id: 'file-1', file: image('photo.png') },
        {
          type: 'tool',
          id: 'call-1',
          call: { id: 'call-1', tool: 'view', status: 'completed', images: [image('shot-1.png'), image('shot-2.png')] },
        },
      ])
    );
    expect(gallery.map((entry) => entry.id)).toEqual(['file-1', 'call-1:0', 'call-1:1']);
    expect(gallery[0].filename).toBe('photo.png');
    expect(gallery[2].tool).toBe('view');
  });

  test('skips non-renderable files and a tool with no images', () => {
    const gallery = galleryForMessage(
      message([
        { type: 'file', id: 'f', file: { filename: 'notes.txt', mime: 'text/plain', url: 'data:text/plain,hi' } },
        { type: 'tool', id: 'c', call: { id: 'c', tool: 'bash', status: 'completed' } },
      ])
    );
    expect(gallery).toEqual([]);
  });
});

describe('neighborIndex', () => {
  test('wraps at both ends and pins an empty gallery', () => {
    expect(neighborIndex(3, 0, -1)).toBe(2);
    expect(neighborIndex(3, 2, 1)).toBe(0);
    expect(neighborIndex(3, 1, 1)).toBe(2);
    expect(neighborIndex(0, 0, 1)).toBe(0);
  });
});

describe('zoomAt', () => {
  const base: ImageView = { scale: 1, x: 0, y: 0 };

  test('holds the pointer point fixed while scaling', () => {
    const next = zoomAt(base, 100, -50, 2);
    expect(next.scale).toBe(2);
    expect(next.x).toBe(-100);
    expect(next.y).toBe(50);
  });

  test('clamps to the scale bounds', () => {
    expect(zoomAt(base, 0, 0, 100).scale).toBe(MAX_SCALE);
    expect(zoomAt(base, 0, 0, 0.1).scale).toBe(1);
  });

  test('resets the pan when returning to 1x', () => {
    expect(zoomAt({ scale: 4, x: 30, y: 30 }, 10, 10, 1)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
