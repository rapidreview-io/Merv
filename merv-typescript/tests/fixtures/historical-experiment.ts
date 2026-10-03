import {
  childRequest,
  inTransaction,
  now,
  recorded,
  type Caller,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';
import type { NativeSandboxWork } from '@merv/sandboxes/types';
import type { Experiment, ExperimentCreate, Experiments } from '@merv/experiments/types';
import {
  experimentCreateSchema,
  parseExperimentInput,
} from '../../packages/experiments/src/input.js';

/** Seed an existing scratch experiment and its receipt. Never use this to test new creation. */
export async function historicalExperiment(
  host: { state: State; experiments: Experiments },
  caller: Caller,
  value: ExperimentCreate,
  transaction?: Transaction,
  version = 25,
): Promise<Experiment> {
  caller = structuredClone(caller);
  const input = parseExperimentInput(experimentCreateSchema, value);
  const experiments = host.experiments as unknown as {
    program: { handleFor(version: number): Promise<Awaited<ReturnType<Workflows['register']>>> };
    command<T>(
      caller: Caller,
      operation: string,
      input: { requestId: string },
      tx: Transaction,
      execute: () => Promise<T>,
    ): Promise<T>;
    nativeWork?: NativeSandboxWork;
    nativeTransition(
      caller: Caller,
      workflow: unknown,
      attempt: number,
      tx: Transaction,
    ): Promise<void>;
  };
  return inTransaction(host.state, transaction, (tx) =>
    experiments.command(caller, 'create', input, tx, async () => {
      const workflow = await (
        await experiments.program.handleFor(version)
      ).start(
        caller,
        {
          workflow: 'experiment',
          version,
          requestId: childRequest(caller, 'experiment', 'create', input.requestId),
          dependsOn: input.dependsOn,
          data: {
            name: input.name,
            ...(input.workspace === 'git' ? { workspace: 'git' } : {}),
            ...(input.baseTaskId ? { baseTaskId: input.baseTaskId } : {}),
          },
        },
        tx,
      );
      const at = now();
      await tx.run(
        'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids,attempt_index,workspace) VALUES(?,?,?,?,?,?,?,?,?,1,?)',
        workflow.id,
        caller.projectId,
        input.name,
        input.intent,
        input.details,
        caller.actorId,
        caller.actorId,
        at,
        '[]',
        input.workspace ?? 'none',
      );
      await tx.run(
        'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,previous_index,feedback,created_at,feedback_review_ids) VALUES(?,1,0,NULL,?,?,?)',
        workflow.id,
        '[]',
        at,
        '[]',
      );
      if (version >= 33) {
        await experiments.nativeWork!.pin(caller.projectId, 'experiment', workflow.id, tx);
        await experiments.nativeTransition(caller, workflow, 1, tx);
      }
      await recorded(host.state, tx, caller, 'experiment.created', workflow.id, {
        name: input.name,
        dependsOn: input.dependsOn,
      });
      return host.experiments.get(caller, workflow.id, tx);
    }),
  );
}
