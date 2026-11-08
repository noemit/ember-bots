import type { BallMood } from '../types';

/** Pen-drawn eyes: unequal whites, an uneven upper lid, and a readable resting gaze.
 * Expressions are geometry, not animation, so a paused rail still has a face. */
export function scribbleEyes(mood: BallMood) {
  const poses = {
    idle: { top: [6.5, 5], bottom: [7, 6], gaze: [0, 1], pupil: 2.4, brows: ['M-8 -10 Q-3 -12 2 -10', 'M-4 -9 Q0 -10 5 -8'] },
    busy: { top: [4, 4], bottom: [7, 6], gaze: [1.3, 1], pupil: 2.6, brows: ['M-8 -9 L5 -6', 'M-5 -6 L6 -9'] },
    thinking: { top: [3, 6], bottom: [6, 6], gaze: [-1.5, -1], pupil: 2.4, brows: ['M-8 -7 Q-2 -9 5 -6', 'M-5 -10 Q0 -14 6 -11'] },
    input: { top: [8, 7], bottom: [7, 6], gaze: [0, 0], pupil: 3, brows: ['M-8 -11 Q-2 -15 5 -12', 'M-5 -11 Q1 -14 6 -10'] },
    question: { top: [10, 4], bottom: [8, 5], gaze: [1, -1], pupil: 2.6, brows: ['M-8 -13 Q-2 -17 5 -13', 'M-5 -7 L6 -9'] },
    error: { top: [5, 4], bottom: [6, 5], gaze: [0, 0], pupil: 2.4, brows: ['M-8 -8 L5 -12', 'M-5 -11 L6 -7'] },
  } as const;
  const pose = poses[mood === 'unread' || mood === 'unknown' ? 'idle' : mood];
  return [9, 7].map((width, index) => {
    const top = pose.top[index];
    const bottom = pose.bottom[index];
    // Cubic control points exaggerate the lopsided pen contour without introducing sharp corners.
    const outline = `M${-width} 0 C${-width - .5} ${-top} ${width - 1} ${-top - 2} ${width} 0 C${width + .5} ${bottom + 2} ${-width + 1} ${bottom + 1} ${-width} 0Z`;
    return { x: index ? 60 : 40, y: index ? 46 : 42, width, top, bottom, outline, brow: pose.brows[index], gaze: pose.gaze, pupil: pose.pupil };
  });
}
