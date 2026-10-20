import type { Context } from 'cordis';
import { check, type Caller } from '@merv/contracts';
import type {} from '@merv/api/types';
import type { FleetRetryInput } from './types.js';
import { present } from './running.js';
import { z } from 'zod';

/** What each action takes; `?` marks an optional argument. */
const takes = {
  list: [],
  get: ['id'],
  drain: ['id'],
  halt: ['id'],
  project_limit: ['machines?'],
  workflow_retry_status: ['instanceId', 'expectedRevision'],
  workflow_retry: ['instanceId', 'expectedRevision', 'reason', 'requestId'],
} as const;
type Action = keyof typeof takes;
const input = z
  .object({
    action: z.enum(Object.keys(takes) as [Action, ...Action[]]).default('list'),
    id: z.string().min(1).max(200).optional(),
    machines: z.number().int().min(1).max(64).optional(),
    instanceId: z.string().min(1).max(200).optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(8).max(500).optional(),
    requestId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine(({ action, ...args }, context) => {
    const names: readonly string[] = takes[action];
    const given = Object.keys(args);
    if (
      given.some((name) => !names.includes(name) && !names.includes(`${name}?`)) ||
      names.some((name) => !name.endsWith('?') && !given.includes(name))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `fleet action=${action} takes ${names.join(', ') || 'nothing more'}`,
      });
  });
type Input = z.output<typeof input>;

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
    const run: { [A in Action]: (caller: Caller, input: Input) => Promise<unknown> } = {
      list: async (caller) => (await fleet.list(caller, 50)).map(present),
      get: async (caller, { id }) => present(await fleet.inspect(caller, id!)),
      drain: async (caller, { id }) => present(await fleet.drain(caller, id!)),
      halt: async (caller, { id }) => present(await fleet.cancel(caller, id!)),
      project_limit: async (caller, { machines }) =>
        machines === undefined
          ? await fleet.projectLimit(caller)
          : await fleet.setProjectLimit(caller, machines),
      workflow_retry_status: async (caller, { action, ...target }) =>
        (await retries().retryStatus(caller, [target as FleetRetryInput]))[0],
      workflow_retry: async (caller, { action, ...retry }) =>
        await retries().retry(caller, retry as FleetRetryInput),
    };
    ctx.effect(() =>
      ctx.tools.register({
        name: 'fleet',
        description:
          'The project’s Fleet allocations: the machines its workers run on.\nlist: open allocations and the 50 latest ended ones, with machine lifecycle status.\nget: one allocation by id; a requested shutdown is distinct from confirmed machine deletion.\ndrain: stop admission on id, keep the current assignment’s results, then release its machine (its source or a project administrator).\nhalt: fence id and request immediate machine deletion; in-flight work may be interrupted (its source or a project administrator).\nproject_limit: how many machines the project may run at once; machines sets it (a project administrator, signed in).\nworkflow_retry_status: why Fleet stopped renting for one workflow revision (instanceId, expectedRevision) after unclaimed machines.\nworkflow_retry: open one more two-attempt window for that revision (project administrator; reason, stable requestId).',
        inputSchema: input,
        handler: (caller: Caller, parsed: Input) => run[parsed.action](caller, parsed),
      }),
    );
    // The seven tools the 2026-10-20 consolidation merged answer where they went, for one release.
    ctx.effect(() =>
      ctx.tools.rename((name) => {
        const action = /^fleet\.(\w+)$/.exec(name)?.[1];
        return !!action && Object.hasOwn(takes, action) && `fleet with action=${action}`;
      }),
    );
  },
};
export default fleetToolsPlugin;
