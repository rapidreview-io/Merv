import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { cpSync, createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

// The bundle is served by @merv/ui at <api>/ui; in development Vite proxies tool calls to a running server.
// The Host header is kept (no changeOrigin) so the API's same-origin check sees Origin === http://<host>.
const api = process.env.MERV_API || 'http://127.0.0.1:3081';
const proxy = Object.fromEntries(
  [
    '/tools',
    '/health',
    '/auth',
    '/account',
    '/secrets',
    '/projects',
    '/sessions',
    '/sandboxes',
    '/code',
    '/pi',
  ].map((path) => [path, { target: api }]),
);

/**
 * Excalidraw's fonts, served from this app as the board page asks for them (EXCALIDRAW_ASSET_PATH
 * in views/board-canvas.tsx) rather than from a CDN: copied beside the hashed assets in a build,
 * read from the package in development.
 */
const fonts = join(
  dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')),
  'fonts',
);
const excalidrawFonts = (): Plugin => ({
  name: 'excalidraw-fonts',
  configureServer(server) {
    server.middlewares.use('/ui/assets/excalidraw/fonts', (req, res, next) => {
      const file = join(fonts, decodeURIComponent((req.url ?? '').split('?')[0]!));
      if (!file.startsWith(fonts + sep) || !existsSync(file)) return next();
      res.setHeader('content-type', 'font/woff2');
      createReadStream(file).pipe(res);
    });
  },
  closeBundle() {
    cpSync(fonts, resolve(import.meta.dirname, 'dist/assets/excalidraw/fonts'), {
      recursive: true,
    });
  },
});

export default defineConfig({
  root: 'web',
  base: '/ui/',
  plugins: [react(), excalidrawFonts()],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  // The worker loads each grammar as its own chunk, so it is a module, as the page starts it.
  // It has no DOM, so it decodes entities from their table, not through one.
  worker: {
    format: 'es',
    plugins: () => [
      {
        name: 'worker-entities',
        enforce: 'pre' as const,
        resolveId: (id: string) =>
          id === 'decode-named-character-reference'
            ? createRequire(import.meta.url).resolve(id)
            : null,
      },
    ],
  },
  server: { port: Number(process.env.PORT) || 5180, proxy },
});
