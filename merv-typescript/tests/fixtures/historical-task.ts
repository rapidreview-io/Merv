import { renderBrief } from '../../packages/tasks/src/evidence.js';
import { TASK_WORKFLOW } from '@merv/tasks';
import {
  clip,
  inTransaction,
  now,
  type Artifacts,
  type Caller,
  type State,
  type Task,
  type TaskCreate,
  type Tasks,
  type Transaction,
  type Workflows,
} from '@merv/contracts';

/** Seed stored history, never an executable old Task implementation. */
export async function historicalTask(
  host: { state: State; artifacts: Artifacts; tasks: Tasks; workflows: Workflows },
  caller: Caller,
  input: TaskCreate,
  transaction?: Transaction,
  version = 28,
): Promise<Task> {
  const handle = await host.workflows.register({ ...TASK_WORKFLOW, version });
  try {
    return await inTransaction(host.state, transaction, async (tx) => {
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
      const workflow = await handle.start(
        caller,
        {
          workflow: 'task',
          version,
          requestId: input.requestId,
          dependsOn: input.dependsOn,
          data: {
            title: input.title,
            goal: input.goal,
            checks: input.checks,
            producerId: caller.actorId,
            briefId: brief.id,
            ...(input.workspace === 'git' ? { workspace: 'git' } : {}),
          },
        },
        tx,
      );
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
        input.type ?? 'task.work',
        input.typeVersion ?? 4,
        JSON.stringify(input.contextInputs ?? {}),
      );
      handle.dispose();
      return {
        ...(await host.tasks.record(caller, workflow.id, tx)),
        guidance: await host.workflows.evaluate(caller, workflow.id, {}, tx),
      };
    });
  } finally {
    handle.dispose();
  }
}
