import type { ContinuityProvider } from '@merv/sessions/types';
import { continuousProducer, producing } from './program.js';

/** Existing experiments retain their separate stage histories; never splice old conversations. */
export const experimentContinuity: ContinuityProvider = (unit) =>
  continuousProducer(unit.version) && unit.role === 'producer' && producing(unit.state)
    ? JSON.stringify([unit.instanceId, 'experiment-producer-v44', unit.role])
    : JSON.stringify([unit.instanceId, unit.state, unit.role]);
