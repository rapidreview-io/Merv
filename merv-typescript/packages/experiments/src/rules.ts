import { z } from 'zod';

// Experiment rules that Research and Reflections apply before they create experiments: pure, so
// they import it without depending on the Experiments service.

/** At most this many experiments may be active in a project. */
export const MAX_ACTIVE_EXPERIMENTS = 7;
/** An experiment's name, checked on `text` (which may trim first). */
export const experimentName = (text = z.string()) =>
  text
    .min(3)
    .max(48)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
