import { z } from 'zod';
import { envName } from '@merv/contracts';

/** What each start of the plugin read from the variable its config names, in order. */
export const reads: (string | undefined)[] = [];
export default {
  name: 'fixture-env-reader',
  Config: z.object({ keyEnv: envName.describe('Fixture calls · test service key') }).strict(),
  apply(_ctx: unknown, config: { keyEnv: string }) {
    reads.push(process.env[config.keyEnv]);
  },
};
