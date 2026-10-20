import type { Context } from 'cordis';
import { runScript } from './bridge.js';

export interface Scripts {
  run: typeof runScript;
}
declare module 'cordis' {
  interface Context {
    scripts: Scripts;
  }
}

export default {
  name: 'merv-scripts',
  apply(ctx: Context) {
    ctx.provide('scripts', { run: runScript } satisfies Scripts);
  },
};
