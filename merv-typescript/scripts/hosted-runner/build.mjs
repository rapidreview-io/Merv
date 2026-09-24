/** Bundle hosted worker code without copying local auth/config or Pi SDK installs. */
import { createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
const destination = resolve(process.argv[2] ?? 'output/hosted-runner');
mkdirSync(destination, { recursive: true });
const inputs = new Set();
function record(result) {
  for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
}
record(
  await build({
    entryPoints: ['scripts/hosted-runner/smoke-supervisor.ts'],
    outfile: `${destination}/smoke-supervisor.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    metafile: true,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  }),
);
mkdirSync(`${destination}/pi`, { recursive: true });
record(
  await build({
    entryPoints: ['packages/pi/src/worker-main.ts'],
    outfile: `${destination}/pi/worker-main.mjs`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@earendil-works/*'],
    metafile: true,
  }),
);
copyFileSync('packages/pi/worker-runtime/package.json', `${destination}/pi/package.json`);
copyFileSync('packages/pi/worker-runtime/package-lock.json', `${destination}/pi/package-lock.json`);
copyFileSync('scripts/hosted-runner/start-runtime.py', `${destination}/start-runtime.py`);
for (const filename of ['assignment-probed.py', 'isolation_probe.py']) {
  copyFileSync(`scripts/hosted-runner/${filename}`, `${destination}/${filename}`);
}
copyFileSync('packages/runner/src/supervisor.mjs', `${destination}/supervisor.mjs`);
writeFileSync(
  `${destination}/start`,
  '#!/bin/sh\nexec /usr/bin/python3 /opt/merv/runtime/start-runtime.py\n',
  { mode: 0o755 },
);
writeFileSync(
  `${destination}/input-hashes.json`,
  JSON.stringify(
    Object.fromEntries(
      [...inputs]
        .sort()
        .map((input) => [input, createHash('sha256').update(readFileSync(input)).digest('hex')]),
    ),
    null,
    2,
  ) + '\n',
);
