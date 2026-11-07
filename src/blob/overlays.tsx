import type { BallMood } from '../types';

/**
 * The pieces every blob style draws on top of its own body, kept in one place so a style only
 * implements what makes it different. Geometry is the 100x100 grid Buddy and Crystal share.
 */

/** Badge/accent colour per mood. */
export const accentFor = (mood: BallMood): string => {
  if (mood === 'input') return 'var(--warning)';
  if (mood === 'error') return 'var(--destructive)';
  return 'var(--highlight)';
};

/**
 * The lock / question / warning badge in the top-right corner. `scale` lets a style with a smaller
 * body (a crystal is wider than Buddy's dome) pull the badge in toward the shape.
 */
export const MoodBadge = ({ mood, inset = 0 }: { mood: BallMood; inset?: number }) => {
  const accent = accentFor(mood);
  if (mood !== 'input' && mood !== 'question' && mood !== 'error') return null;
  const x = 78 - inset;
  const y = 22 + inset;
  return (
    <g className="blob-badge">
      {mood === 'error' ? (
        <>
          <path
            d={`M${x} ${y - 18} L${x + 19} ${y + 15} H${x - 19} Z`}
            fill={accent}
            stroke="var(--background)"
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <text x={x} y={y + 10} textAnchor="middle" fontSize={20} fontWeight={700} fill="#ffffff">
            !
          </text>
        </>
      ) : (
        <>
          <circle cx={x} cy={y} r={16} fill={accent} stroke="var(--background)" strokeWidth={3} />
          {mood === 'input' ? (
            <>
              <path
                d={`M${x - 5} ${y - 1} v-3 a5 5 0 0 1 10 0 v3`}
                fill="none"
                stroke="#ffffff"
                strokeWidth={2.8}
                strokeLinecap="round"
              />
              <rect x={x - 8} y={y - 1.5} width={16} height={12.5} rx={3} fill="#ffffff" />
              <circle cx={x} cy={y + 4.5} r={1.8} fill={accent} />
            </>
          ) : (
            <text x={x} y={y + 7} textAnchor="middle" fontSize={21} fontWeight={700} fill="#ffffff">
              ?
            </text>
          )}
        </>
      )}
    </g>
  );
};
