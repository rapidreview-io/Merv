import type { NativeSandboxWork } from '@merv/sandboxes/types';
import { renderBrief } from '../../packages/tasks/src/evidence.js';
import {
  childRequest,
  clip,
  inTransaction,
  now,
  recorded,
  type Artifacts,
  type Caller,
  type State,
  type Task,
  type TaskCreate,
  type Tasks,
  type Transaction,
  type Workflows,
} from '@merv/contracts';

/**
 * Seed a task already created under task@28, including its original command receipt.
 * This is a historical-record fixture, NOT an alternative task.create implementation:
 * use valid briefs only; creation validation must exercise the current public API.
 * All execution, review, authority and recovery after seeding use the real services.
 */
export async function historicalTask(
  host: { state: State; artifacts: Artifacts; tasks: Tasks },
  caller: Caller,
  input: TaskCreate,
  transaction?: Transaction,
  version = 28,
): Promise<Task> {
  caller = structuredClone(caller);
  input = structuredClone(input);
  const tasks = host.tasks as Tasks & {
    nativeWork?: NativeSandboxWork;
    nativeTransition(caller: Caller, workflow: unknown, tx: Transaction): Promise<void>;
    registration(version: number): Awaited<ReturnType<Workflows['register']>>;
    newestType(name: string): number;
    command<T>(
      tx: Transaction,
      caller: Caller,
      requestId: string,
      operation: string,
      input: unknown,
      execute: () => Promise<T>,
    ): Promise<T>;
    row(tx: Transaction, caller: Caller, id: string): Promise<unknown>;
    hydrate(caller: Caller, row: unknown, tx: Transaction): Promise<Task>;
  };
  return inTransaction(host.state, transaction, (tx) =>
    tasks.command(tx, caller, input.requestId, 'create', input, async () => {
      const brief = input.briefId
        ? await host.artifacts.get(caller, input.briefId, tx)
        : await host.artifacts.create(
            caller,
            {
              title: clip(`Task brief: ${input.title}`, 300),
              content: renderBrief(input, input.workspace === 'git'),
            },
            tx,
          );
      const workflow = await tasks.registration(version).start(
        caller,
        {
          workflow: 'task',
          version,
          requestId: childRequest(caller, 'task', 'create', input.requestId),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          data: {
            title: input.title,
            goal: input.goal,
            checks: input.checks,
            producerId: caller.actorId,
            briefId: brief.id,
            evidenceVersion: 2,
            ...(input.workspace === 'git' ? { workspace: 'git' } : {}),
            ...(input.baseTaskId ? { baseTaskId: input.baseTaskId } : {}),
          },
        },
        tx,
      );
      const type = input.type ?? 'task.work';
      await tx.run(
        'INSERT INTO tasks(id,project_id,title,goal,checks,producer_id,brief_id,created_at,type_name,type_version,context_inputs,evidence_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,2)',
        workflow.id,
        caller.projectId,
        input.title,
        input.goal,
        JSON.stringify(input.checks),
        caller.actorId,
        brief.id,
        now(),
        type,
        input.typeVersion ?? tasks.newestType(type),
        JSON.stringify(input.contextInputs ?? {}),
      );
      if (version >= 36) {
        await tasks.nativeWork!.pin(caller.projectId, 'task', workflow.id, tx);
        await tasks.nativeTransition(caller, workflow, tx);
      }
      await recorded(host.state, tx, caller, 'task.created', workflow.id, {
        briefId: brief.id,
        evidenceVersion: 2,
      });
      return tasks.hydrate(caller, await tasks.row(tx, caller, workflow.id), tx);
    }),
  );
}
