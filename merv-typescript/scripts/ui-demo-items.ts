/**
 * The demo's items beyond the Running page's own: an autoresearch round whose manager woke
 * three times and scheduled the seeded experiments, and a board with three of them placed on
 * it as cards. Run by scripts/ui-demo.ts when real Trackio is on (MERV_TRACKIO_PYTHON).
 *
 * The manager is an agent, and the demo runs none: its earlier wakes are written as the loop
 * writes them (autoresearch_runs and autoresearch_lines), naming the real experiments.
 */
import { randomBytes } from 'node:crypto';
import type { Context } from 'cordis';
import type { Caller } from '@merv/contracts';
import type {} from '@merv/autoresearch/types';
import type {} from '@merv/board/types';

interface App {
  ctx: Context;
}
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/** Turns autoresearch on before the demo's experiments start, so its round holds them. */
export async function beginRound(app: App, owner: Caller) {
  await app.ctx.autoresearch.configure(owner, {
    enabled: true,
    goal: 'Find what moves the grokking step at p = 97 and p = 113, within $40 of compute.',
    capUsd: 40,
    runEstimateUsd: 4,
    wakeLimit: 20,
    requestId: 'demo-autoresearch-on',
  });
}

export async function seedItems(
  app: App,
  input: {
    owner: Caller;
    items: { running: string; complete: string; returned: string; failed?: string };
  },
) {
  const { ctx } = app;
  const { owner, items } = input;
  const named = async (experimentId: string) =>
    (await ctx.experiments.get(owner, experimentId)).name;
  const status = await ctx.autoresearch.status(owner);
  const manager = status.managerId!;
  // Each run as its experiment really went: started when it was created, ended when it last moved.
  const order = [items.complete, ...(items.failed ? [items.failed] : []), items.running];
  const runs = await Promise.all(
    order.map(async (id) => {
      const e = await ctx.experiments.get(owner, id);
      return {
        item: id,
        name: e.name,
        startedAt: e.createdAt,
        endedAt: e.settled || e.failed ? e.workflow.updatedAt : null,
        finalState: e.settled || e.failed ? e.workflow.state : null,
      };
    }),
  );
  const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
  const [complete, failed, running] = [runs[0]!, items.failed ? runs[1]! : undefined, runs.at(-1)!];
  // The manager's decision follows the start of what it scheduled; the loop's wake follows an end.
  // The demo starts p = 113 first, then the p = 97 sweep: one visit scheduled both.
  const firstStarts = [complete.startedAt, running.startedAt].sort().at(-1)!;
  const lines: [string, string, string][] = [
    [
      later(firstStarts, 1),
      'decide',
      'Started two decay sweeps, at p = 97 and p = 113, to see whether the grokking step falls with weight decay at both.',
    ],
    [later(complete.endedAt!, 1), 'wake', 'decay-sweep-p97 ended: complete.'],
    ...(failed
      ? ([
          [
            later(failed.startedAt, 1),
            'decide',
            'Decay helps at p = 97 (14.2k → 6.1k steps). Next, lr-3e-3-stability: does a 3× learning rate grok sooner still?',
          ],
          [later(failed.endedAt!, 1), 'wake', 'lr-3e-3-stability ended: failed.'],
          [
            later(failed.endedAt!, 2),
            'decide',
            'The high learning rate diverged. Waiting for p = 113 before choosing the next run.',
          ],
        ] as [string, string, string][])
      : []),
  ];
  await ctx.state.transaction(async (tx) => {
    for (const run of runs)
      await tx.run(
        'INSERT INTO autoresearch_runs(id,project_id,manager_id,workflow,name,started_at,ended_at,final_state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING',
        run.item,
        owner.projectId,
        manager,
        'experiment',
        run.name,
        run.startedAt,
        run.endedAt,
        run.finalState,
      );
    for (const [at, kind, text] of lines.sort((x, y) => x[0].localeCompare(y[0])))
      await tx.run(
        'INSERT INTO autoresearch_lines(id,project_id,manager_id,revision,kind,actor_id,text,at) VALUES(?,?,?,?,?,?,?,?)',
        id('autoresearch_line'),
        owner.projectId,
        manager,
        null,
        kind,
        owner.actorId,
        text,
        at,
      );
  });

  // A board of the round's experiments, each placed as its card.
  const placed = [items.complete, items.running, ...(items.failed ? [items.failed] : [])];
  const board = await ctx.board.draw(owner, {
    title: 'Grokking: what moves the step',
    ops: [
      {
        op: 'text',
        text: 'What moves the grokking step',
        size: 'l',
        at: [0, -90],
      },
      ...(await Promise.all(
        placed.map(async (target, i) => ({
          op: 'link' as const,
          key: `item${i}`,
          target,
          text: await named(target),
          at: [i * 460, 0] as [number, number],
        })),
      )),
    ],
  } as never);
  return { autoresearch: manager, board: board.board.id };
}
