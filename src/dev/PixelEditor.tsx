import * as React from 'react';
import { PALETTE } from './pixelPalette';
import { copyText } from '../lib/clipboard';
import {
  codeBlock,
  defaultDrawingName,
  DRAWING_NAME_KEY,
  parseDrawing,
  parsePixels,
  type DrawingPixel,
  type DrawingsFile,
  type SavedDrawing,
} from './mosaicDrawing';
import type { MosaicAnim } from '../blob/mosaicAccessories';
import type { GridFacts } from './mosaicFit';

// The grid facts are in `mosaicFit` so the face set can count fitted pixels with the same pass.
// Re-exported here because every caller of this component has always imported them from it.
export { useGridFacts } from './mosaicFit';

/**
 * A pixel editor for one Mosaic accessory, on the body's own 12-wide grid.
 *
 * Three verbs, because that is what drawing here actually needs: **put** a colour on a cell, change
 * the colour being put, and **erase** a cell. Everything else is in service of those — a palette with
 * recent colours so a drawing does not drift into fifteen near-identical browns, a live preview on
 * every silhouette so a garment that looks right on `tuft` is not hanging off `sprig`, and an export
 * in exactly the shape `MOSAIC_ACCESSORIES` stores so a finished drawing can be pasted straight in.
 *
 * ## What the grid shows
 *
 * The 12×12 box is the body's coordinate space, not the whole avatar: rows 1–12 as
 * `mosaicGeometry` builds them, columns 0–11. Cells are tinted by their status so the constraint is
 * visible while drawing rather than discovered afterwards:
 *
 *   - **solid** — a cell the body always has; safe to draw on any silhouette
 *   - **hatched** — a cell only some silhouettes have; a pixel here floats off a narrow body
 *   - **eye** — the eye cells, marked because a garment that does not `coversEyes` must keep clear
 *
 * The reference body behind the grid is drawn faintly, so the silhouette is legible without
 * competing with the art being drawn.
 */

/**
 * One cell being edited. `anim` is the record's closed set, imported rather than re-spelled, so a
 * new animation can never be drawable here and unsaveable there.
 */
export type GridPixel = { x: number; y: number; fill: string; anim?: MosaicAnim };

const COLS = 12;
/**
 * Rows 0 and 13 are drawable even though no body has cells there.
 *
 * The bodies occupy rows 1–12, but the renderer's grid group is `translate(8 1) scale(7)` inside a
 * 100×100 viewBox, so grid row 0 lands at 1px from the top and row 13 at 92px — both on screen. A
 * hat brim or a dangling charm needs that margin, and leaving it out of the editor meant the only
 * cells you could reach were the ones the body already fills.
 */
const FIRST_ROW = 0;
const LAST_ROW = 13;
const ROWS = LAST_ROW - FIRST_ROW + 1;

/** How many recent colours to remember. */
const RECENT_LIMIT = 12;

type Props = {
  /** Cells the body always has, from the six silhouettes' intersection. */
  universal: ReadonlySet<string>;
  /** Every cell any body has. */
  anywhere: ReadonlySet<string>;
  /** Eye cells across all bodies. */
  eyeCells: ReadonlySet<string>;
  /** The reference silhouette, for context behind the grid. */
  bodyCells: ReadonlySet<string>;
  /** The drawing being edited. */
  pixels: readonly GridPixel[];
  onChange: (pixels: GridPixel[]) => void;
  /** Where the drawing came from, for the export note. */
  label: string;
  /**
   * The ship-list face this drawing is for, when the host page knows one.
   *
   * Optional on purpose: the editor is also a scratch pad for a drawing that does not belong to a
   * face yet. A save without it is still valid, and the file records `face: null` rather than
   * guessing from the name.
   */
  face?: string | null;
  /** True when the art paints over the eye row. Persisted, so a reload does not re-open the eyes. */
  covering: boolean;
  onCoveringChange: (covering: boolean) => void;
  /**
   * Send the drawing and the body assignments to `serve.sh`.
   *
   * Owned by the page rather than this component: the same POST carries the body map, which is the
   * face set's state, not the canvas's. Returning a message lets this component say what happened
   * without knowing where the file went.
   */
  onSave?: (drawing: SavedDrawing) => Promise<{ ok: true } | { ok: false; message: string }>;
};

const key = (x: number, y: number): string => `${x},${y}`;

