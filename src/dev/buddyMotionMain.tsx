import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import BuddyBlob from '../blob/BuddyBlob';
import { useMotionPause } from '../lib/useMotionPause';
import type { BallMood } from '../types';
import { applyTheme } from '../themes';
import '../styles.css';

const moods: BallMood[] = ['idle', 'busy', 'thinking', 'input', 'question', 'error', 'unread', 'unknown'];
function BuddyMotionStudy() {
  const [mood, setMood] = React.useState<BallMood>('busy');
  useMotionPause();
  React.useLayoutEffect(() => applyTheme('stone'), []);
  return <main style={{ padding: 48 }}>
    <h1 style={{ fontSize: 28 }}>Buddy · mood handoffs</h1>
    <p style={{ margin: '12px 0 28px' }}>The same four bots, without remounting. Move the pointer nearby to keep their gaze through a change.</p>
    <nav aria-label="Mood" style={{ display: 'flex', gap: 20 }}>
      {moods.map(value => <button key={value} aria-pressed={mood === value}
        onClick={() => flushSync(() => setMood(value))}>{value}</button>)}
    </nav>
    <p style={{ marginTop: 28 }}>Now: <strong data-current-mood>{mood}</strong></p>
    {[55, 112].map(size => <section key={size} aria-label={`${size}px bots`} style={{ display: 'flex', gap: 80, alignItems: 'center', marginTop: 80 }}>
      <span style={{ width: 90 }}>{size === 55 ? 'Rail · 55px' : 'Detail · 112px'}</span>
      {['comet', 'meadow', 'garden', 'copper'].map(seed => <BuddyBlob key={seed} seed={seed} size={size} mood={mood} />)}
    </section>)}
  </main>;
}
createRoot(document.getElementById('root')!).render(<BuddyMotionStudy />);
