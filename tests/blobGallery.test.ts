import { expect, test } from 'bun:test';
import { galleryExamples } from '../src/dev/blobGalleryExamples';

test('every gallery style has three distinct, stable shapes and colours', () => {
  for (const style of ['buddy', 'crystal', 'lava', 'mosaic', 'scribble'] as const) {
    for (const seed of ['Curious comet', 'Another cast', 'Small moon']) {
      const examples = galleryExamples(style, seed);
      expect(examples).toEqual(galleryExamples(style, seed));
      expect(new Set(examples.map(example => example.shapeName)).size).toBe(3);
      expect(new Set(examples.map(example => example.colorIndex)).size).toBe(3);
      expect(new Set(examples.map(example => example.motionSeed)).size).toBe(3);
      expect(galleryExamples(style, seed, '#9772d9').map(example => example.color)).toEqual(Array(3).fill('#9772d9'));
    }
  }
});
