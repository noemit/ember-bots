/**
 * The final face set: what was drawn by hand, plus what was kept.
 *
 * This is a **ship list, not a gallery**. Earlier pages mixed candidates with decisions, which made
 * "what are we actually using?" unanswerable and left rejected drawings on screen. Everything here
 * has been chosen, either because it was hand-drawn or because it was marked keep, and nothing else
 * appears.
 *
 * It reads from the same `MOSAIC_ACCESSORIES` record as the rest of the app, so a face shown here is
 * the face that ships — there is no second copy to drift.
 *
 * The one thing it does *not* read from code is which body a face sits on. That is assigned here, by
 * picking a silhouette on the card, because it is a judgement about the drawing rather than a fact
 * about it — and a judgement that had to be made by editing a map and reloading was a judgement that
 * never got revised. The choice persists in `localStorage` under `mosaic-face-bodies`, and travels
 * into `drawings.json` with the drawings so it can leave the browser.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { mosaicGeometry, mosaicBaseHex, mosaicField, mosaicSurfaces, MOSAIC_SHAPES } from '../blob/mosaic';
import { MOSAIC_ACCESSORIES, type MosaicAccessory } from '../blob/mosaicAccessories';
import { seedIdentity } from '../blob/seed';
import { copyText } from '../lib/clipboard';
import { useGridFacts, pixelsOffBody, cellKey } from './mosaicFit';
import { BODY_NAMES, FACE_BODY_KEY, FACE_BODY_SHIFT, readBodyOverrides, resolveBodies } from './mosaicBodies';
import {
  DRAWING_FACE_KEY,
  DRAWING_KEY,
  parsePixels,
  type DrawingPixel,
  type SavedDrawing,
} from './mosaicDrawing';
import PixelEditor, { type GridPixel } from './PixelEditor';
import type { AvatarIdentity, BallMood } from '../types';
import '../blob/blob.css';
import '../blob/blob-mosaic.css';
import './mosaicAccessoryAnims.css';
/* The face set's own styles. Named for the page, not for the gallery it replaced: the sheet carries
   the drawing bench as well, and a `mosaicFaces` name on it would send the next person looking for a
   page that no longer exists. */
import './faceSet.css';

/**
 * The ship list, in reading order: plain first, then faces by where they sit on the body.
 *
 * `{ accessory, variant }` rather than a bare name, because a kept face is a specific variant —
 * `tears.3` is a different drawing from `tears.1`, and only one of them survived review.
 */
type Entry = {
  /** Stable id, matching the review page's keep ids so the two agree. */
  id: string;
  /** `null` for the plain face. */
  accessory: MosaicAccessory | null;
  variant: number;
  /** What it is, in a person's words. */
  label: string;
  /** Where it sits, for grouping. */
  group: 'Face' | 'Eyewear' | 'Headwear' | 'Marks';
};

const SHIP_LIST: readonly Entry[] = [
  { id: 'plain', accessory: null, variant: 0, label: 'Plain', group: 'Face' },

  // Eyewear. The band spans the eye row, but the eyes are meant to show through it: `coversEyes` is
  // false and the band's centre row leaves the eye cells bare, so the eyes sit on top of cloth rather
  // than behind it.
  { id: 'tears.3', accessory: 'tears', variant: 2, label: 'Tears', group: 'Eyewear' },
  { id: 'eyelashes.1', accessory: 'eyelashes', variant: 0, label: 'Eyelashes', group: 'Eyewear' },
  { id: 'bandana.1', accessory: 'bandana', variant: 0, label: 'Eye bandana, brown', group: 'Eyewear' },
  { id: 'bandana.2', accessory: 'bandana', variant: 1, label: 'Eye bandana, red', group: 'Eyewear' },
  { id: 'scientist.1', accessory: 'scientist', variant: 0, label: 'Scientist', group: 'Eyewear' },

  // Worn on the head.
  { id: 'crown.1', accessory: 'crown', variant: 0, label: 'Crown', group: 'Headwear' },
  { id: 'halo.1', accessory: 'halo', variant: 0, label: 'Halo', group: 'Headwear' },
  { id: 'horns.1', accessory: 'horns', variant: 0, label: 'Horns', group: 'Headwear' },
  { id: 'roundHat.1', accessory: 'roundHat', variant: 0, label: 'Round hat, brown', group: 'Headwear' },
  { id: 'roundHat.2', accessory: 'roundHat', variant: 1, label: 'Round hat, white', group: 'Headwear' },
  { id: 'skaterHat.1', accessory: 'skaterHat', variant: 0, label: 'Skater hat', group: 'Headwear' },
  { id: 'headphones.1', accessory: 'headphones', variant: 0, label: 'Headphones', group: 'Headwear' },

  // Marks and accessories on the face itself.
  { id: 'starSticker.1', accessory: 'starSticker', variant: 0, label: 'Star sticker', group: 'Marks' },
  { id: 'blushing.1', accessory: 'blushing', variant: 0, label: 'Blushing', group: 'Marks' },
  { id: 'flower.1', accessory: 'flower', variant: 0, label: 'Flower, red', group: 'Marks' },
  { id: 'flower.2', accessory: 'flower', variant: 1, label: 'Flower, violet', group: 'Marks' },
  { id: 'flower.3', accessory: 'flower', variant: 2, label: 'Flower, yellow', group: 'Marks' },
];

