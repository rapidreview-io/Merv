import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bundle is served by @merv/ui at <api>/ui; in development Vite proxies tool calls to a running server.
// The Host header is kept (no changeOrigin) so the API's same-origin check sees Origin === http://<host>.
const api = process.env.MERV_API || 'http://127.0.0.1:3081';
const proxy = Object.fromEntries(
  ['/tools', '/health', '/auth', '/account', '/projects', '/sessions', '/code', '/pi'].map(
    (path) => [path, { target: api }],
  ),
);

export default defineConfig({
  root: 'web',
  base: '/ui/',
  plugins: [
    react(),
    {
      name: 'merv-optional-pi',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          process.env.MERV_UI_PI === 'omit' &&
          source === './pi' &&
          importer?.endsWith('/views/index.tsx')
        )
          return '\0merv-pi-omitted';
      },
      load(id) {
        if (id === '\0merv-pi-omitted') return 'export const PiView = () => null;';
      },
    },
  ],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: { port: Number(process.env.PORT) || 5180, proxy },
});
