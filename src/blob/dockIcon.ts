import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AvatarIdentity, BallMood, BlobStyle } from '../types';

type BlobComponent = React.ComponentType<{
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  mood?: BallMood;
  interactive?: boolean;
}>;

const loadBlobComponent = async (style: BlobStyle): Promise<BlobComponent> => {
  if (style === 'scribble') return (await import('./ScribbleBlob')).default;
  if (style === 'mosaic') return (await import('./MosaicBlob')).default;
  if (style === 'lava') return (await import('./LavaBlob')).default;
  if (style === 'crystal') return (await import('./CrystalBlob')).default;
  return (await import('./BuddyBlob')).default;
};

const CANVAS = 512;
/** macOS app icons sit inside the 1024 grid with ~10% margin; the squircle radius is ~22.5%. */
const INSET = CANVAS * 0.08;
const TILE = CANVAS - INSET * 2;
const RADIUS = TILE * 0.225;

const cssVar = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Standalone SVG for a blob. The React markup references theme CSS variables that an
 * `<img>`-loaded SVG can't see, so they're resolved against the document first.
 */
const blobSvg = (
  Component: BlobComponent,
  identity: AvatarIdentity,
  mood: BallMood,
  size: number
): string => {
  const html = renderToStaticMarkup(
    React.createElement(Component, {
      seed: identity.sessionKey,
      identity,
      size,
      mood,
      interactive: false,
    })
  );
  // Renderers can keep fixed badges in a sibling SVG outside their moving body.
  // Merge those layers into one valid image instead of including the intervening HTML wrappers.
  const document = new DOMParser().parseFromString(html, 'text/html');
  const layers = [...document.querySelectorAll('svg')];
  const root = layers.shift();
  if (!root) throw new Error('blob renderer did not draw an SVG');
  for (const layer of layers) root.append(...layer.childNodes);
  const svg = root.outerHTML;
  // The blob's own `data-mood` wrapper and its CSS (the unknown treatment included) do not survive
  // this cut, so an unknown status is applied to the root here: half-lit and desaturated, the same
  // neutral look the rail draws. Without it the icon would be a plain idle blob, which is a guess.
  const neutral = mood === 'unknown' ? ' opacity="0.55" style="filter:grayscale(0.9)"' : '';
  return svg
    .replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg"${neutral}`)
    .replace(/var\((--[\w-]+)\)/g, (_match, name: string) => cssVar(name) || '#888');
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('blob svg failed to load'));
    image.src = src;
  });

/** Rasterise a session's blob onto a theme-coloured squircle tile, as a PNG data URL. */
export const renderDockIcon = async (
  style: BlobStyle,
  identity: AvatarIdentity,
  mood: BallMood
): Promise<string> => {
  const blobSize = TILE * 0.7;
  const Component = await loadBlobComponent(style);
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(blobSvg(Component, identity, mood, blobSize))}`
  );

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');

  ctx.beginPath();
  ctx.roundRect(INSET, INSET, TILE, TILE, RADIUS);
  ctx.fillStyle = cssVar('--sidebar') || '#222';
  ctx.fill();

  const offset = (CANVAS - blobSize) / 2;
  ctx.drawImage(image, offset, offset, blobSize, blobSize);

  // Every style includes the shared decision/unread badge in its SVG. Only motion-only moods
  // need an extra marker when rasterised into a still dock icon.
  const hasOwnBadge = mood === 'input' || mood === 'question' || mood === 'error' || mood === 'unread';
  // An unknown status gets no marker at all: the dot means "something is waiting for you", and the
  // one thing Ember knows here is that it does not know. The neutral blob above carries it instead.
  if (!hasOwnBadge && mood !== 'idle' && mood !== 'unknown') {
    const r = TILE * 0.075;
    const cx = INSET + TILE - r * 1.6;
    const cy = INSET + TILE - r * 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--highlight') || '#f08a3a';
    ctx.fill();
    ctx.lineWidth = r * 0.35;
    ctx.strokeStyle = cssVar('--sidebar') || '#222';
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
};
