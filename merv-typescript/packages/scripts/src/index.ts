import type { Context } from 'cordis';
import { runScript } from './bridge.js';

export type { ScriptCall, ScriptError, ScriptHost, ScriptResult } from './bridge.js';

/** Runs agents' scripts, each in its own sandboxed child; see the README. */
export interface Scripts {
  run: typeof runScript;
}
declare module 'cordis' {
  interface Context {
    scripts: Scripts;
  }
}

export const scriptsPlugin = {
  name: 'merv-scripts',
  apply(ctx: Context) {
    ctx.provide('scripts', { run: runScript } satisfies Scripts);
  },
};
export default scriptsPlugin;
