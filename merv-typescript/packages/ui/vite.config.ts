import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

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

export default defineConfig({
  root: 'web',
  base: '/ui/',
  plugins: [react()],
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
