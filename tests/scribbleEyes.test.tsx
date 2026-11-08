import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ScribbleBlob from '../src/blob/ScribbleBlob';
import { scribbleEyes } from '../src/blob/scribbleEyes';

const moods = ['idle', 'busy', 'thinking', 'input', 'question', 'error'] as const;

test('each mood has a distinct still-frame eye expression, with deliberately unequal pen contours', () => {
  expect(new Set(moods.map(mood => JSON.stringify(scribbleEyes(mood)))).size).toBe(moods.length);
  for (const mood of moods) {
    const eyes = scribbleEyes(mood);
    expect(eyes[0].outline).not.toBe(eyes[1].outline);
    for (const eye of eyes) {
      // Convex hull of every Bezier control point stays inside the face's safe box.
      const points = eye.outline.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let i = 0; i < points.length; i += 2) {
        expect(eye.x + points[i]).toBeGreaterThan(28);
        expect(eye.x + points[i]).toBeLessThan(70);
        expect(eye.y + points[i + 1]).toBeGreaterThan(28);
        expect(eye.y + points[i + 1]).toBeLessThan(58);
      }
      // A pupil remains substantial even in a 55px rail, not a disappearing pinprick.
      expect(eye.pupil * 2 * .55).toBeGreaterThan(2.5);
    }
  }
});

test('attention opens the eyes, work lowers the lids, and thought glances up', () => {
  expect(scribbleEyes('input')[0].top).toBeGreaterThan(scribbleEyes('idle')[0].top);
  expect(scribbleEyes('busy')[0].top).toBeLessThan(scribbleEyes('idle')[0].top);
  expect(scribbleEyes('thinking')[0].gaze[1]).toBeLessThan(0);
  expect(scribbleEyes('question')[0].top / scribbleEyes('question')[1].top).toBeGreaterThan(2);
  expect(scribbleEyes('unread')).toEqual(scribbleEyes('idle'));
});

test('every pupil is contained by its own pen contour, with unique clips across siblings', () => {
  const html = renderToStaticMarkup(<>{moods.map(mood => <ScribbleBlob key={mood} seed="eyes" mood={mood} size={55} />)}</>);
  const ids = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map(match => match[1]);
  expect(ids).toHaveLength(moods.length * 2);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(html).toContain(`clip-path="url(#${id})"`);
  expect(html).not.toContain('<filter');
});
