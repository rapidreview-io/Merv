import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run after build. Change only generated manifests, never the source workspaces.
const root = resolve(process.argv[2] ?? '.');
for (const name of readdirSync(`${root}/packages`)) {
  const manifest = JSON.parse(readFileSync(`${root}/packages/${name}/package.json`, 'utf8'));
  const exports = Object.fromEntries(
    Object.entries(manifest.exports).map(([key, target]) => {
      if (typeof target !== 'string' || !target.startsWith('./src/') || !target.endsWith('.ts')) {
        throw new Error(`Unsupported runtime export in ${manifest.name}`);
      }
      return [key, target.slice(0, -3) + '.js'];
    }),
  );
  mkdirSync(`${root}/dist/packages/${name}`, { recursive: true });
  writeFileSync(
    `${root}/dist/packages/${name}/package.json`,
    JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
  );
}
cpSync(`${root}/config`, `${root}/dist/config`, { recursive: true });