// The assignment itself lives in `mosaicBodies`: the default map, the storage key and the parse
// rules are what the save path and this page have to agree about, so they are kept together.

const SIZES = [30, 64, 160] as const;
const MOODS: readonly BallMood[] = ['idle', 'busy', 'thinking', 'error'];

function useFaceArt(seed: string, shapeName: string, hueSeed: number) {
  return React.useMemo(() => {
    // The hue seed rotates the identity's colour seed, which changes every cell's pigment while the
    // silhouette and the accessory stay put. `mosaicField` does the rest.
    const base = seedIdentity(seed);
    const identity: AvatarIdentity = {
      ...base,
      shapeName,
      // The silhouette, not the seed, decides the cells. `mosaicGeometry` picks mirroring and colour
      // bands from `shapeSeed`, which is the face id — so the same silhouette was drawn two ways
      // depending on which face wore it, and a face's pixels could sit on a body in the card and off
      // it in the fit check. Fixing the seed to `face-body` (the one `useGridFacts` uses) means one
      // body shape has one cell layout, and both callers measure the same thing. It also keeps a
      // body stable while its selector is used: only the silhouette moves.
      shapeSeed: 'face-body',
      colorSeed: `${base.colorSeed ?? seed}:hue-${hueSeed}`,
      colorIndex: undefined,
      color: undefined,
    };
    const geometry = mosaicGeometry(identity);
    const field = mosaicField(mosaicBaseHex(identity), geometry.cells, identity.colorSeed, mosaicSurfaces(0));
    return {
      tiles: geometry.cells.map((cell, index) => ({ ...cell, fill: field.colors[index] })),
      eyes: geometry.eyes,
      errorEyes: geometry.errorEyes,
    };
  }, [seed, shapeName, hueSeed]);
}

