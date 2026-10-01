import {
  check,
  type Artifacts,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { SandboxCompute } from '@merv/sandboxes/types';
import { WorkMachines } from '@merv/sandboxes/managed-compute';
import { ManagedCompute, type ManagedComputeRunning } from '@merv/sandboxes/managed-compute';
import type { Code } from '@merv/code-research/types';
import type { ComputeInput } from './types.js';

export interface ComputeRunning extends Omit<ManagedComputeRunning, 'ownerId' | 'generation'> {
  experimentId: string;
  attemptIndex: number;
}
const experimentRun = ({ ownerId, generation, ...run }: ManagedComputeRunning): ComputeRunning => ({
  ...run,
  experimentId: ownerId,
  attemptIndex: generation,
});

/** Experiment policy over the shared Sandboxes compute ledger. */
export class ExperimentCompute {
  private readonly managed: ManagedCompute;
  readonly machines: WorkMachines;
  constructor(
    state: State,
    scope: Scope,
    adapter: SandboxCompute,
    code: () => Pick<Code, 'source'> | undefined,
    artifacts?: Artifacts,
  ) {
    this.managed = new ManagedCompute(
      state,
      scope,
      adapter,
      'experiment',
      {
        authorize: async (caller, experimentId, attemptIndex, tx, commandId, input) => {
          const experiment = await tx.get<{
            attempt_index: number;
            state: string;
            version: number;
          }>(
            `SELECT e.attempt_index,w.state,w.version FROM experiments e JOIN wf_instances w ON w.id=e.id
           WHERE e.id=? AND e.project_id=?`,
            experimentId,
            caller.projectId,
          );
          check(
            experiment &&
              (experiment.state === 'running' ||
                (input?.purpose === 'check' &&
                  experiment.version >= 25 &&
                  ['planned', 'design_review', 'experiment_review'].includes(experiment.state))) &&
              experiment.version > 8 &&
              experiment.version <= 32 &&
              experiment.attempt_index === attemptIndex,
            'compute_not_running',
            'Compute requires this experiment’s current running attempt',
            409,
          );
          if (commandId)
            check(
              [12, 16, 20, 24, 28, 32].includes(experiment.version),
              'code_source_unavailable',
              'This experiment version cannot ship code',
              409,
            );
          if (input?.rentalKey)
            check(
              caller.session,
              'stale_lease',
              'Rental jobs require a current experiment assignment',
              403,
            );
          if (caller.session) {
            const lease = await tx.get(
              `SELECT l.id FROM experiment_leases l JOIN wf_instances w ON w.id=l.experiment_id WHERE l.experiment_id=? AND l.project_id=? AND l.attempt_index=?
             AND l.state=w.state AND l.revision=w.revision AND l.actor_id=? AND l.id=? AND l.released_at IS NULL`,
              experimentId,
              caller.projectId,
              attemptIndex,
              caller.actorId,
              caller.session.id,
            );
            check(lease, 'stale_lease', 'The worker no longer owns this experiment attempt', 409);
          }
        },
        active: async (row, tx) => {
          const experiment = await tx.get<{ attempt_index: number; state: string }>(
            `SELECT e.attempt_index,w.state FROM experiments e JOIN wf_instances w ON w.id=e.id
           WHERE e.id=? AND e.project_id=?`,
            row.owner_id,
            row.project_id,
          );
          const input = JSON.parse(row.input_json);
          return (
            !!experiment &&
            (experiment.state === 'running' ||
              (input.purpose === 'check' &&
                ['planned', 'design_review', 'experiment_review'].includes(experiment.state))) &&
            experiment.attempt_index === row.generation
          );
        },
        source: async (row, commandId) => code()?.source(row.project_id, row.owner_id, commandId),
      },
      artifacts,
    );
    this.machines = new WorkMachines(state, scope, adapter, 'experiment', {
      entitled: (projectId, tx) => this.managed.entitled(projectId, tx),
      active: async (projectId, experimentId, tx) =>
        !!(await tx.get(
          `SELECT e.id FROM experiments e JOIN wf_instances w ON w.id=e.id WHERE e.id=? AND e.project_id=? AND w.state IN ('planned','design_review','running','experiment_review')`,
          experimentId,
          projectId,
        )),
      authorize: async (caller, experimentId, tx) => {
        check(
          caller.session,
          'stale_lease',
          'GPU rental access requires a current experiment assignment',
          403,
        );
        check(
          await tx.get(
            `SELECT l.id FROM experiment_leases l JOIN experiments e ON e.id=l.experiment_id JOIN wf_instances w ON w.id=e.id
          WHERE e.id=? AND e.project_id=? AND w.version>=17 AND w.version<=32 AND l.id=? AND l.actor_id=? AND l.revision=w.revision
          AND l.state=w.state AND l.attempt_index=e.attempt_index AND l.released_at IS NULL
          AND w.state IN ('planned','design_review','running','experiment_review')`,
            experimentId,
            caller.projectId,
            caller.session.id,
            caller.actorId,
          ),
          'stale_lease',
          'This worker no longer owns the experiment assignment',
          409,
        );
      },
    });
  }
  close() {
    this.managed.close();
    this.machines.close();
  }
  entitled(projectId: string, tx?: Transaction) {
    return this.managed.entitled(projectId, tx);
  }
  offers(caller: Caller) {
    return this.managed.offers(caller);
  }
  async rows(projectId: string, experimentId: string, attemptIndex: number, tx: Transaction) {
    return (await this.managed.rows(projectId, experimentId, attemptIndex, tx)).map(
      ({ generation, ...row }) => ({ ...row, attemptIndex: generation }),
    );
  }
  async inFlight(projectId: string, tx: Transaction) {
    return (await this.managed.inFlight(projectId, tx)).map(experimentRun);
  }
  async recent(projectId: string, experimentId: string, attemptIndex: number, tx: Transaction) {
    return (await this.managed.recent(projectId, experimentId, attemptIndex, tx)).map(
      experimentRun,
    );
  }
  async find(projectId: string, wanted: string, tx: Transaction) {
    const found = await this.managed.find(projectId, wanted, tx);
    return found ? experimentRun(found) : null;
  }
  async run(caller: Caller, input: ComputeInput) {
    const row = await this.managed.run(caller, {
      ownerId: input.experimentId,
      generation: input.attemptIndex,
      key: input.key,
      provider: input.provider,
      offerId: input.offerId,
      ...(input.rentalKey ? { rentalKey: input.rentalKey } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      command: input.command,
      minutes: input.minutes,
      maxUsd: input.maxUsd,
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(input.outputs ? { outputs: input.outputs } : {}),
    });
    const { generation, ...rest } = row;
    return { ...rest, attemptIndex: generation };
  }
  async cancel(caller: Caller, experimentId: string, runId: string) {
    const row = await this.managed.cancel(caller, experimentId, runId);
    const { generation, ...rest } = row;
    return { ...rest, attemptIndex: generation };
  }
  output(caller: Caller, experimentId: string, runId: string, name: string, attemptIndex?: number) {
    return this.managed.output(caller, experimentId, runId, name, attemptIndex);
  }
  logs(caller: Caller, experimentId: string, runId: string, attemptIndex?: number) {
    return this.managed.logs(caller, experimentId, runId, attemptIndex);
  }
  artifactIds(projectId: string, experimentId: string, tx: Transaction) {
    return this.managed.artifactIds(projectId, experimentId, tx);
  }
  async tick() {
    await this.managed.tick();
    await this.machines.tick();
  }
}
