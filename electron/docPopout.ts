import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const POPOUT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Only Ember's own local renderer HTML opened specifically with `?docPopout=1&popoutId=...`
 * may spawn an isolated read-only Electron child preview window.
 */
export const isAllowedDocPopoutUrl = (rawUrl: string, rendererHtmlPath: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.searchParams.get('docPopout') !== '1') return false;
    const popoutId = parsed.searchParams.get('popoutId') ?? '';
    if (!POPOUT_ID_PATTERN.test(popoutId)) return false;
    const cleanUrl = new URL(parsed.toString());
    cleanUrl.search = '';
    cleanUrl.hash = '';
    return path.resolve(fileURLToPath(cleanUrl)) === path.resolve(rendererHtmlPath);
  } catch {
    return false;
  }
};
