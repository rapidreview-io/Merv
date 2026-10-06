import { z } from 'zod';

// Experiment rules that Research and Reflections apply before they create experiments: pure, so
// they import it without depending on the Experiments service.

/** The parts evidence plays (ExperimentRole), in the domain's own order: design, then results. */
export const EXPERIMENT_ROLES = ['plan', 'feasibility', 'result', 'report', 'exhibit'] as const;
/** Where a role stands in that order; a role the domain no longer writes goes last. */
export const roleRank = (role: string): number => {
  const at = (EXPERIMENT_ROLES as readonly string[]).indexOf(role);
  return at < 0 ? EXPERIMENT_ROLES.length : at;
};
/** At most this many experiments may be active in a project. */
export const MAX_ACTIVE_EXPERIMENTS = 7;
/** An experiment's name, checked on `text` (which may trim first). */
export const experimentName = (text = z.string()) =>
  text
    .min(3)
    .max(48)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
