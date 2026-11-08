import * as React from 'react';
import { hashString, mulberry32, seedIdentity } from './seed';
import { IDENTITY_COLORS } from './contrast';
import { BUDDY_COLORS, BUDDY_SHAPES } from './buddy';
import { usePupilTracking } from './usePupilTracking';
import { MoodBadge } from './overlays';
import type { AvatarIdentity, BallMood, BallState } from '../types';
import './blob.css';

type Props = {
  seed: string;
  identity?: AvatarIdentity;
  size?: number;
  /** Kept for callers that only know the coarse state; `mood` is what drives the visuals. */
  state?: BallState;
  mood?: BallMood;
  interactive?: boolean;
};

export default function BuddyBlob({ seed, identity, size = 30, mood = 'idle', interactive = true }: Props) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const leftPupil = React.useRef<SVGGElement>(null);
  const rightPupil = React.useRef<SVGGElement>(null);

  const { color, shape, tilt, wobbleDelay, flipDelay, flipDuration } = React.useMemo(() => {
    const resolved = identity ?? seedIdentity(seed);
    const colorRng = mulberry32(hashString(`buddy:${resolved.colorSeed}`));
    const shapeRng = mulberry32(hashString(`buddy:${resolved.shapeSeed}`));
    const motionRng = mulberry32(hashString(`buddy:${resolved.motionSeed}`));
    shapeRng();
    motionRng();
    motionRng();
    const groupedColor = Boolean(resolved.projectKey || resolved.colorIndex !== undefined);
    const colorIndex = resolved.colorIndex ?? Math.floor(
      colorRng() * (groupedColor ? IDENTITY_COLORS.length : BUDDY_COLORS.length)
    );
    const baseColor = BUDDY_COLORS[Math.abs(colorIndex) % BUDDY_COLORS.length];
    return {
      color: resolved.color ? { ...baseColor, fill: resolved.color } : groupedColor
        ? { ...baseColor, fill: `var(--blob-${Math.abs(colorIndex) % IDENTITY_COLORS.length})` }
        : baseColor,
      shape:
        BUDDY_SHAPES.find((entry) => entry.name === resolved.shapeName) ??
        BUDDY_SHAPES[Math.floor(shapeRng() * BUDDY_SHAPES.length)],
      tilt: Math.round((motionRng() - 0.5) * 16),
      wobbleDelay: -(motionRng() * 4).toFixed(2),
      // Busy blobs flip once every ~9–16s; the negative delay spreads them out so a busy list
      // never somersaults in unison.
      flipDelay: -(motionRng() * 16).toFixed(2),
      flipDuration: (9 + motionRng() * 7).toFixed(2),
    };
  }, [identity, seed]);

  const isError = mood === 'error';
  // A blob with no host answer does not follow the pointer: tracking reads as "awake and watching",
  // which is exactly the claim an unknown status cannot make.
  usePupilTracking(wrapperRef, [leftPupil, rightPupil], interactive && !isError && mood !== 'unknown' && mood !== 'thinking', 5.5);

  const renderEye = (offsetX: number, pupilRef: React.RefObject<SVGGElement | null>) => (
    <g transform={`translate(${shape.eyeX + offsetX} ${shape.eyeY}) scale(${shape.eyeScale})`}>
      <ellipse rx={12} ry={13.5} fill="#ffffff" />
      {isError ? (
        <g stroke={color.ink} strokeWidth={3} strokeLinecap="round">
          <line x1={-5.5} y1={-5.5} x2={5.5} y2={5.5} />
          <line x1={-5.5} y1={5.5} x2={5.5} y2={-5.5} />
        </g>
      ) : (
        <g className="buddy-gaze"><g ref={pupilRef} className="blob-pupil" transform={mood === 'thinking' ? 'translate(0 0)' : undefined}>
          <circle r={6.5} fill={color.ink} />
          <circle cx={-2.2} cy={-2.4} r={2} fill="#ffffff" />
        </g></g>
      )}
    </g>
  );

  return (
    <div
      className="blob blob-buddy"
      data-mood={mood}
      aria-hidden="true"
      ref={wrapperRef}
      style={{ width: size, height: size, animationDelay: `${wobbleDelay}s`, '--buddy-thought-delay': `${wobbleDelay}s` } as React.CSSProperties}
    >
      {/* The hop/flip wrappers are DOM elements rather than SVG <g>s: Chromium can composite a
          transform on a DOM node but not on an SVG child, and Buddy's idle breathe runs on every
          visible session in the rail. Decision badges sit in their own overlay so they hold
          still while the body hops. */}
      <div className="blob-hop" style={{ animationDelay: `${wobbleDelay}s` }}>
        <div
          className="blob-flip"
          style={{ animationDuration: `${flipDuration}s`, animationDelay: `${flipDelay}s` }}
        >
          <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
            <g className="blob-body" transform={`rotate(${tilt} 50 50)`}>
              <path d={shape.path} fill={color.fill} />
            </g>
            <g className="blob-eyes" style={{ animationDelay: `${wobbleDelay}s` }}>
              {renderEye(-shape.eyeGap, leftPupil)}
              {renderEye(shape.eyeGap, rightPupil)}
            </g>
          </svg>
        </div>
      </div>

      <svg
        className="blob-overlay"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        style={{ overflow: 'visible' }}
      >
        <MoodBadge size={size} mood={mood} />
      </svg>
    </div>
  );
}