function Face({ entry, shapeName, size, mood, hueSeed }: { entry: Entry; shapeName: string; size: number; mood: BallMood; hueSeed: number }) {
  const art = useFaceArt(entry.id, shapeName, hueSeed);
  const variant = entry.accessory ? MOSAIC_ACCESSORIES[entry.accessory].variants[entry.variant] : null;
  const pixels = variant?.pixels ?? [];
  /**
   * The head moves; the garment and the eyes do not.
   *
   * `FACE_BODY_SHIFT` exists so a face can sit its *body* lower without redrawing the accessory —
   * the horns need this because they already occupy row 0, the topmost drawable row. The eyes belong
   * to the head, so they take the same shift; the accessory pixels stay at the coordinates they were
   * drawn at, which is what makes the garment read as higher.
   */
  const bodyShift = FACE_BODY_SHIFT[entry.id] ?? 0;
  const eyes = (mood === 'error' ? art.errorEyes : art.eyes).map((eye) => ({ ...eye, y: eye.y + bodyShift }));

  return (
    <div
      className="blob blob-mosaic"
      data-mood={mood}
      aria-hidden="true"
      style={{ width: size, height: size, '--mosaic-eye-delay': '0s', '--mosaic-gaze-step': '1px' } as React.CSSProperties}
    >
      <div className="mosaic-step" style={{ animationDelay: '0s' }}>
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <g transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
            {art.tiles.map(({ x, y, fill }) => (
              <rect key={`t-${x}:${y}`} x={x} y={y + bodyShift} width={1} height={1} fill={fill} />
            ))}
            {mood === 'thinking'
              ? art.tiles.map(({ x, y }) => (
                  <rect key={`th-${x}:${y}`} className="mosaic-thought" x={x} y={y + bodyShift} width={1} height={1}
                    fill="#fffdf5" opacity={0} style={{ animationDelay: `${-((x + (y % 3)) * 0.18)}s` }} />
                ))
              : null}
            {pixels.map(([x, y, fill, anim], index) => (
              <rect
                key={`a-${index}`}
                className={anim ? `mosaic-anim-${anim === 'screenIdle' ? 'screen-idle' : anim}` : undefined}
                x={x} y={y} width={1} height={1} fill={fill}
              />
            ))}
            {variant?.coversEyes ? null : (
              <g className="mosaic-eyes">
                {eyes.map(({ x, y }) => (
                  <g key={`eye-${x}`}>
                    <g className="mosaic-eye-open">
                      <rect x={x} y={y} width={mood === 'error' ? 3 : 2} height={mood === 'error' ? 3 : 1} fill="#fffdf5" />
                      {mood === 'error' ? (
                        <g className="mosaic-error-eye" fill="#14111a">
                          {[[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]].map(([dx, dy]) => (
                            <rect key={`${dx}:${dy}`} x={x + dx} y={y + dy} width={1} height={1} />
                          ))}
                        </g>
                      ) : (
                        <rect x={x} y={y} width={1} height={1} fill="#14111a" />
                      )}
                    </g>
                    <rect className="mosaic-eye-closed" x={x} y={y} width={mood === 'error' ? 3 : 2} height={1} fill="#14111a" opacity={0} />
                  </g>
                ))}
              </g>
            )}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** Read the persisted overrides, tolerating a browser with storage disabled. */
const initialBodies = (): Record<string, string> => {
  try {
    return resolveBodies(readBodyOverrides(window.localStorage.getItem(FACE_BODY_KEY)));
  } catch {
    return resolveBodies({});
  }
};

/** The working drawing, restored from `localStorage`. Same shape the editor's canvas uses. */
const initialDrawing = (): DrawingPixel[] => {
  try {
    return parsePixels(JSON.parse(window.localStorage.getItem(DRAWING_KEY) ?? '[]'));
  } catch {
    return [];
  }
};

const initialDrawFace = (): string | null => {
  try {
    return window.localStorage.getItem(DRAWING_FACE_KEY);
  } catch {
    return null;
  }
};

/**
 * The page.
 *
 * Two jobs under one header: the ship list, where each face's body can be reassigned, and the
 * drawing bench, where a new face is made and saved. They share the body map — the editor saves it
 * alongside the drawing — so they live in one component rather than two roots.
 */
function App() {
  const facts = useGridFacts();
  const [mood, setMood] = React.useState<BallMood>('idle');
  /**
   * A hue seed, not a body choice.
   *
   * What a viewer wants to vary freely is colour: the same face in a different hue is the same face.
   * The body is a different matter — it is part of the composition — which is why it is assigned per
   * face (below) rather than set globally for the page.
   */
  const [hueSeed, setHueSeed] = React.useState(1);
  const [copied, setCopied] = React.useState<string | null>(null);

  /**
   * Which body each face is built on: defaults, with the page's overrides on top.
   *
   * Kept in state rather than read from storage on every render so a change re-renders the card it
   * belongs to and the distribution row in the same pass.
   */
  const [bodies, setBodies] = React.useState<Record<string, string>>(initialBodies);

  const assignBody = (id: string, body: string) => {
    setBodies((previous) => {
      const next = { ...previous, [id]: body };
      try {
        window.localStorage.setItem(FACE_BODY_KEY, JSON.stringify(next));
      } catch {
        // Storage disabled: the choice holds for this session, which is still better than nothing.
      }
      return next;
    });
  };

  const copy = async (label: string, text: string) => {
    // Through the app's helper: plain http:// over the tailnet is not a secure context, so the
    // async Clipboard API is undefined there and a direct call fails silently.
    setCopied((await copyText(text)) ? label : null);
    window.setTimeout(() => setCopied(null), 1600);
  };

  /**
   * Faces per body, and the bodies with none.
   *
   * Recomputed from the live `bodies` map rather than a constant, because that is the whole point of
   * the picker: moving a face off a silhouette is how one ends up unused, and that has to be visible
   * the moment it happens rather than at the next reload.
   */
  const distribution = React.useMemo(() => {
    const counts = new Map<string, number>(MOSAIC_SHAPES.map((s) => [s.name, 0]));
    for (const entry of SHIP_LIST) {
      const body = bodies[entry.id];
      if (body && counts.has(body)) counts.set(body, (counts.get(body) ?? 0) + 1);
    }
    const empty = [...counts.entries()].filter(([, n]) => n === 0).map(([name]) => name);
    return { counts: [...counts.entries()], empty };
  }, [bodies]);

  /**
   * How many of a face's pixels land where its body has no cell.
   *
   * Counted, not forbidden. A brim that floats clear of a narrow head is sometimes the drawing, and a
   * picker that refused the assignment would be a picker that cannot be used to judge one. The count
   * is the evidence: it is the difference between "this looks wrong" and "seven pixels are off the
   * body", and it changes as the body changes.
   */
  const misfits = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of SHIP_LIST) {
      const body = bodies[entry.id];
      if (!body) continue;
      const art = entry.accessory ? MOSAIC_ACCESSORIES[entry.accessory].variants[entry.variant] : null;
      // The art is stored as `[x, y, colour]` tuples for readability; the fit check only needs the
      // cell, so it is handed the first two slots rather than a converted copy of the whole drawing.
      const cells = (art?.pixels ?? []).map(([x, y]) => ({ x, y }));
      counts.set(entry.id, pixelsOffBody(cells, facts, body).length);
    }
    return counts;
  }, [bodies, facts]);

  /** The drawing bench: the drawing, the face it is for, and whether it covers the eyes. */
  const [pixels, setPixels] = React.useState<DrawingPixel[]>(initialDrawing);
  const [drawFace, setDrawFace] = React.useState<string | null>(initialDrawFace);
  const [covering, setCovering] = React.useState(false);

  const updatePixels = (next: GridPixel[]) => {
    setPixels(next);
    try {
      window.localStorage.setItem(DRAWING_KEY, JSON.stringify(next));
    } catch {
      // Storage disabled: the drawing still works for this session.
    }
  };

  const updateDrawFace = (face: string) => {
    const value = face === '' ? null : face;
    setDrawFace(value);
    try {
      if (value === null) window.localStorage.removeItem(DRAWING_FACE_KEY);
      else window.localStorage.setItem(DRAWING_FACE_KEY, value);
    } catch {
      // Storage disabled: the face holds for this session.
    }
  };

  /**
   * Send a drawing and the body assignments to `serve.sh`.
   *
   * The bodies travel with every save because the file is meant to be the export: a `drawings.json`
   * that held the art but not the assignments would describe half of what was decided here, and the
   * half it dropped is the one that cannot be recovered by re-drawing.
   *
   * Every failure gets a sentence, not a spinner: `file://` has no origin to POST to, a plain static
   * server answers 501 to POST, and `serve.sh` writes 400 when it dislikes the body. The message says
   * which of those it was and names `serve.sh`, and the editor's Copy and Download stay available
   * either way.
   */
  const saveDrawing = async (drawing: SavedDrawing): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (window.location.protocol === 'file:') {
      return {
        ok: false,
        message: 'Opened from a file, so there is nowhere to POST. Run scripts/face-designer/serve.sh and '
          + 'open the page it prints. Copy as code and Download JSON still work.',
      };
    }
    const body = JSON.stringify({
      _note: "The Mosaic face designer's saved drawings and body assignments.",
      drawings: { [drawing.name]: drawing },
      bodies,
      bodiesAt: new Date().toISOString(),
    });
    // A hung POST would leave the button spinning with no explanation, which is the failure mode this
    // control exists to end. Twelve seconds is far longer than a loopback write ever takes.
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 12_000);
    try {
      const response = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: abort.signal,
      });
      if (response.status === 501 || response.status === 405) {
        return {
          ok: false,
          message: 'This server does not accept saves — it is a plain static server. Run '
            + 'scripts/face-designer/serve.sh instead. Copy as code and Download JSON still work.',
        };
      }
      if (!response.ok) {
        return { ok: false, message: `The save was refused (HTTP ${response.status}). Check the serve.sh terminal.` };
      }
      return { ok: true };
    } catch (problem) {
      const aborted = problem instanceof DOMException && problem.name === 'AbortError';
      return {
        ok: false,
        message: aborted
          ? 'The save timed out with no answer. Check that scripts/face-designer/serve.sh is running.'
          : 'Could not reach the save endpoint. Serve this page with scripts/face-designer/serve.sh — '
            + 'Copy as code and Download JSON still work.',
      };
    } finally {
      window.clearTimeout(timer);
    }
  };

  const groups: Entry['group'][] = ['Face', 'Eyewear', 'Headwear', 'Marks'];

  return (
    <div className="mosaic-faces">
      <header>
        <h1>The face set</h1>
        <p>
          {SHIP_LIST.length} faces. Each is built on one body, chosen for the drawing — but the choice
          is yours to change: pick a silhouette on a card and it redraws. Roll the hue to see a face
          in a different light.
        </p>
        <div className="controls">
          <div className="control-group">
            <span className="control-label">Mood</span>
            {MOODS.map((entry) => (
              <button key={entry} type="button" className={entry === mood ? 'control on' : 'control'}
                onClick={() => setMood(entry)} aria-pressed={entry === mood}>{entry}</button>
            ))}
          </div>
          <div className="control-group">
            <span className="control-label">Colour</span>
            <button type="button" className="control" onClick={() => setHueSeed((n) => n + 1)}>
              Roll hue
            </button>
            <button type="button" className="control" onClick={() => setHueSeed(1)}>Reset</button>
            <code className="keep-list">seed {hueSeed}</code>
          </div>
          <div className="control-group keeps">
            <button type="button" className="control"
              onClick={() => void copy('names', SHIP_LIST.map((e) => e.label).join('\n'))}>
              {copied === 'names' ? 'Copied' : 'Copy names'}
            </button>
            {/*
              The assignment as a pasteable `FACE_BODY` map. The picker is how it is decided; this is
              how the decision gets back into code, since nothing here writes to source files.
            */}
            <button type="button" className="control"
              onClick={() => void copy('bodies', bodiesToCode(bodies))}>
              {copied === 'bodies' ? 'Copied' : 'Copy body map'}
            </button>
            <button type="button" className="control" onClick={() => {
              const reset = resolveBodies({});
              setBodies(reset);
              try {
                window.localStorage.removeItem(FACE_BODY_KEY);
              } catch {
                // Nothing to clean up if storage was never writable.
              }
            }}>
              Reset bodies
            </button>
          </div>
        </div>

        <div className="distribution">
          <span className="control-label">Bodies</span>
          {distribution.counts.map(([name, count]) => (
            <span key={name} className={count === 0 ? 'body-count empty' : 'body-count'}>
              {name} <strong>{count}</strong>
            </span>
          ))}
          {distribution.empty.length > 0 ? (
            <span className="body-warning">
              No face uses {distribution.empty.join(', ')} — those shapes will never appear. Draw
              something for them.
            </span>
          ) : null}
        </div>
      </header>

      {groups.map((group) => {
        const entries = SHIP_LIST.filter((entry) => entry.group === group);
        if (entries.length === 0) return null;
        return (
          <section key={group}>
            <h2>{group}<span className="variant-count">{entries.length}</span></h2>
            <div className="variant-row">
              {entries.map((entry) => (
                <article key={entry.id} className="variant">
                  <div className="variant-head">
                    <strong>{entry.label}</strong>
                    {/*
                      A select, not a button row: six options would be six chips on every one of
                      sixteen cards, and the current body is the only thing worth reading at a
                      glance. The label is per-card so a screen reader announces which face it moves.
                    */}
                    <label className="body-picker">
                      <span className="visually-hidden">{entry.label} body</span>
                      <select
                        value={bodies[entry.id]}
                        onChange={(event) => assignBody(entry.id, event.target.value)}
                        aria-label={`${entry.label} body`}
                      >
                        {BODY_NAMES.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="variant-sizes">
                    {SIZES.map((size) => (
                      <div key={size} className="size-cell">
                        <Face entry={entry} shapeName={bodies[entry.id]} size={size} mood={mood} hueSeed={hueSeed} />
                      </div>
                    ))}
                  </div>
                  {/*
                    A warning, not a block. The pixels themselves are the evidence — "4 pixels float
                    off this body" is actionable, where a red border is not.
                  */}
                  {(misfits.get(entry.id) ?? 0) > 0 ? (
                    <p className="misfit">
                      {misfits.get(entry.id)} pixel{misfits.get(entry.id) === 1 ? '' : 's'} fall off{' '}
                      {bodies[entry.id]} — the drawing was made for a wider body.
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        );
      })}

      <section>
        <h2>
          Draw a face
          <span className="variant-count">paint · save to disk · load one back</span>
        </h2>
        <div className="bench">
          <div className="bench-head">
            {/*
              A face is chosen here so a save can be matched to a ship-list entry later: the file
              records it, and Load lists it. It stays a plain select because the drawing does not
              depend on it — the preview below shows every body regardless.

              This select is also how "no face" is expressed, rather than a separate checkbox that
              could be ticked while the select sat disabled underneath it — a control that cannot be
              undone is worse than no control.
            */}
            <label className="body-picker">
              <span className="control-label">For</span>
              <select
                value={drawFace ?? ''}
                onChange={(event) => updateDrawFace(event.target.value)}
                aria-label="The face this drawing is for"
              >
                <option value="">choose a face</option>
                {SHIP_LIST.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
            </label>
            {drawFace ? (
              <span className="bench-hint">
                Draws on {bodies[drawFace]}; save writes that face to drawings.json.
              </span>
            ) : null}
          </div>
          <PixelEditor
            universal={facts.universal}
            anywhere={facts.anywhere}
            eyeCells={facts.eyeCells}
            bodyCells={facts.bodyCells}
            pixels={pixels}
            onChange={updatePixels}
            label={drawFace ? (SHIP_LIST.find((entry) => entry.id === drawFace)?.label ?? drawFace) : 'your drawing'}
            face={drawFace}
            covering={covering}
            onCoveringChange={setCovering}
            onSave={saveDrawing}
          />
          <div className="draw-preview">
            <span className="tool-label">On every body</span>
            <div className="preview-grid">
              {MOSAIC_SHAPES.map((shape) => {
                const cells = facts.perBody.get(shape.name) ?? new Set<string>();
                const lost = pixels.filter((pixel) => !cells.has(cellKey(pixel.x, pixel.y))).length;
                return (
                  <div key={shape.name} className="preview-cell">
                    {/* Both sizes: 30px is the rail, where a feature either reads or does not; 160px
                        is where the drawing itself can be judged. */}
                    <div className="preview-sizes">
                      <DrawnFace
                        shapeName={shape.name}
                        pixels={pixels}
                        covering={covering}
                        size={30}
                      />
                      <DrawnFace
                        shapeName={shape.name}
                        pixels={pixels}
                        covering={covering}
                        size={160}
                      />
                    </div>
                    <span>
                      {shape.name}
                      {lost > 0 ? <em className="misfit-count"> {lost} off</em> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * The body map as the `FACE_BODY` literal it replaces.
 *
 * The picker changes what the page draws, but the shipping app reads `mosaicBodies.FACE_BODY`, so a
 * decision made here is only done when it is back in code. Emitting the literal rather than a list of
 * diffs means there is one obvious thing to paste over the old map.
 */
const bodiesToCode = (bodies: Readonly<Record<string, string>>): string =>
  'const FACE_BODY: Record<string, string> = {\n'
  + SHIP_LIST.map((entry) => `  ${entry.id.includes('-') || entry.id.includes('.') ? `'${entry.id}'` : entry.id}: '${bodies[entry.id]}',`)
    .join('\n')
  + '\n};\n';

/**
 * One body with the working drawing on it.
 *
 * Drawn locally rather than through `Face` because a drawing in progress is not a ship-list entry:
 * it has pixels and a `coversEyes` flag, and no accessory key to look up.
 */
function DrawnFace({
  shapeName,
  pixels,
  covering,
  size,
}: {
  shapeName: string;
  pixels: readonly DrawingPixel[];
  covering: boolean;
  size: number;
}) {
  const art = useFaceArt('draw-preview', shapeName, 1);
  return (
    <div className="blob blob-mosaic" data-mood="idle" style={{ width: size, height: size }}>
      <div className="mosaic-step">
        <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
          <g transform="translate(8 1) scale(7)" shapeRendering="crispEdges">
            {art.tiles.map(({ x, y, fill }) => (
              <rect key={`t-${x}:${y}`} x={x} y={y} width={1} height={1} fill={fill} />
            ))}
            {pixels.map(({ x, y, fill, anim }, index) => (
              <rect
                key={`d-${index}`}
                className={anim ? `mosaic-anim-${anim === 'screenIdle' ? 'screen-idle' : anim}` : undefined}
                x={x}
                y={y}
                width={1}
                height={1}
                fill={fill}
              />
            ))}
            {covering ? null : art.eyes.map(({ x, y }) => (
              <g key={`eye-${x}`}>
                <rect x={x} y={y} width={2} height={1} fill="#fffdf5" />
                <rect x={x} y={y} width={1} height={1} fill="#14111a" />
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
