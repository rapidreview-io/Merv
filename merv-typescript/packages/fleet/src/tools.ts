import type { Context } from 'cordis';
import { check, type Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type {} from './types.js';
import { present } from './running.js';
import { z } from 'zod';

const id = z.string().min(1).max(200).optional();
const input = z
  .object({
    action: z
      .enum([
        'list',
        'get',
        'drain',
        'halt',
        'project_limit',
        'workflow_retry_status',
        'workflow_retry',
      ])
      .default('list'),
    id,
    machines: z.number().int().min(1).max(64).optional(),
    instanceId: id,
    expectedRevision: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(8).max(500).optional(),
    requestId: id,
  })
  .strict();
type Input = z.output<typeof input>;
/** An argument its action cannot do without. */
function need<T>(value: T | undefined, name: string): T {
  check(value !== undefined, 'invalid_input', `This fleet action needs ${name}`);
  return value;
}

/** Allocation requests are a server-owner capability, never an agent tool. The tool answers with
 *  the redacted view the Fleet page shows. */
export const fleetToolsPlugin = {
  name: 'merv-fleet-tools',
  inject: ['fleet', 'tools'],
  apply(ctx: Context) {
    const { fleet } = ctx;
    const retries = () => {
      check(fleet.retries, 'fleet_workflow_unavailable', 'Fleet runs no workflow work here', 503);
      return fleet.retries;
    };
    const run: Record<Input['action'], (caller: Caller, input: Input) => Promise<unknown>> = {
      list: async (caller) => (await fleet.list(caller, 50)).map(present),
      get: async (caller, { id }) => present(await fleet.inspect(caller, need(id, 'id'))),
      drain: async (caller, { id }) => present(await fleet.drain(caller, need(id, 'id'))),
      halt: async (caller, { id }) => present(await fleet.cancel(caller, need(id, 'id'))),
      project_limit: async (caller, { machines }) =>
        machines === undefined
          ? await fleet.projectLimit(caller)
          : await fleet.setProjectLimit(caller, machines),
      workflow_retry_status: async (caller, { instanceId: id, expectedRevision: revision }) => {
        const target = {
          instanceId: need(id, 'instanceId'),
          expectedRevision: need(revision, 'expectedRevision'),
        };
        return (await retries().retryStatus(caller, [target]))[0];
      },
      workflow_retry: async (caller, { action, ...retry }) => await retries().retry(caller, retry),
    };
    ctx.effect(function* () {
      yield ctx.tools.register({
        name: 'fleet',
        description:
          'The project’s Fleet allocations: the machines its workers run on.\nlist: open allocations and the 50 latest ended ones, with machine lifecycle status.\nget: one allocation by id; a requested shutdown is distinct from confirmed machine deletion.\ndrain: stop admission on id, keep the current assignment’s results, then release its machine (its source or a project administrator).\nhalt: fence id and request immediate machine deletion; in-flight work may be interrupted (its source or a project administrator).\nproject_limit: how many machines the project may run at once; machines sets it (a project administrator or their agent).\nworkflow_retry_status: why Fleet stopped renting for one workflow revision (instanceId, expectedRevision) after unclaimed machines.\nworkflow_retry: open one more two-attempt window for that revision (project administrator; reason, stable requestId).',
        inputSchema: input,
        reads: ({ action }: Input) => ['list', 'get', 'workflow_retry_status'].includes(action),
        handler: (caller: Caller, parsed: Input) => run[parsed.action](caller, parsed),
      });
      // The seven tools the 2026-10-20 consolidation merged answer where they went, for one release.
      yield ctx.tools.rename((name) => {
        const action = /^fleet\.(\w+)$/.exec(name)?.[1];
        return !!action && Object.hasOwn(run, action) && `fleet with action=${action}`;
      });
    });
  },
};
export default fleetToolsPlugin;
