import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The supervisor is plain ESM so it runs without tsx or inherited process preloads.
const source = new URL('../packages/runner/src/supervisor.mjs', import.meta.url);
const destination = new URL('../dist/packages/runner/src/supervisor.mjs', import.meta.url);
mkdirSync(dirname(fileURLToPath(destination)), { recursive: true });
copyFileSync(source, destination);

// Keep the UI's relative bundle path the same for source and compiled plugins.
// Backend-only builds remain supported; a production UI build runs build:ui first.
const uiSource = new URL('../packages/ui/dist/', import.meta.url);
const uiDestination = new URL('../dist/packages/ui/dist/', import.meta.url);
if (existsSync(new URL('index.html', uiSource))) {
  mkdirSync(uiDestination, { recursive: true });
  cpSync(uiSource, uiDestination, { recursive: true });
}

const boardBundle = new URL('../packages/board/dist/renderer.js', import.meta.url);
const boardBundleDest = new URL('../dist/packages/board/dist/renderer.js', import.meta.url);
mkdirSync(dirname(fileURLToPath(boardBundleDest)), { recursive: true });
copyFileSync(boardBundle, boardBundleDest);
copyFileSync(
  new URL('../packages/board/dist/fonts.json', import.meta.url),
  new URL('../dist/packages/board/dist/fonts.json', import.meta.url),
);
