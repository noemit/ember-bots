import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';

export type AppIconResult = { ok: boolean; reason?: string };

export type AppIconDiagnosticContext = {
  platform: string;
  hasDock: boolean;
  windows: number;
  now?: () => string;
};

const DEFAULT_MAX_BYTES = 8_000;
const DEFAULT_DEBOUNCE_MS = 250;

const trimToMaxBytes = (content: string, maxBytes: number): string => {
  if (content.length <= maxBytes) return content;
  const sliced = content.slice(content.length - maxBytes);
  const newline = sliced.indexOf('\n');
  return newline >= 0 && newline + 1 < sliced.length ? sliced.slice(newline + 1) : sliced;
};

const formatDiagnosticLine = (
  result: AppIconResult,
  bytes: number,
  context: AppIconDiagnosticContext
): string =>
  [
    (context.now ?? (() => new Date().toISOString()))(),
    result.ok ? 'ok' : `failed: ${result.reason ?? 'unknown'}`,
    `bytes=${bytes}`,
    `png=${result.ok || result.reason !== 'not a png data URL'}`,
    `platform=${context.platform}`,
    `app.dock=${context.hasDock ? 'present' : 'absent'}`,
    `windows=${context.windows}`,
  ].join(' ');

/**
 * Buffered, async diagnostic writer for `<userData>/app-icon.log`.
 *
 * Avoids synchronous `readFileSync` + `writeFileSync` on Electron's main thread when the Dock/taskbar
 * icon updates, coalesces bursts onto one background write, and ignores redundant `null` issue clears
 * when no icon issue was active.
 */
export const createAppIconDiagnosticLogger = (
  getFile: () => string,
  options?: { debounceMs?: number; maxBytes?: number }
) => {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  let pendingLines: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let hasPriorIssue = false;

  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
    timer.unref?.();
  };

  const enqueueLine = (line: string) => {
    pendingLines.push(line);
    if (pendingLines.length > 200) pendingLines = pendingLines.slice(-200);
    scheduleFlush();
  };

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingLines.length === 0) return writeChain;
    const batch = `${pendingLines.join('\n')}\n`;
    pendingLines = [];
    writeChain = writeChain.then(async () => {
      try {
        const file = getFile();
        await fs.mkdir(path.dirname(file), { recursive: true });
        let previous = '';
        try {
          previous = await fs.readFile(file, 'utf8');
        } catch {
          // First write.
        }
        const next = trimToMaxBytes(`${previous}${batch}`, maxBytes);
        await fs.writeFile(file, next, 'utf8');
      } catch {
        // A diagnostic that throws would be worse than the bug it is chasing.
      }
    });
    return writeChain;
  };

  const dispose = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingLines.length === 0) return;
    const batch = `${pendingLines.join('\n')}\n`;
    pendingLines = [];
    try {
      const file = getFile();
      syncFs.mkdirSync(path.dirname(file), { recursive: true });
      let previous = '';
      try {
        previous = syncFs.readFileSync(file, 'utf8');
      } catch {
        // First write.
      }
      syncFs.writeFileSync(file, trimToMaxBytes(`${previous}${batch}`, maxBytes), 'utf8');
    } catch {
      // Never throw on shutdown.
    }
  };

  const record = <T extends AppIconResult>(
    result: T,
    bytes: number,
    context: AppIconDiagnosticContext
  ): T => {
    hasPriorIssue = !result.ok;
    enqueueLine(formatDiagnosticLine(result, bytes, context));
    return result;
  };

  const reportIssue = (
    rawReason: unknown,
    context: AppIconDiagnosticContext
  ): { ok: boolean; written: boolean } => {
    if (rawReason === null || rawReason === undefined || String(rawReason).trim() === '') {
      if (!hasPriorIssue) return { ok: true, written: false };
      hasPriorIssue = false;
      enqueueLine(formatDiagnosticLine({ ok: true }, 0, context));
      return { ok: true, written: true };
    }
    const reason = String(rawReason).slice(0, 300);
    if (!reason.startsWith('attempt ')) hasPriorIssue = true;
    enqueueLine(formatDiagnosticLine({ ok: false, reason: `renderer: ${reason}` }, 0, context));
    return { ok: true, written: true };
  };

  return { record, reportIssue, flush, dispose };
};
