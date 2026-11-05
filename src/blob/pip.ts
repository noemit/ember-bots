/**
 * Pip: a flat, solid circle with a face that has *rolled* to somewhere on its surface.
 *
 * The reference sheet is a grid of plain coloured circles, each carrying a few thick black marks —
 * an arc and two dots — placed anywhere on the ball, rotated to lie along the surface, and clipped
 * when it reaches the rim. Nothing else: no body shape, no legs, no glow. Identity is the colour;
 * state is the face; and motion is the only thing that moves the face around.
 *
 * Two rules follow from the reference and matter more than they look:
 *
 * 1. **The face is a position, not a decoration.** It is placed at an angle from the circle's centre
 *    and rotated to sit tangent to the surface there, so it reads as painted on a rolling ball
 *    rather than stamped on a flat disc.
 * 2. **Idle does not roll.** A resting agent should look still — a circle that keeps spinning reads
 *    as busy. Only working states turn, and they turn slowly.
 */

/** The marks a face is built from, in the face's own local space, centred on the origin. */
export type PipMark =
  /** A stroked arc: the brow/orbit that dominates the reference faces. */
  | { kind: 'arc'; r: number; from: number; to: number }
  /** A filled dot. */
  | { kind: 'dot'; cx: number; cy: number; r: number }
  /** A short thick stroke, used for a mouth or a comma. */
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number };

export type PipFace = {
  name: string;
  marks: PipMark[];
  /**
   * Where the face sits, as an angle in degrees from the top of the circle (`0` = 12 o'clock,
   * `90` = 3 o'clock). Each mood picks a different resting place, so two agents in different states
   * are distinguishable even as small circles.
   */
  angle: number;
  /** How far from the centre, as a fraction of the radius. `0` is dead centre, `1` is the rim. */
  distance: number;
  /** Rotation applied to the whole face, relative to tangent-at-that-angle. */
  tilt?: number;
};

/** Stroke width for the marks, in the 100-unit viewBox. Thick: the reference is chunky. */
export const PIP_STROKE = 7;

const face = (
  name: string,
  angle: number,
  distance: number,
  marks: PipMark[],
  tilt = 0
): PipFace => ({ name, angle, distance, marks, tilt });

/**
 * The face vocabulary. Each is a handful of marks, because at 22px anything more becomes a smudge —
 * the arc and the dots still read when the circle is tiny, which is the whole reason the reference
 * style works as an avatar.
 */
export const PIP_FACES: Record<string, PipFace> = {
  /**
   * Resting. An arc and two dots, upright, high on the ball — the sheet's neutral face. No motion:
   * a still circle is the correct picture of an agent that is doing nothing.
   */
  idle: face(
    'idle',
    0,
    0.52,
    [
      { kind: 'arc', r: 26, from: 205, to: 335 },
      { kind: 'dot', cx: -11, cy: 14, r: 5 },
      { kind: 'dot', cx: 12, cy: 12, r: 5 },
    ]
  ),
  /**
   * No answer from the host. Deliberately not the idle face: the resting arc becomes a flat bar, so
   * a glance says "not known" rather than "doing nothing". The wrapper also desaturates and stills
   * every blob in this mood (`blob.css`), which is what carries the distinction at 22px.
   */
  unknown: face(
    'unknown',
    10,
    0.5,
    [
      { kind: 'line', x1: -20, y1: 8, x2: 20, y2: 8 },
      { kind: 'dot', cx: -10, cy: -12, r: 4.5 },
      { kind: 'dot', cx: 11, cy: -12, r: 4.5 },
    ],
    3
  ),
  /**
   * Working something out: the arc tightens into a shorter brow and the dots sit closer, turned
   * slightly, so it reads as screwed up in thought rather than merely resting.
   */
  thinking: face(
    'thinking',
    -18,
    0.6,
    [
      { kind: 'arc', r: 22, from: 200, to: 300 },
      { kind: 'dot', cx: -8, cy: 12, r: 4.5 },
      { kind: 'dot', cx: 10, cy: 10, r: 4.5 },
      { kind: 'line', x1: -2, y1: 22, x2: 6, y2: 22 },
    ],
    -8
  ),
  /** Busy: eyes wide open as two plain dots with a small arc above, and a short mouth. */
  busy: face(
    'busy',
    22,
    0.56,
    [
      { kind: 'arc', r: 18, from: 215, to: 325 },
      { kind: 'dot', cx: -9, cy: 10, r: 5.5 },
      { kind: 'dot', cx: 9, cy: 10, r: 5.5 },
      { kind: 'line', x1: -4, y1: 24, x2: 4, y2: 24 },
    ],
    10
  ),
  /** Wants you: an arc curving the other way (a smile above the eyes), and a hopeful lean. */
  input: face(
    'input',
    -40,
    0.58,
    [
      { kind: 'arc', r: 24, from: 25, to: 155 },
      { kind: 'dot', cx: -12, cy: -8, r: 5 },
      { kind: 'dot', cx: 11, cy: -9, r: 5 },
    ],
    -6
  ),
  /** A question: one dot, one comma, and a lopsided arc. */
  question: face(
    'question',
    38,
    0.6,
    [
      { kind: 'arc', r: 20, from: 200, to: 275 },
      { kind: 'dot', cx: -10, cy: 10, r: 5.5 },
      { kind: 'line', x1: 10, y1: 4, x2: 12, y2: 16 },
    ],
    16
  ),
  /** It went wrong: a flat line for a brow, and one flat mouth. Nothing curving, nothing cheerful. */
  error: face('error', 0, 0.44, [
    { kind: 'line', x1: -12, y1: -4, x2: 12, y2: -4 },
    { kind: 'line', x1: -8, y1: 12, x2: 8, y2: 12 },
  ]),
  /** Unread: idle, but tilted and a little wider, so a new reply catches the eye. */
  unread: face(
    'unread',
    14,
    0.54,
    [
      { kind: 'arc', r: 26, from: 205, to: 335 },
      { kind: 'dot', cx: -11, cy: 14, r: 5 },
      { kind: 'dot', cx: 12, cy: 12, r: 5 },
      { kind: 'dot', cx: 0, cy: -14, r: 3.5 },
    ]
  ),
};

