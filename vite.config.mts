import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The strict CSP in index.html protects the packaged app, but in `dev:web` it blocks Vite's inline
 * react-refresh preamble, which leaves the page blank. Drop the meta only while serving.
 */
const stripCspInDev = (): Plugin => ({
  name: 'strip-csp-in-dev',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(/\s*<meta[^>]*Content-Security-Policy[^>]*>/i, '');
  },
});

/**
 * Let `vite dev` read the drawings `serve.sh` wrote.
 *
 * The designer page can be opened on either server. Save needs `serve.sh` (Vite's dev server cannot
 * write a file), but Load only reads, and a Load that 404s under `vite dev` while the file plainly
 * exists beside `serve.sh` reads as a broken load. Dev-only, and only that one file — this is not a
 * general passthrough to `scripts/`.
 */
const serveDrawingsInDev = (): Plugin => ({
  name: 'serve-face-designer-drawings',
  apply: 'serve',
  configureServer(server) {
    const drawings = fileURLToPath(new URL('./scripts/face-designer/drawings.json', import.meta.url));
    server.middlewares.use('/drawings.json', async (_request, response, next) => {
      try {
        const { readFile } = await import('node:fs/promises');
        const body = await readFile(drawings, 'utf8');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(body);
      } catch {
        // No file yet: fall through to Vite so a missing drawings.json stays an ordinary 404.
        next();
      }
    });
  },
});

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), stripCspInDev(), serveDrawingsInDev()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      /**
       * `index.html` is the app; the rest are the design pages, which are served by `vite dev` and
       * were never in the build because they were never listed. They are listed now because
       * `scripts/face-designer/serve.sh` serves a *built* page: the drawing bench mounts through a
       * module graph, so it cannot be copied out as a static file, and without an entry here the
       * built directory has no `face-designer.html` to serve — the save endpoint would answer, and
       * there would be no editor to call it.
       */
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'blob-gallery': fileURLToPath(new URL('./blob-gallery.html', import.meta.url)),
        'buddy-motion': fileURLToPath(new URL('./buddy-motion.html', import.meta.url)),
        'face-set': fileURLToPath(new URL('./face-set.html', import.meta.url)),
        'face-designer': fileURLToPath(new URL('./face-designer.html', import.meta.url)),
      },
    },
  },
  server: {
    // Dev-only: lets the browser exercise the renderer against a real Hearth on this host
    // without CORS (the e2e hearth-live test proxies through here). Same-origin for the page.
    proxy: {
      '/hearth-live': {
        target: process.env.HEARTH_LIVE_URL ?? 'http://127.0.0.1:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hearth-live/, ''),
      },
    },
  },
});
