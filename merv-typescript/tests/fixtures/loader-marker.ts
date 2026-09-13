import type { Context } from 'cordis';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { LoaderMarker } from './loader-types.js';

export const resources: LoaderMarker[] = [];
export default {
  name: 'fixture-marker',
  Config: z.object({ value: z.string(), fail: z.boolean().default(false) }).strict(),
  async apply(ctx: Context, config: { value: string; fail: boolean }) {
    await ctx.effect(async function* () {
      const marker: LoaderMarker = { value: config.value, closed: false };
      resources.push(marker);
      yield () => {
        marker.closed = true;
      };
      await delay(10);
      if (config.fail) throw new Error('Fixture initialization failed');
      yield ctx.provide('loaderMarker', marker);
    });
  },
};
