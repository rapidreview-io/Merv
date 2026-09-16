import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The bundle is served by @merv/ui at <api>/ui; in development Vite proxies tool calls to a running server.
export default defineConfig({
  root: 'web',
  base: '/ui/',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: Number(process.env.PORT) || 5180,
    proxy: {
      '/tools': process.env.MERV_API || 'http://127.0.0.1:3081',
      '/health': process.env.MERV_API || 'http://127.0.0.1:3081',
      '/auth': process.env.MERV_API || 'http://127.0.0.1:3081',
      '/account': process.env.MERV_API || 'http://127.0.0.1:3081',
      '/projects': process.env.MERV_API || 'http://127.0.0.1:3081',
      '/sessions': process.env.MERV_API || 'http://127.0.0.1:3081',
    },
  },
});
