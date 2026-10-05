import type { LegacyHistoryReader } from './history.js';

declare module 'cordis' {
  interface Context {
    legacyHistory: LegacyHistoryReader;
  }
}
