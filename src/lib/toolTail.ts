/**
 * The tail of a **running** tool call's output, for the compact block under its row.
 *
 * Hearth streams a command's output as it appears (`api.output()` in the bash tool), keeps the
 * retained tail in `pi.live`'s tool slot, and the stream sends it as `set`/`append` deltas. Ember
 * already maps that slot onto the call (`piEntriesToMessages`), so the output is on screen the whole
 * time — behind an expand click, which nobody makes while watching a spinner. A command that waits
 * for a file for nine minutes showed nothing at all until it finished.
 *
 * This is the part worth showing without being asked: the last few lines, each capped, so a single
 * enormous log line cannot push the composer off the screen. It is deliberately not a preview of the
 * *whole* output — the expanded row has that, and the settled result replaces this block in place
 * (same `call.output`, so nothing blinks out).
 */
export const LIVE_TAIL_LINES = 3;
/** A single line longer than this is cut; a wrapped tail of one 4,000-character line is unreadable. */
export const LIVE_TAIL_LINE_CHARS = 200;

/**
 * The last `lines` lines of `output`, newest last, or `[]` when there is nothing to show.
 *
 * Carriage returns are treated as newlines: a progress display rewrites one line with `\r`, and
 * letting that through renders the whole history mangled into one line.
 */
export const liveOutputTail = (
  output: string,
  options: { lines?: number; lineChars?: number } = {}
): string[] => {
  const lines = options.lines ?? LIVE_TAIL_LINES;
  const lineChars = options.lineChars ?? LIVE_TAIL_LINE_CHARS;
  if (!output) return [];
  const normalised = output.replace(/\r\n?/g, '\n');
  const all = normalised.split('\n');
  // A trailing newline is the end of the last line, not the start of an empty one.
  while (all.length > 0 && all[all.length - 1].trim() === '') all.pop();
  if (all.length === 0) return [];
  return all.slice(-Math.max(1, lines)).map((line) =>
    line.length > lineChars ? `${line.slice(0, lineChars - 1)}…` : line
  );
};
