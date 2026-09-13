import type { Context } from 'cordis';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from './loader-types.js';

export default {
  name: 'fixture-consumer',
  inject: ['loaderMarker'],
  async apply(ctx: Context) {
    await delay(10);
    ctx.provide('loaderConsumer', { observed: ctx.loaderMarker.value });
  },
};
