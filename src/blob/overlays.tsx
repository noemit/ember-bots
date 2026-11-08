import { createContext, useContext } from 'react';
import type { BallMood } from '../types';

/**
 * The pieces every blob style draws on top of its own body, kept in one place so a style only
 * implements what makes it different. Geometry is the 100x100 grid Buddy and Crystal share.
 */

/** Rail-only cap in CSS pixels, including the notification circle’s outline. */
export const NotificationSizeContext = createContext<number | undefined>(undefined);

/** Badge/accent colour per mood. */
export const accentFor = (mood: BallMood): string => {
  if (mood === 'input' || mood === 'question') return 'var(--attention)';
  if (mood === 'error') return 'var(--destructive)';
  return 'var(--highlight)';
};

/**
 * The notification / lock / question / warning badge in the top-right corner. All circles share
 * their size and centre; each renderer's `inset` follows its silhouette for every mood.
 */
export const MoodBadge = ({ mood, inset = 0, size = 30 }: { mood: BallMood; inset?: number; size?: number }) => {
  const maxDiameter = useContext(NotificationSizeContext);
  const accent = accentFor(mood);
  if (mood !== 'unread' && mood !== 'input' && mood !== 'question' && mood !== 'error') return null;
  const x = 78 - inset;
  const y = 22 + inset;
  // The SVG grid is 100 units wide. Include the 3-unit outline in the 35-unit diameter.
  // Decision badges retain their readable symbols; only an unread notification is capped.
  const scale = mood === 'unread' && maxDiameter !== undefined
    ? Math.min(1, maxDiameter / (size * .35)) : 1;
  return (
    <g className="blob-badge" data-badge={mood}
      transform={scale < 1 ? `translate(${x} ${y}) scale(${scale}) translate(${-x} ${-y})` : undefined}>
      {mood === 'error' ? (
        <>
          <path
            d={`M${x} ${y - 18} L${x + 19} ${y + 15} H${x - 19} Z`}
            fill={accent}
            stroke="var(--background)"
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <text x={x} y={y + 10} textAnchor="middle" fontSize={20} fontWeight={700} fill="var(--destructive-foreground)">
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
                stroke="var(--attention-foreground)"
                strokeWidth={2.8}
                strokeLinecap="round"
              />
              <rect x={x - 8} y={y - 1.5} width={16} height={12.5} rx={3} fill="var(--attention-foreground)" />
              <circle cx={x} cy={y + 4.5} r={1.8} fill={accent} />
            </>
          ) : mood === 'question' ? (
            <text x={x} y={y + 7} textAnchor="middle" fontSize={21} fontWeight={700} fill="var(--attention-foreground)">
              ?
            </text>
          ) : null}
        </>
      )}
    </g>
  );
};
