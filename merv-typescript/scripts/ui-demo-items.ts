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
  await ctx.autoresearch.configure(owner, {
    enabled: true,
    goal: 'Find what moves the grokking step at p = 97 and p = 113, within $40 of compute.',
    capUsd: 40,
    runEstimateUsd: 4,
    wakeLimit: 20,
    requestId: 'demo-autoresearch-on',
  });
  const status = await ctx.autoresearch.status(owner);
  const manager = status.managerId!;
  const start = Date.now() - 4 * 3600_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const runs = [
    { item: items.complete, startedAt: 4, endedAt: 92, finalState: 'complete' },
    ...(items.failed
      ? [{ item: items.failed, startedAt: 96, endedAt: 150, finalState: 'failed' }]
      : []),
    { item: items.running, startedAt: 156, endedAt: null, finalState: null },
  ];
  const lines: [number, string, string][] = [
    [
      5,
      'decide',
      'Started decay-sweep-p97: three weight decays at p = 97, to see whether the grokking step falls with decay.',
    ],
    [92, 'wake', 'decay-sweep-p97 ended: complete.'],
    [
      97,
      'decide',
      'Decay helps (14.2k → 6.1k steps). Next, lr-3e-3-stability: does a 3× learning rate grok sooner still?',
    ],
    [150, 'wake', 'lr-3e-3-stability ended: failed.'],
    [
      157,
      'decide',
      'The high learning rate diverged. Back to decay, at p = 113, to see whether the effect carries to a larger modulus.',
    ],
  ];
  const names = new Map(
    await Promise.all(runs.map(async (run) => [run.item, await named(run.item)] as const)),
  );
  await ctx.state.transaction(async (tx) => {
    // The round began four hours ago: its opening line is dated so.
    await tx.run(
      "UPDATE autoresearch_lines SET at=? WHERE project_id=? AND manager_id=? AND kind='start'",
      at(0),
      owner.projectId,
      manager,
    );
    for (const run of runs)
      await tx.run(
        'INSERT INTO autoresearch_runs(id,project_id,manager_id,workflow,name,started_at,ended_at,final_state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING',
        run.item,
        owner.projectId,
        manager,
        'experiment',
        names.get(run.item)!,
        at(run.startedAt),
        run.endedAt === null ? null : at(run.endedAt),
        run.finalState,
      );
    for (const [minutes, kind, text] of lines)
      await tx.run(
        'INSERT INTO autoresearch_lines(id,project_id,manager_id,revision,kind,actor_id,text,at) VALUES(?,?,?,?,?,?,?,?)',
        id('autoresearch_line'),
        owner.projectId,
        manager,
        null,
        kind,
        owner.actorId,
        text,
        at(minutes),
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
