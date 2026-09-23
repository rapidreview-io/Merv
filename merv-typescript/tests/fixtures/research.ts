import type { Caller, CodeUnit, CodeUnitPublication, State, Tasks } from '@merv/contracts';
import type { ResearchService } from '@merv/research';

/** What the test says main lacks and where a unit's publication stands; changed as it goes. */
export interface Main {
  unitIds: string[];
  quarantined?: string[];
  publication?: CodeUnitPublication | null;
}

/**
 * Code as Research sees it for a hosted project, answered by the test. Tasks stays real,
 * with a workspace-free stand-in for the service creator, so the injected consolidation task
 * is one the test finishes or fails like any other. Returns the units marked to publish.
 */
export function hostedCode(
  research: ResearchService,
  ctx: { state: State; tasks: Tasks },
  owner: Caller,
  main: Main,
): string[] {
  const published: string[] = [];
  research.bindCode({
    hosted: async () => true,
    acceptedSince: async () => ({
      unitIds: main.unitIds,
      quarantined: main.quarantined ?? [],
      main: 'main',
      hash: 'reading',
    }),
    publishOnAcceptance: async (_caller, { unitId }, tx) => {
      ctx.state.assertTransaction(tx);
      published.push(unitId);
      return { unitId } as CodeUnit;
    },
    unit: async (_caller, unitId) =>
      ({ unitId, publication: main.publication ?? null }) as CodeUnit,
  });
  const serviceTasks = (): ReturnType<Tasks['serviceTasks']> => ({
    create: async (input, tx) =>
      await ctx.tasks.create(
        owner,
        {
          title: input.title,
          goal: input.goal,
          checks: input.checks,
          dependsOn: input.dependsOn ?? [],
          requestId: input.requestId,
        },
        tx,
      ),
  });
  // Everything else stays the real service's, prototype methods included.
  research.bindTasks(
    new Proxy(ctx.tasks, {
      get: (tasks, key) => (key === 'serviceTasks' ? serviceTasks : Reflect.get(tasks, key)),
    }),
  );
  return published;
}
