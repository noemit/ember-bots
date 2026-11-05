import * as React from 'react';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import { moodFrom, stateFromMood } from './mood';
import { hashString, mulberry32, seedIdentity } from './seed';
import { IDENTITY_COLORS } from './contrast';
import {
  PIP_INK,
  PIP_MOTION,
  PIP_STROKE,
  PIP_TUMBLE_PATHS,
  pipFaceFor,
  pipFacePlacement,
  type PipMark,
} from './pip';
import './blob-pip.css';

type Props = {
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  mood?: BallMood;
  state?: BallState;
  interactive?: boolean;
};

const Mark = ({ mark, ink }: { mark: PipMark; ink: string }) => {
  if (mark.kind === 'arc') {
    // An SVG arc needs two endpoints; walk the midpoint through the arc's own radius.
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const x1 = Math.cos(rad(mark.from)) * mark.r;
    const y1 = Math.sin(rad(mark.from)) * mark.r;
    const x2 = Math.cos(rad(mark.to)) * mark.r;
    const y2 = Math.sin(rad(mark.to)) * mark.r;
    const large = Math.abs(mark.to - mark.from) > 180 ? 1 : 0;
    // Sweep follows the direction of travel, so an arc can curve either way.
    const sweep = mark.to > mark.from ? 1 : 0;
    return (
      <path
        d={`M${x1.toFixed(2)} ${y1.toFixed(2)} A${mark.r} ${mark.r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`}
        stroke={ink}
        strokeWidth={PIP_STROKE}
        strokeLinecap="round"
        fill="none"
      />
    );
  }
  if (mark.kind === 'dot') {
    return <circle cx={mark.cx} cy={mark.cy} r={mark.r} fill={ink} />;
  }
  return (
    <line
      x1={mark.x1}
      y1={mark.y1}
      x2={mark.x2}
      y2={mark.y2}
      stroke={ink}
      strokeWidth={PIP_STROKE}
      strokeLinecap="round"
    />
  );
};

/**
 * A Pip: a flat circle with a face that has rolled somewhere onto its surface.
 *
 * The face is positioned at an angle from the centre and rotated to lie tangent there, then clipped
 * to the circle, so a face near the rim is cut off by the edge exactly as it is in the reference
 * sheet. Only working states roll; idle holds still, because a circle that keeps turning reads as
 * busy even when nothing is happening.
 */
export default function PipBlob({
  seed,
  identity,
  size = 30,
  mood,
  state,
  // Accepted for signature parity with the other styles. Pip's face is painted onto a rolling
  // surface, so it deliberately does not track a cursor the way Buddy's pupils do: the face moving
  // on its own is the whole character, and following the mouse would fight it.
  interactive: _interactive = true,
}: Props) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const { face, fill, motion, path, delay } = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const resolvedMood: BallMood = mood ?? moodFrom(state ?? 'idle', undefined, false);
    // The shared identity palette, not a private one. A per-style palette made the avatar picker
    // lie: the swatch and its preview read `--blob-N`, while the blob drew its own colour at the
    // same index, so the colour you clicked was never the colour you got. `identityPaletteFor`
    // already guarantees near-black marks stay readable on every theme-adjusted colour, so Pip
    // needs no palette of its own.
    const rng = mulberry32(hashString(`pip:${resolved.colorSeed}`));
    const index =
      Math.abs(resolved.colorIndex ?? Math.floor(rng() * IDENTITY_COLORS.length)) % IDENTITY_COLORS.length;
    const shape = PIP_MOTION[resolvedMood];
    // Stagger within one pass, not an arbitrary span: a delay longer than the cycle folds onto the
    // same phase, which put pairs of balls at identical angles. 0..0.95 of a pass keeps every ball
    // somewhere different, using a different part of the hash than the path so the two do not
    // correlate.
    const seedHash = hash(seed);
    const passSeconds = shape ? (360 / shape.speed) * 1 : 1;
    return {
      face: pipFaceFor(resolvedMood),
      fill: `var(--blob-${index})`,
      motion: shape,
      // Which direction this particular ball tumbles on its first pass, so two busy agents are
      // thrown differently instead of moving in lockstep.
      path: seedHash % PIP_TUMBLE_PATHS.length,
      delay: shape ? -((Math.floor(seedHash / 7) % 95) / 100) * passSeconds : 0,
    };
  }, [identity, seed, mood, state]);

  const effectiveState = state ?? stateFromMood(mood ?? 'idle');
  const needsInput = effectiveState === 'needs-input';
  const placement = pipFacePlacement(face, 0);
  const radius = 46;

  return (
    <div
      className="blob blob-pip"
      data-mood={face.name}
      data-state={effectiveState}
      data-rolling={motion ? 'true' : 'false'}
      data-motion={motion?.kind ?? 'none'}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // One full pass takes 360deg / speed seconds; the state decides speed and shape.
        ['--pip-pass' as string]: motion ? `${(360 / motion.speed).toFixed(2)}s` : '0s',
        ['--pip-amplitude' as string]: `${motion?.amplitude ?? 0}deg`,
        // Stagger where each ball is in its cycle, so a rail of them does not move as one.
        animationDelay: `${delay}s`,
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <clipPath id={`${uid}-ball`}>
            <circle cx={50} cy={50} r={radius} />
          </clipPath>
        </defs>

        {/* The ball itself: flat, solid, no gloss — the reference is a plain filled circle. */}
        <circle cx={50} cy={50} r={radius} fill={fill} />

        {/* Everything painted on the surface lives inside the ball's clip, so a face near the rim
            is cut by the edge rather than floating outside it. */}
        <g clipPath={`url(#${uid}-ball)`}>
          {/* The roller spins about the circle's centre, carrying the face around the surface.
              The inner group counter-rotates so the face keeps its own orientation relative to the
              ball, which is what makes it read as painted on rather than pinned to the screen. */}
          <g className="blob-pip-roller" data-path={path}>
            <g transform={`translate(${placement.x} ${placement.y}) rotate(${placement.rotation})`}>
              <g className="blob-pip-face" transform="scale(0.72)">
                {face.marks.map((mark, index) => (
                  <Mark key={index} mark={mark} ink={PIP_INK} />
                ))}
              </g>
            </g>
          </g>
        </g>

        {needsInput ? <circle cx={50} cy={50} r={radius + 3} className="blob-pip-orbit" /> : null}
      </svg>
    </div>
  );
}

/** A small string hash, only for staggering animation delays. */
const hash = (value: string): number => {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
