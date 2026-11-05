import fs from 'node:fs';
import path from 'node:path';

/**
 * `ember-compact.log`: one line per manual compaction, next to `app-icon.log`.
 *
 * A compaction the host accepts and then does not perform leaves no trace anywhere — no entry, no
 * event, no refusal — so "I clicked it and nothing happened" was unanswerable without reconstructing
 * it by hand. The renderer formats the line (`src/lib/compaction.ts`, where the wording is tested)
 * and this appends it: what the host said, whether a compaction ever started, and what the
 * transcript held either side.
 */
const MAX_BYTES = 32_000;

/** Appends one line, keeping the file bounded by dropping its oldest bytes. Never throws. */
export const appendCompactLog = (file: string, line: string): void => {
  const text = line.replace(/\s+/g, ' ').trim();
  if (!text) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let previous = '';
    try {
      previous = fs.readFileSync(file, 'utf8');
    } catch {
      // First line.
    }
    const kept = previous.length > MAX_BYTES ? previous.slice(previous.length - MAX_BYTES) : previous;
    fs.writeFileSync(file, `${kept}${text}\n`, { mode: 0o600 });
  } catch {
    // A diagnostic that throws would be worse than the silence it is chasing.
  }
};