export default function PixelEditor({
  universal,
  anywhere,
  eyeCells,
  bodyCells,
  pixels,
  onChange,
  label,
  face = null,
  covering,
  onCoveringChange,
  onSave,
}: Props) {
  const [colour, setColour] = React.useState<string>('#14111a');
  const [erasing, setErasing] = React.useState(false);
  const [recent, setRecent] = React.useState<string[]>([]);
  const [drawing, setDrawing] = React.useState(false);
  const history = React.useRef<GridPixel[][]>([]);
  const [canUndo, setCanUndo] = React.useState(false);

  const byCell = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const pixel of pixels) map.set(key(pixel.x, pixel.y), pixel.fill);
    return map;
  }, [pixels]);

  const commit = (next: GridPixel[], remember = true) => {
    if (remember) {
      history.current.push([...pixels]);
      if (history.current.length > 60) history.current.shift();
      setCanUndo(true);
    }
    onChange(next);
  };

  const apply = (x: number, y: number) => {
    const at = byCell.get(key(x, y));
    if (erasing) {
      if (at === undefined) return;
      commit(pixels.filter((pixel) => !(pixel.x === x && pixel.y === y)));
      return;
    }
    if (at === colour) return;
    const rest = pixels.filter((pixel) => !(pixel.x === x && pixel.y === y));
    commit([...rest, { x, y, fill: colour }]);
    setRecent((previous) => {
      const next = [colour, ...previous.filter((entry) => entry !== colour)];
      return next.slice(0, RECENT_LIMIT);
    });
  };

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    setCanUndo(history.current.length > 0);
    onChange(previous);
  };

  const [copied, setCopied] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [importNote, setImportNote] = React.useState<string | null>(null);

  /**
   * `coversEyes` is part of the drawing, not a note about it: pasting the export back must produce
   * the same render, and whether the eyes are skipped is the difference between a mask and a pair of
   * glasses. The same function feeds the copy button, the download and the saved record, so the three
   * cannot describe the drawing differently.
   */
  const exportJson = React.useMemo(
    () => codeBlock({ name: label, coversEyes: covering, pixels: [...pixels] }),
    [pixels, label, covering],
  );

  /** The name this drawing is saved under, and what the last save said. */
  const [saveName, setSaveName] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem(DRAWING_NAME_KEY) ?? defaultDrawingName(face);
    } catch {
      return defaultDrawingName(face);
    }
  });
  const [saveNote, setSaveNote] = React.useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  /**
   * Saved drawings, once they have been listed.
   *
   * `null` means "not asked yet" and `[]` means "asked, and the file has none" — the difference is
   * what lets the Load button say *why* it has nothing to show instead of looking broken.
   */
  const [saved, setSaved] = React.useState<SavedDrawing[] | null>(null);
  const [loadNote, setLoadNote] = React.useState<string | null>(null);

  /**
   * Where the save endpoint is.
   *
   * Relative, so the page works under `serve.sh` on any port and on any host. On `file://` there is
   * no origin to resolve against and the fetch throws before it leaves the browser; that is caught
   * where the POST happens, not here, because the same explanation covers both cases.
   */
  const saveDrawing = async () => {
    if (!onSave) {
      setSaveNote({ kind: 'warn', text: 'This page has no save endpoint wired up.' });
      return;
    }
    if (pixels.length === 0) {
      setSaveNote({ kind: 'warn', text: 'Nothing to save yet — draw something first.' });
      return;
    }
    const name = saveName.trim() || defaultDrawingName(face);
    setBusy(true);
    setSaveNote(null);
    const drawing: SavedDrawing = {
      name,
      face,
      coversEyes: covering,
      savedAt: new Date().toISOString(),
      pixels: [...pixels],
    };
    try {
      const result = await onSave(drawing);
      if (result.ok) {
        setSaveName(name);
        setSaveNote({ kind: 'ok', text: `Saved "${name}" and the body assignments to drawings.json.` });
        // The list is stale now; the next Load re-reads the file rather than this copy.
        setSaved(null);
        try {
          window.localStorage.setItem(DRAWING_NAME_KEY, name);
        } catch {
          // Storage disabled: the name still holds for this session.
        }
      } else {
        setSaveNote({ kind: 'warn', text: result.message });
      }
    } catch (problem) {
      // `onSave` reports its own failures, so anything that reaches here is a bug in the save path —
      // and a save that silently does nothing is the exact complaint this button exists to fix. Say
      // so, with the reason, rather than spinning back to idle.
      setSaveNote({
        kind: 'warn',
        text: `The save did not finish: ${problem instanceof Error ? problem.message : String(problem)}.`,
      });
    } finally {
      setBusy(false);
    }
  };

  /** Fetch `drawings.json` and list what is in it. */
  const loadList = async () => {
    setLoadNote(null);
    try {
      const response = await fetch('/drawings.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const file = (await response.json()) as DrawingsFile;
      const drawings = Object.entries(file.drawings ?? {})
        .map(([name, value]) => parseDrawing(name, value))
        .filter((entry): entry is SavedDrawing => entry !== null)
        // Newest first: the drawing being worked on is usually the one just saved.
        .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || '') || a.name.localeCompare(b.name));
      setSaved(drawings);
      if (drawings.length === 0) setLoadNote('drawings.json exists but holds no drawings yet.');
    } catch {
      setSaved(null);
      setLoadNote(
        'Could not read drawings.json. Load needs the page served by scripts/face-designer/serve.sh — '
        + 'on file:// or a plain static server the file is not there to read.',
      );
    }
  };

  const restore = (drawing: SavedDrawing) => {
    commit(parsePixels(drawing.pixels));
    onCoveringChange(drawing.coversEyes);
    setSaveName(drawing.name);
    setLoadNote(`Loaded "${drawing.name}" — ${drawing.pixels.length} pixels.`);
  };

  /**
   * Paste a `pixels: [...]` block (or just the array) and draw on it.
   *
   * Drawings arrive one at a time, and splicing each into `mosaicAccessories.ts` by hand while the
   * next is still being drawn is both slow and a build-break waiting to happen — one wrong brace and
   * the page stops loading mid-session. Accepting the pasted block here means a drawing can be
   * checked, corrected and exported without touching source at all.
   *
   * The parser is deliberately forgiving: it scans for `[x, y, 'hex']` triples anywhere in the text,
   * so the comment lines, the `note:` and the `coversEyes:` wrapper are all optional and ignored.
   */
  const applyImport = () => {
    const found: GridPixel[] = [];
    // The colour is a single quoted run that must not contain a quote of its own kind; the fourth
    // slot is an optional quoted animation name. Matching the colour lazily (`[^'"]+`) matters: a
    // greedy run swallowed `', 'screen` into the fill and produced `#fffdf5', 'screen` as a colour.
    const pattern = /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(['"])([^'"]+)\3(?:\s*,\s*(['"])([a-zA-Z]+)\5)?\s*\]/g;
    for (const match of importText.matchAll(pattern)) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      if (x < 0 || x >= COLS || y < FIRST_ROW || y > LAST_ROW) continue;
      const anim = match[6] === 'screen' || match[6] === 'screenIdle' ? match[6] : undefined;
      found.push({ x, y, fill: match[4].trim(), anim });
    }
    if (found.length === 0) {
      setImportNote('No [x, y, “#hex”] triples found in that.');
      return;
    }
    // A later triple for the same cell wins, so a pasted block with duplicates lands on its last word.
    const byId = new Map<string, GridPixel>();
    for (const pixel of found) byId.set(key(pixel.x, pixel.y), pixel);
    const next = [...byId.values()];
    commit(next);
    setImportNote(`Loaded ${next.length} pixels${/coversEyes:\s*true/.test(importText) ? ' · covers eyes' : ''}.`);
    setImportText('');
  };

  /** Constraint report: pixels that will float, and pixels sitting on an eye. */
  const report = React.useMemo(() => {
    const floating = pixels.filter((pixel) => !universal.has(key(pixel.x, pixel.y)));
    const onEyes = pixels.filter((pixel) => eyeCells.has(key(pixel.x, pixel.y)));
    // Rows 0 and 13 exist in the render (the grid group is translate(8 1) scale(7) inside a 100×100
    // viewBox) but no body has cells there. Such a pixel is *outside the silhouette* rather than
    // invisible: it draws, floating clear of the body. Only a cell off the 12-column grid or past the
    // viewBox would truly not render, and the grid cannot express those.
    const offBody = pixels.filter((pixel) => !anywhere.has(key(pixel.x, pixel.y)));
    return { floating, onEyes, offBody };
  }, [pixels, universal, eyeCells, anywhere]);

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="grid-wrap">
          <div
            className="grid"
            onPointerDown={() => setDrawing(true)}
            onPointerUp={() => setDrawing(false)}
            onPointerLeave={() => setDrawing(false)}
            style={{ gridTemplateColumns: `repeat(${COLS}, 26px)` }}
          >
            {Array.from({ length: ROWS }, (_, row) =>
              Array.from({ length: COLS }, (_, col) => {
                const x = col;
                const y = row + FIRST_ROW;
                const id = key(x, y);
                const fill = byCell.get(id);
                const status = eyeCells.has(id) ? 'eye' : universal.has(id) ? 'safe' : anywhere.has(id) ? 'rare' : 'off';
                return (
                  <button
                    key={id}
                    type="button"
                    className={`cell ${status}${fill ? ' filled' : ''}`}
                    aria-label={`Column ${x}, row ${y}${status === 'off' ? ', outside every body' : ''}`}
                    title={`x ${x}, y ${y} — ${status === 'safe' ? 'every body' : status === 'rare' ? 'some bodies only' : status === 'eye' ? 'eye row' : 'outside every body'}`}
                    style={{
                      background: fill ?? undefined,
                      // The faint body behind an empty cell, so the silhouette is readable.
                      boxShadow: !fill && bodyCells.has(id) ? 'inset 0 0 0 999px rgba(0,0,0,0.05)' : undefined,
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      apply(x, y);
                    }}
                    onPointerEnter={() => {
                      if (drawing) apply(x, y);
                    }}
                  >
                    {!fill && status === 'rare' ? <span className="hatch" /> : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="grid-hint">
            <span><i className="sw safe" /> every body</span>
            <span><i className="sw rare" /> some bodies</span>
            <span><i className="sw eye" /> eye row</span>
            <span><i className="sw off" /> outside</span>
          </div>
        </div>

        <div className="tools">
          <div className="tool-row">
            <span className="tool-label">Colour</span>
            <input
              type="color"
              value={colour}
              onChange={(event) => {
                setColour(event.target.value);
                setErasing(false);
              }}
              aria-label="Drawing colour"
              className="colour-input"
            />
            <code className="colour-hex">{colour}</code>
            <button
              type="button"
              className={erasing ? 'control on' : 'control'}
              onClick={() => setErasing((value) => !value)}
              aria-pressed={erasing}
            >
              Eraser
            </button>
            <button type="button" className="control" onClick={undo} disabled={!canUndo}>
              Undo
            </button>
          </div>

          {/*
            The palette as a matrix: one row per base colour, one column per relationship. Reading
            down a column gives the same relationship across every hue, which is what makes it a
            system rather than a heap of swatches.
          */}
          <div className="palette">
            <div className="palette-head">
              <span />
              <span>base</span>
              <span>darker</span>
              <span>quieter</span>
            </div>
            {PALETTE.map((row) => (
              <div key={row.name} className="palette-row">
                <span className="palette-name">{row.name}</span>
                {row.swatches.map((entry, index) => (
                  <button
                    key={`${row.name}-${index}`}
                    type="button"
                    className={entry === colour ? 'palette-cell on' : 'palette-cell'}
                    style={{ background: entry }}
                    title={`${row.name} — ${entry}${index === 0 ? ' (base)' : index === 1 ? (row.name === 'Black' || row.name === 'White' ? ' (grey)' : ' (darker)') : row.name === 'Black' || row.name === 'White' ? ' (grey)' : ' (desaturated)'}`}
                    aria-label={`${row.name} ${index === 0 ? 'base' : index === 1 ? 'darker' : 'desaturated'} ${entry}`}
                    aria-pressed={entry === colour}
                    onClick={() => {
                      setColour(entry);
                      setErasing(false);
                      setRecent((previous) => [entry, ...previous.filter((e) => e !== entry)].slice(0, RECENT_LIMIT));
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          {recent.length > 0 ? (
            <div className="tool-row swatches">
              <span className="tool-label">Recent</span>
              {recent.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={entry === colour ? 'swatch on' : 'swatch'}
                  style={{ background: entry }}
                  title={entry}
                  aria-label={`Use ${entry}`}
                  onClick={() => {
                    setColour(entry);
                    setErasing(false);
                  }}
                />
              ))}
            </div>
          ) : null}

          <div className="tool-row">
            <label className="tool-label" htmlFor="exact">Type</label>
            <input
              id="exact"
              className="hex-field"
              value={colour}
              onChange={(event) => {
                const next = event.target.value;
                setColour(next);
                setErasing(false);
              }}
              spellCheck={false}
            />
          </div>

          <div className="report">
            {report.offBody.length > 0 ? (
              <p className="warn">○ {report.offBody.length} pixel(s) clear of the body — they render, floating beside the silhouette</p>
            ) : null}
            {report.floating.length > report.offBody.length ? (
              <p className="warn">△ {report.floating.length - report.offBody.length} pixel(s) will float off a narrow body</p>
            ) : null}
            {report.onEyes.length > 0 ? (
              <p className="warn">⚠ {report.onEyes.length} pixel(s) on an eye — fine only if this covers the eyes</p>
            ) : null}
            {report.floating.length === 0 && report.onEyes.length === 0 && report.offBody.length === 0 ? (
              <p className="ok">✓ {(pixels.length)} pixels, all on safe cells</p>
            ) : null}
          </div>

          <div className="tool-row">
            {/*
              Through the app's helper, not `navigator.clipboard` directly: on plain http:// over the
              tailnet the async API is undefined or refused, so a direct call fails silently and the
              button looks dead. The helper falls back to `execCommand`.
            */}
            <button
              type="button"
              className="control"
              onClick={() => {
                void copyText(exportJson).then((ok) => {
                  setCopied(ok);
                  window.setTimeout(() => setCopied(false), 1600);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy as code'}
            </button>
            {/*
              The escape hatch that survives every failure mode. A download does not need a server,
              an origin, or a running `serve.sh` — so if Save cannot reach disk, the drawing can still
              leave the browser as a file a person can put on disk themselves.
            */}
            <button
              type="button"
              className="control"
              onClick={() => {
                const drawing: SavedDrawing = {
                  name: saveName.trim() || defaultDrawingName(face),
                  face,
                  coversEyes: covering,
                  savedAt: new Date().toISOString(),
                  pixels: [...pixels],
                };
                const blob = new Blob([JSON.stringify(drawing, null, 2) + '\n'], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${drawing.name.replace(/[^\w.-]+/g, '-')}.json`;
                link.click();
                // Revoking immediately can cancel the download in some browsers; a tick is enough.
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download JSON
            </button>
            <button
              type="button"
              className="control"
              onClick={() => commit([])}
              disabled={pixels.length === 0}
            >
              Clear canvas
            </button>
          </div>

          {/*
            Save and Load both need `serve.sh`. The name field is here rather than in a dialog because
            a name is the thing that makes a file findable later, and a save that cannot be named is a
            save that cannot be found.
          */}
          <div className="tool-row disk">
            <span className="tool-label">Disk</span>
            <input
              className="hex-field name-field"
              value={saveName}
              onChange={(event) => {
                setSaveName(event.target.value);
                setSaveNote(null);
              }}
              aria-label="Name this drawing is saved under"
              spellCheck={false}
            />
            <button
              type="button"
              className="control"
              onClick={() => void saveDrawing()}
              disabled={busy || pixels.length === 0}
            >
              {busy ? 'Saving…' : 'Save to disk'}
            </button>
            <button type="button" className="control" onClick={() => void loadList()}>
              Load from disk
            </button>
          </div>
          {saveNote ? (
            <p className={saveNote.kind === 'warn' ? 'disk-note warn' : 'disk-note ok'}>{saveNote.text}</p>
          ) : null}
          {loadNote ? <p className="disk-note">{loadNote}</p> : null}
          {saved && saved.length > 0 ? (
            <ul className="saved-list">
              {saved.map((drawing) => (
                <li key={drawing.name}>
                  <button type="button" className="control" onClick={() => restore(drawing)}>
                    Load
                  </button>
                  <strong>{drawing.name}</strong>
                  <span className="saved-meta">
                    {drawing.pixels.length} px
                    {drawing.face ? ` · ${drawing.face}` : ''}
                    {drawing.savedAt ? ` · ${drawing.savedAt.slice(0, 16).replace('T', ' ')}` : ''}
                    {drawing.coversEyes ? ' · covers eyes' : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="tool-row">
            <span className="tool-label">Paste</span>
            <textarea
              className="import"
              value={importText}
              onChange={(event) => {
                setImportText(event.target.value);
                setImportNote(null);
              }}
              placeholder="Paste a pixels: [...] block here"
              spellCheck={false}
              rows={3}
              aria-label="Paste a pixel block to load into the editor"
            />
            <button type="button" className="control" onClick={applyImport} disabled={!importText.trim()}>
              Load
            </button>
          </div>
          {importNote ? <p className="import-note">{importNote}</p> : null}

          <div className="tool-row">
            <label className="keep-box">
              <input
                type="checkbox"
                checked={covering}
                onChange={(event) => onCoveringChange(event.target.checked)}
              />
              <span>covers the eyes</span>
            </label>
          </div>
        </div>
      </div>

      <details className="export">
        <summary>Export</summary>
        <pre>{exportJson}</pre>
      </details>
    </div>
  );
}