/**
 * How each state moves, in degrees per second.
 *
 * Two shapes: `spin` circles the face steadily, `tumble` swings it back and forth so the ball looks
 * like it is actually rolling rather than orbiting on a turntable. Busy tumbles, because a busy agent
 * is a ball being thrown around — steady rotation read as low energy, which is exactly the note it
 * got.
 */
export type PipMotion = {
  /** Peak rotation speed. Higher is faster. */
  speed: number;
  /** `tumble` reverses direction each pass; `spin` keeps going one way. */
  kind: 'spin' | 'tumble';
  /** How far the face travels per pass, in degrees. Only used by `tumble`. */
  amplitude?: number;
};

/**
 * Idle, unread and error are absent — that is the guarantee they do not move at all, rather than a
 * zero speed that some future edit could nudge.
 */
export const PIP_MOTION: Record<string, PipMotion> = {
  thinking: { speed: 42, kind: 'spin' },
  // The energetic one: a wide arc, fast, reversing. Wide enough that the face crosses most of the
  // ball and clips at the rim, which is what sells "rolling" rather than "rotating".
  busy: { speed: 120, kind: 'tumble', amplitude: 150 },
  input: { speed: 64, kind: 'tumble', amplitude: 70 },
  question: { speed: 54, kind: 'spin' },
};

/** Back-compat view of the motion table: peak degrees per second, 0 for the still states. */
export const PIP_ROLL: Record<string, number> = {
  idle: 0,
  unread: 0,
  error: 0,
  unknown: 0,
  thinking: PIP_MOTION.thinking.speed,
  busy: PIP_MOTION.busy.speed,
  input: PIP_MOTION.input.speed,
  question: PIP_MOTION.question.speed,
};

/**
 * Each direction a travelling face can take. A tumble alternates between two of these so the ball
 * looks thrown from a different angle each pass, instead of sliding along one rail.
 */
export const PIP_TUMBLE_PATHS = [
  { from: -80, to: 80 },
  { from: 60, to: -120 },
  { from: -40, to: 150 },
  { from: 110, to: -60 },
] as const;

/** Where a face's origin lands, and how it is rotated, for a given extra roll (degrees). */
export const pipFacePlacement = (
  face: PipFace,
  roll: number
): { x: number; y: number; rotation: number } => {
  const angle = ((face.angle + roll) % 360) * (Math.PI / 180);
  const radius = 50 * face.distance;
  // 0deg is the top of the circle, so y is negated and cos drives x.
  return {
    x: 50 + Math.sin(angle) * radius,
    y: 50 - Math.cos(angle) * radius,
    // Tangent to the surface at that angle, plus the face's own tilt.
    rotation: face.angle + roll + (face.tilt ?? 0),
  };
};

export const pipFaceFor = (mood: string): PipFace => PIP_FACES[mood] ?? PIP_FACES.idle;

/**
 * Marks are always near-black, as in the reference: the circle's colour is the identity.
 * Re-exported from contrast so the palette can be validated against the same value.
 */
export { FACE_INK as PIP_INK } from './contrast';
