/** Build a self-contained Linux acceptance payload. Never copies local auth/config. */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
const destination = resolve(process.argv[2] ?? 'output/hosted-runner');
mkdirSync(destination, { recursive: true });
await build({
  entryPoints: ['scripts/hosted-runner/smoke-supervisor.ts'],
  outfile: `${destination}/smoke-supervisor.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
copyFileSync('packages/runner/src/supervisor.mjs', `${destination}/supervisor.mjs`);
writeFileSync(
  `${destination}/start`,
  '#!/bin/sh\nexec /usr/local/bin/node /opt/merv/runner/smoke-supervisor.mjs\n',
  { mode: 0o755 },
);
