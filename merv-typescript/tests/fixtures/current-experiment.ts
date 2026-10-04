import type { Caller, Transaction, State } from '@merv/contracts';
import type { Experiments, ExperimentCreate } from '@merv/experiments/types';
import type { Code } from '@merv/code-work/types';
import { waitForManagedCode } from './managed-code.js';

/** Create executable work through the public owner after real Git initialization. */
export async function currentExperiment(
  host: {
    experiments: Experiments;
    state?: State;
    codeWork?: Pick<Code, 'status'>;
    code?: unknown;
  },
  caller: Caller,
  input: ExperimentCreate,
  transaction?: Transaction,
) {
  await waitForManagedCode((host.codeWork ?? host.code) as Pick<Code, 'status'>, caller);
  return host.experiments.create(caller, input, transaction);
}
