// Browser-test scene only. Not a Vite release input or an editing/design surface.
import React from 'react';
import { createRoot } from 'react-dom/client';
import MosaicBlob from '../../src/blob/MosaicBlob';
import { FACES } from '../../src/blob/mosaicFaces';
import { seedIdentity } from '../../src/blob/seed';
import { mosaicGeometry } from '../../src/blob/mosaic';
import { identityForFace } from '../../src/blob/mosaicFace';
import { applyTheme } from '../../src/themes';
import type { BallMood } from '../../src/types';

const params = new URLSearchParams(location.search);
const dark = params.get('theme') === 'dark';
applyTheme(dark ? 'graphite' : 'stone');
const moods: BallMood[] = ['idle', 'busy', 'thinking', 'error', 'unknown', 'question', 'input', 'unread'];
const sizes = params.has('moods') ? [55] : [24, 30, 44, 55, 69, 83];
const shownMoods = params.has('moods') ? moods : ['idle'] as BallMood[];
const mirrored = params.has('mirrored');
const faceIdentity = (face: typeof FACES[number]) => {
  const identity = { ...seedIdentity(face.id), faceId: face.id };
  for (let i = 0; i < 100; i++) {
    identity.shapeSeed = face.id + ':' + i;
    if (mosaicGeometry(identityForFace(identity, face)).mirrored === mirrored) return identity;
  }
  throw new Error('No matching mirror seed');
};
document.body.style.cssText = 'margin:20px;font:12px system-ui;background:' + (dark ? '#18191b;color:#eee' : '#f4f3ef;color:#171719');
createRoot(document.getElementById('root')!).render(<main>
  <h1>Production Mosaic · {dark ? 'dark' : 'light'} · {params.has('moods') ? 'moods at 55px' : 'recognition sizes'}</h1>
  <p>Real MosaicBlob renderer · {mirrored ? 'mirrored bodies' : 'unmirrored bodies'} · pinned production faces · {matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced motion' : 'live motion'}</p>
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
    {FACES.map(face => <section key={face.id} data-case={face.id} style={{ border: '1px solid #8886', padding: 10 }}>
      <h2 style={{ fontSize: 13 }}>{face.label} · {face.id} · {face.body}{face.bodyShift ? ' · body +1 row' : ''}</h2>
      <div style={{ display: 'flex', gap: 7, alignItems: 'end' }}>{shownMoods.flatMap(mood => sizes.map(size => <div key={mood + size} style={{ textAlign: 'center' }}>
        <MosaicBlob seed={face.id} identity={faceIdentity(face)} size={size} mood={mood} />
        <span>{params.has('moods') ? mood === 'input' ? 'approval' : mood : size + 'px'}</span>
      </div>))}</div>
    </section>)}
  </div>
  <h2>Explicit saved silhouette · incompatible horns pin cannot replace sail</h2>
  <div data-explicit><MosaicBlob seed="saved-sail" identity={{ ...seedIdentity('saved-sail'), faceId: 'horns.1', shapeName: 'sail', color: '#5577aa' }} size={83} mood="busy" /></div>
  <h2>Explicit Automatic sentinel · production face, not forced Plain</h2>
  <div data-automatic><MosaicBlob seed="automatic" identity={{ ...seedIdentity('automatic'), shapeName: 'automatic', faceId: 'horns.1' }} size={83} mood="error" /></div>
</main>);
