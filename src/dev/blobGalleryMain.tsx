import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Blob from '../blob/Blob';
import { seedIdentity } from '../blob/seed';
import { applyTheme, THEMES } from '../themes';
import { useMotionPause } from '../lib/useMotionPause';
import type { BallMood, BlobStyle } from '../types';
import '../styles.css';
import './blobGallery.css';

const styles: { id: BlobStyle; name: string; description: string }[] = [
  { id: 'scribble', name: 'Scribble', description: 'A little ink creature with a lot on its mind.' },
  { id: 'mosaic', name: 'Mosaic', description: 'Colourful tiles, with a little activity at the edges.' },
  { id: 'buddy', name: 'Buddy', description: 'The original round companion.' },
  { id: 'lava', name: 'Lava', description: 'Soft shapes and flowing colour.' },
  { id: 'crystal', name: 'Crystal', description: 'Facets, glints and a sharper silhouette.' },
];
const moods: { id: BallMood; name: string; description: string }[] = [
  { id: 'idle', name: 'Idle', description: 'Nothing running' },
  { id: 'busy', name: 'Working', description: 'Using tools' },
  { id: 'thinking', name: 'Thinking', description: 'Reasoning through a reply' },
  { id: 'input', name: 'Approval', description: 'Needs your permission' },
  { id: 'question', name: 'Question', description: 'Needs your answer' },
  { id: 'error', name: 'Error', description: 'Something needs attention' },
  { id: 'unread', name: 'Unread', description: 'A reply you haven’t read' },
  { id: 'unknown', name: 'Unavailable', description: 'No answer from the host' },
];

/** A standalone development surface: actual app renderers, no bridge, sessions or credentials. */
function BlobGallery() {
  const [theme, setTheme] = React.useState('stone');
  const [size, setSize] = React.useState(72);
  const [seed, setSeed] = React.useState('Curious comet');
  const [color, setColor] = React.useState('#9772d9');
  const [custom, setCustom] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [reduced, setReduced] = React.useState(false);
  const [preview, setPreview] = React.useState<{ phase: number; revision: number } | null>(null);
  useMotionPause();
  React.useLayoutEffect(() => { applyTheme(theme); }, [theme]);
  const identity = React.useMemo(() => ({ ...seedIdentity(seed), ...(custom ? { color } : {}) }), [seed, color, custom]);
  // Restart with a CSS phase offset: previewing must not detach animations from CSS, which would
  // let them survive a later reduced-motion choice. All app renderers stay unchanged.
  const jump = (phase: number) => setPreview(previous => ({ phase, revision: (previous?.revision ?? 0) + 1 }));
  const renderBlob = (style: BlobStyle, mood: BallMood, previewSize = size) =>
    <Blob key={style === 'scribble' && mood === 'busy' ? preview?.revision ?? 0 : 0} style={style} mood={mood} seed={seed} identity={identity} size={previewSize} interactive={false} />;

  return <div className="blob-gallery" data-paused={paused} data-reduced={reduced} data-scribble-preview={Boolean(preview)}
    style={preview ? { '--gallery-scribble-delay': `-${preview.phase}s` } as React.CSSProperties : undefined}>
    <header className="gallery-intro">
      <p className="gallery-eyebrow">EMBER / CREATURE STUDIES</p>
      <h1>A little more character.</h1>
      <p>Five styles. Every state. Watch them at chat size, or get closer and tell me what feels right.</p>
    </header>
    <section className="gallery-controls" aria-label="Preview controls">
      <label>Theme<select aria-label="Theme" value={theme} onChange={e => setTheme(e.target.value)}>{THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>Character<input value={seed} onChange={e => setSeed(e.target.value)} /></label>
      <label className="gallery-size">Size · {size}px<input aria-label="Blob size" type="range" min="32" max="120" value={size} onChange={e => setSize(Number(e.target.value))} /></label>
      <div className="gallery-color"><label><input type="checkbox" checked={custom} onChange={e => setCustom(e.target.checked)} />Custom colour</label><input aria-label="Creature colour" type="color" value={color} onChange={e => { setColor(e.target.value); setCustom(true); }} /></div>
      <button onClick={() => setPaused(value => !value)} aria-pressed={paused}>{paused ? 'Play animations' : 'Pause animations'}</button>
      <label className="gallery-check"><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} />Reduced motion</label>
    </section>

    <section className="gallery-spotlights" aria-label="New working animations">
      <article className="gallery-spotlight">
        <div className="gallery-stage" data-preview="scribble">{renderBlob('scribble', 'busy', 160)}<div className="gallery-rail-sample">{renderBlob('scribble', 'busy', 55)}<span>Rail size</span></div></div>
        <div><p className="gallery-eyebrow">01 / SCRIBBLE IN MOTION</p><h2>A moment to think.</h2><p>A head scratch, a curious turn, a little stretch. Three gestures in a relaxed twelve-second loop.</p>
          <div className="gallery-gestures" aria-label="Preview Scribble gestures">
            <button onClick={() => jump(1.6)}>Head scratch</button><button onClick={() => jump(5.8)}>Turn around</button><button onClick={() => jump(9.8)}>Little stretch</button>
          </div>
        </div>
      </article>
      <article className="gallery-spotlight">
        <div className="gallery-stage" data-preview="mosaic">{renderBlob('mosaic', 'busy', 160)}<div className="gallery-rail-sample">{renderBlob('mosaic', 'busy', 55)}<span>Rail size</span></div></div>
        <div><p className="gallery-eyebrow">02 / MOSAIC IN MOTION</p><h2>Thinking in pixels.</h2><p>Tiles pop into place on the left and right, then disappear. The face stays steady while the edges get to work.</p></div>
      </article>
    </section>

    <section className="gallery-states" aria-label="All blob styles and states">
      <div className="gallery-section-heading"><h2>The full cast.</h2><div className="gallery-gestures"><button onClick={() => setSize(55)}>Rail · 55px</button><button onClick={() => setSize(83)}>Extra large · 83px</button><button onClick={() => setSize(112)}>Detail · 112px</button></div></div>
      {styles.map(style => <section key={style.id} className="gallery-style" aria-label={`${style.name} states`}>
        <div className="gallery-style-heading"><h3>{style.name}</h3><p>{style.description}</p></div>
        <div className="gallery-scroll"><div className="gallery-mood-grid">
          {moods.map(mood => <figure key={mood.id} className="gallery-state" data-style={style.id} data-state={mood.id}>
            <div className="gallery-state-art">{renderBlob(style.id, mood.id)}</div>
            <figcaption><strong>{mood.name}</strong><span>{mood.description}</span></figcaption>
          </figure>)}
        </div></div>
      </section>)}
    </section>
    <footer className="gallery-footer">For feedback, name the style and state — for example, “Scribble · Working · the head scratch.” Change the character name to try another silhouette.</footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><BlobGallery /></React.StrictMode>);
