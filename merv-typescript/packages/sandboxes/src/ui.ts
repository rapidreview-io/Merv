import type { Context } from 'cordis';
import { keyId, type Caller } from '@merv/contracts';
import type { RunningRead } from '@merv/ui/types';
import { machineNodes, machinePanel, machinesSummary, recordRoute } from './running.js';
import type {} from './types.js';

/**
 * Mirrors the remote rows into the sidebar. The service owns the manifest; this owns nothing
 * but the registrations, which follow it: a changed manifest re-registers, an unreachable
 * service leaves the rows in place reporting degraded, and unloading withdraws them. It also
 * draws the project's machines on the Running page, from the service's memory only.
 */
export const sandboxesUiPlugin = {
  name: 'merv-sandboxes-ui',
  inject: ['sandboxes', 'ui', 'scope'],
  apply(ctx: Context) {
    const sandboxes = ctx.sandboxes;
    ctx.effect(() => {
      let registered: (() => void)[] = [];
      const withdraw = () => {
        for (const dispose of registered) dispose();
        registered = [];
      };
      const publish = () => {
        withdraw();
        registered = sandboxes.rows().map((row) =>
          ctx.ui.register({
            ...row,
            // Readiness, never a count: a number beside a row label means open work.
            status: () => sandboxes.status(),
            read: async (caller, params) => await sandboxes.read(caller, row.id, params),
          }),
        );
      };
      const unsubscribe = sandboxes.subscribe(publish);
      publish();
      return () => {
        unsubscribe();
        withdraw();
      };
    });
    // Every member reads the service's memory and only marks demand, so a board read never
    // waits on merv-sandboxes. The lane and its line read one copy of the machines.
    const machines = async (read: RunningRead) =>
      await read.once('machines', async () => sandboxes.machines(read.caller.projectId));
    // Extend and release keep the tools' own write permission.
    const writes = async (caller: Caller) =>
      await ctx.scope.require(caller, 'write').then(
        () => true,
        () => false,
      );
    ctx.effect(() =>
      ctx.ui.contribute({
        owner: 'sandboxes',
        kinds: ['sandbox'],
        lanes: ['hardware'],
        nodes: async (read) => {
          sandboxes.watch(read.caller.projectId);
          return machineNodes(await machines(read), Date.now());
        },
        summary: async (read) => machinesSummary(await machines(read), Date.now()),
        panel: async ({ caller }, key, absorbedBy) => {
          const id = keyId(key);
          sandboxes.watch(caller.projectId, id);
          return machinePanel({
            id,
            machines: sandboxes.machines(caller.projectId),
            record: sandboxes.machine(caller.projectId, id),
            allowed: absorbedBy === undefined && (await writes(caller)),
            absorbedBy,
            route: recordRoute(sandboxes.rows(), id),
            now: Date.now(),
          });
        },
      }),
    );
  },
};
export default sandboxesUiPlugin;
