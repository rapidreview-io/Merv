import type { Context } from 'cordis';
import { z } from 'zod';
import { isAgentAudience } from '@merv/api/audience';
import type {} from '@merv/api/types';
import { check, newId, now, type Caller, type State, type Transaction } from '@merv/contracts';
import { summarize } from './elements.js';
import { id } from './input.js';
import type {
  AgentHarness,
  AgentsState,
  AgentConnector,
  AgentRun,
  AgentTask,
  CheckVerdict,
} from './agents-models.js';
import type { BoardDrawn } from './types.js';
import type {} from './types.js';

/**
 * Experiment, loaded only where a demo composes it (scripts/ui-demo-command.ts): a board as the
 * place a person hands work to their own agents. A task is a frame on the board: its title the
 * goal, each note in it a measurable check, all of it ordinary shapes they edit by hand. A hand-off
 * reads the frame as it stands, queues a run here, and the person's own machine dials out for it
 * (clients/board-connect): nothing reaches into the machine, and no credential reaches the server.
 * What happens comes back as edits to shapes, so the page, a phone, replay and Pi all see it with
 * no client of their own. Hand-offs are a person's alone: nothing an agent or a board's text says
 * can start code on their machine.
 */
const NAMES: Record<AgentHarness, string> = { claude: 'Claude Code', codex: 'Codex' };
/** A connector unheard of for this long is offline. */
const ONLINE_MS = 12_000;
const ACTIVE = new Set<AgentRun['state']>(['queued', 'running', 'judging', 'stopping']);
const COMMAND = /`([^`]+)`/;
/** A task frame: a column of checks, and beside it a column of what became of them. */
const [WIDTH, CHECK_WIDTH] = [720, 440];
const line = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1)}…` : text;
/** Rough height of a check's box at its width. */
const noteHeight = (text: string) => 28 + 22 * Math.ceil(text.length / 38);
/** Words broken to stand in the column beside a check. */
const wrapped = (text: string, width = 30) =>
  text.replace(new RegExp(`(.{1,${width}})(\\s+|$)`, 'g'), '$1\n').trim();

const harness = z.enum(['claude', 'codex']);
const taskSchema = z.strictObject({
  board: id,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().max(600).optional(),
  checks: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  near: z.string().trim().max(100).optional(),
  say: z.string().trim().max(100).optional(),
});
const stateSchema = z.strictObject({ board: id });
const handoffSchema = z.strictObject({ task: id, harness, sendBack: z.boolean().optional() });
const stopSchema = z.strictObject({ run: id });
const pollSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  workspace: z.string().trim().max(200),
  harnesses: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().max(200) })),
  fresh: z.boolean().optional(),
  /** Whether it has room for another run now. */
  capacity: z.boolean().optional(),
});
const verdictSchema = z.strictObject({
  check: z.string(),
  pass: z.boolean(),
  how: z.enum(['command', 'judge']),
  by: z.string().max(40),
  reason: z.string().max(600),
});
const reportSchema = z.strictObject({
  run: id,
  state: z.enum(['running', 'judging', 'passed', 'failed', 'stopped', 'error']).optional(),
  step: z.string().max(200).optional(),
  session: z.string().max(200).optional(),
  verdicts: z.array(verdictSchema).max(20).optional(),
  result: z
    .strictObject({
      summary: z.string().max(4000),
      files: z.array(z.string().max(300)).max(100),
      stat: z.string().max(2000),
    })
    .optional(),
  error: z.string().max(400).optional(),
});

const migrations: Record<number, string> = {
  1: `CREATE TABLE board_agents(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,board_id TEXT,record TEXT NOT NULL,PRIMARY KEY(project_id,kind,id));
CREATE INDEX board_agents_board ON board_agents(project_id,kind,board_id);`,
};

export const boardAgentsPlugin = {
  name: 'merv-board-agents',
  inject: ['board', 'tools', 'state'],
  async apply(ctx: Context) {
    const board = ctx.board;
    const state: State = ctx.state;
    await state.migrate('board-agents', migrations);
    const put = (
      tx: Transaction,
      projectId: string,
      kind: string,
      key: string,
      boardId: string | null,
      record: object,
    ) =>
      tx.run(
        `INSERT INTO board_agents(project_id,kind,id,board_id,record) VALUES(?,?,?,?,?)
         ON CONFLICT(project_id,kind,id) DO UPDATE SET record=excluded.record`,
        projectId,
        kind,
        key,
        boardId,
        JSON.stringify(record),
      );
    const get = async <T>(tx: Transaction, projectId: string, kind: string, key: string) => {
      const row = await tx.get<{ record: string }>(
        'SELECT record FROM board_agents WHERE project_id=? AND kind=? AND id=?',
        projectId,
        kind,
        key,
      );
      return row ? (JSON.parse(row.record) as T) : undefined;
    };
    const all = async <T>(tx: Transaction, projectId: string, kind: string, boardId?: string) =>
      (
        await tx.all<{ record: string }>(
          `SELECT record FROM board_agents WHERE project_id=? AND kind=?${boardId ? ' AND board_id=?' : ''}`,
          projectId,
          kind,
          ...(boardId ? [boardId] : []),
        )
      ).map((row) => JSON.parse(row.record) as T);
    const save = (projectId: string, kind: string, key: string, boardId: string | null, row: object) =>
      state.transaction((tx) => put(tx, projectId, kind, key, boardId, row));
    const read = <T>(projectId: string, kind: string, key: string) =>
      state.transaction((tx) => get<T>(tx, projectId, kind, key));
    const rows = <T>(projectId: string, kind: string, boardId?: string) =>
      state.transaction((tx) => all<T>(tx, projectId, kind, boardId));

    const connectorOf = async (caller: Caller) => {
      const held = await read<AgentConnector>(caller.projectId, 'connector', caller.actorId);
      return held && { ...held, online: Date.now() - Date.parse(held.seen) < ONLINE_MS };
    };
    /** The words and colour a run gives its task's status shape. */
    const standing = (run: AgentRun, connector?: AgentConnector) => {
      const who = NAMES[run.harness];
      const passed = run.verdicts?.filter((verdict) => verdict.pass).length ?? 0;
      const total = run.spec.checks.length;
      switch (run.state) {
        case 'queued':
          return connector?.online
            ? { text: `${who}: starting`, color: 'blue' }
            : { text: `${who}: waits for ${connector?.name ?? 'your machine'}`, color: 'orange' };
        case 'running':
          return { text: `${who}: ${line(run.step ?? 'working', 58)}`, color: 'blue' };
        case 'judging':
          return { text: `${who} done. Judging ${total} checks`, color: 'blue' };
        case 'stopping':
          return { text: `${who}: stopping`, color: 'gray' };
        case 'passed': {
          const eyes = run.verdicts?.filter((verdict) => verdict.how === 'judge').length ?? 0;
          const ran = total - eyes;
          return {
            text: `${who}: ${[ran && `${ran} ran and pass`, eyes && `${eyes} for your eyes`].filter(Boolean).join(', ')}`,
            color: 'green',
          };
        }
        case 'failed':
          return { text: `${who}: ${total - passed} of ${total} checks fail`, color: 'red' };
        case 'stopped':
          return { text: `${who}: stopped`, color: 'gray' };
        default:
          return { text: `${who}: ${line(run.error ?? 'failed', 58)}`, color: 'orange' };
      }
    };
    /** An edit by the machinery lands at once: an agent's would wait its turn behind the pen. */
    const draw = (caller: Caller, boardId: string, ops: unknown[]): Promise<BoardDrawn> =>
      board.draw(caller, { board: boardId, ops } as never, [], false);
    const show = async (caller: Caller, task: AgentTask, run: AgentRun) => {
      const connector = await connectorOf(caller);
      await draw(caller, task.board, [{ op: 'edit', id: task.status, ...standing(run, connector) }]);
    };

    /** The frame as it stands: every shape in it that says something and is not the machinery's. */
    const specOf = async (caller: Caller, task: AgentTask): Promise<AgentRun['spec']> => {
      const scene = await board.scene(caller, task.board);
      const { shapes, frames } = summarize(scene.elements);
      const frame = frames.find((held) => held.id === task.frame);
      check(frame, 'board_task_gone', 'This task is no longer on the board', 404);
      const inFrame = shapes.filter((shape) => shape.frame === task.frame && shape.text);
      const mine = new Set([task.status, task.goal, ...task.verdicts]);
      const checks = inFrame
        .filter((shape) => !mine.has(shape.id))
        .toSorted((a, b) => a.at[1]! - b.at[1]!)
        .map((shape) => {
          const text = shape.text!;
          const command = COMMAND.exec(text)?.[1];
          return { id: shape.id, text, ...(command && { command }) };
        });
      const goal = inFrame.find((shape) => shape.id === task.goal)?.text;
      // What the board says around the task: background for whoever takes it, bounded.
      const context = line(
        shapes
          .filter((shape) => !shape.frame && shape.text)
          .map((shape) => shape.text)
          .join('\n'),
        4000,
      );
      return { title: frame.title || task.title, ...(goal && { goal }), checks, context };
    };

    ctx.effect(() =>
      ctx.tools.register({
        name: 'board.task',
        description:
          'Distil what is on a board into one task on it: a frame titled with the goal, each check a note in it that a person can rewrite, remove or add to. A check must be measurable: put a shell command in backticks when its exit code decides it (`npm test`); otherwise say what a reader of the result could verify. Call once per task, in order.',
        inputSchema: taskSchema,
        handler: async (caller: Caller, input: z.infer<typeof taskSchema>) => {
          const rowsHeight = input.checks.reduce((sum, text) => sum + noteHeight(text) + 12, 0);
          const goalHeight = input.goal ? 16 + 24 * Math.ceil(input.goal.length / 52) : 0;
          const height = 96 + goalHeight + rowsHeight;
          const scene = await board.scene(caller, input.board);
          // Beside the tasks already there, then near what was asked, then in the next free place.
          const lastFrame = (await rows<AgentTask>(caller.projectId, 'task', input.board))
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
            .filter((task) => scene.elements.some((el) => el.id === task.frame))
            .at(-1)?.frame;
          const near = lastFrame ?? input.near;
          const made = (await ctx.tools.call('board.write:draw', caller, {
            board: input.board,
            ops: [
              {
                op: 'frame',
                key: 'frame',
                title: input.title,
                width: WIDTH,
                height,
                ...(near && { near, side: 'right' }),
                ...(input.say && { say: input.say }),
              },
            ],
          })) as BoardDrawn;
          const [x, y] = made.placed.frame ?? made.placed[made.created.frame!]!;
          const ops: object[] = [
            {
              op: 'box',
              key: 'status',
              text: 'Ready to hand off',
              color: 'gray',
              width: WIDTH - 40,
              height: 40,
              fontSize: 16,
              at: [x! + 20, y! + 16],
              in: 'FRAME',
            },
          ];
          let at = y! + 68;
          if (input.goal) {
            ops.push({ op: 'text', key: 'goal', text: input.goal, size: 's', at: [x! + 20, at], in: 'FRAME' });
            at += goalHeight;
          }
          input.checks.forEach((text, index) => {
            ops.push({
              op: 'box',
              key: `c${index}`,
              text,
              color: 'yellow',
              fontSize: 16,
              width: CHECK_WIDTH,
              height: noteHeight(text),
              at: [x! + 20, at],
              in: 'FRAME',
            });
            at += noteHeight(text) + 12;
          });
          const frame = made.created.frame!;
          const placed = (await ctx.tools.call('board.write:draw', caller, {
            board: input.board,
            ops: ops.map((op) => ('in' in op ? { ...op, in: frame } : op)),
          })) as BoardDrawn;
          const task: AgentTask = {
            id: newId('task_board'),
            board: input.board,
            frame,
            status: placed.created.status!,
            ...(placed.created.goal && { goal: placed.created.goal }),
            title: input.title,
            verdicts: [],
            createdBy: caller.actorId,
            createdAt: now(),
          };
          await save(caller.projectId, 'task', task.id, task.board, task);
          return { task: task.id, frame, status: task.status };
        },
      }),
    );

    const page = [
      {
        name: 'board.agents.state',
        description: "A board's tasks, the latest run of each, and whether the person's machine is on.",
        inputSchema: stateSchema,
        readOnly: true,
        handler: async (caller: Caller, input: z.infer<typeof stateSchema>): Promise<AgentsState> => {
          const scene = await board.scene(caller, input.board, Number.MAX_SAFE_INTEGER);
          const tasks = await rows<AgentTask>(caller.projectId, 'task', scene.board.id);
          const runs = await rows<AgentRun>(caller.projectId, 'run', scene.board.id);
          const live = await board.scene(caller, input.board);
          const standingFrames = new Set(live.elements.map((el) => el.id));
          const connector = await connectorOf(caller);
          const shownTasks = await Promise.all(
            tasks
              .filter((task) => standingFrames.has(task.frame))
              .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map(async (task) => {
                const run = task.run ? runs.find((held) => held.id === task.run) : undefined;
                const { picture: _picture, ...shown } = run ?? ({} as AgentRun);
                const spec = await specOf(caller, task);
                return {
                  ...task,
                  ...(run && { latest: shown as AgentRun }),
                  said: run ? standing(run, connector).text : '',
                  ...(run &&
                    JSON.stringify(spec.checks.map((held) => held.text)) !==
                      JSON.stringify(run.spec.checks.map((held) => held.text)) && { changed: true }),
                  checks: spec.checks.map((held) => {
                    const verdict = run?.verdicts?.find((one) => one.check === held.id);
                    return { id: held.id, text: held.text, ...(verdict && { verdict }) };
                  }),
                };
              }),
          );
          return {
            tasks: shownTasks,
            connector: connector ?? null,
            waiting: runs.filter((run) => run.state === 'queued').length,
          };
        },
      },
      {
        name: 'board.agents.handoff',
        description: "Hand a task, as it stands on the board now, to one of the person's own agents.",
        inputSchema: handoffSchema,
        handler: async (caller: Caller, input: z.infer<typeof handoffSchema>) => {
          // A person's alone: a board's words, or an agent reading them, never start code on a machine.
          check(!isAgentAudience(caller), 'forbidden', 'Only a person can hand off a task', 403);
          const task = await read<AgentTask>(caller.projectId, 'task', input.task);
          check(task, 'not_found', 'Task not found', 404);
          const prior = task.run
            ? await read<AgentRun>(caller.projectId, 'run', task.run)
            : undefined;
          check(!prior || !ACTIVE.has(prior.state), 'board_task_busy', 'This task is running', 409);
          const spec = await specOf(caller, task);
          check(spec.checks.length, 'board_task_unmeasured', 'Add a check to the frame first', 400);
          const failures =
            input.sendBack && prior?.verdicts
              ? prior.verdicts.filter((verdict) => !verdict.pass)
              : [];
          const look = await ctx.tools
            .call('board.read:look', caller, { board: task.board })
            .catch(() => undefined);
          const picture = (look as { image?: { data: string; mimeType?: string } } | undefined)
            ?.image;
          const run: AgentRun = {
            id: newId('run_board'),
            task: task.id,
            board: task.board,
            owner: caller.actorId,
            harness: input.harness,
            state: 'queued',
            spec: {
              ...spec,
              ...(input.sendBack &&
                prior && {
                  previous: {
                    summary: prior.result?.summary ?? '',
                    failures,
                    ...(prior.harness === input.harness && prior.session && { session: prior.session }),
                  },
                }),
            },
            ...(picture && { picture }),
            createdAt: now(),
          };
          const updated = { ...task, run: run.id, verdicts: [] };
          await state.transaction(async (tx) => {
            await put(tx, caller.projectId, 'run', run.id, task.board, run);
            await put(tx, caller.projectId, 'task', task.id, task.board, updated);
          });
          const connector = await connectorOf(caller);
          await draw(caller, task.board, [
            ...task.verdicts.map((verdict) => ({ op: 'delete', ids: [verdict] })),
            ...spec.checks.map((held) => ({ op: 'edit', id: held.id, color: 'yellow' })),
            { op: 'edit', id: task.status, ...standing(run, connector) },
          ]);
          const { picture: _picture, ...shown } = run;
          return { run: shown };
        },
      },
      {
        name: 'board.agents.stop',
        description: 'Stop a run: at once if it has not started, or by telling the machine.',
        inputSchema: stopSchema,
        handler: async (caller: Caller, input: z.infer<typeof stopSchema>) => {
          check(!isAgentAudience(caller), 'forbidden', 'Only a person can stop a run', 403);
          const run = await read<AgentRun>(caller.projectId, 'run', input.run);
          check(run, 'not_found', 'Run not found', 404);
          check(ACTIVE.has(run.state), 'board_run_over', 'This run is over', 409);
          const next: AgentRun = { ...run, state: run.state === 'queued' ? 'stopped' : 'stopping' };
          await save(caller.projectId, 'run', run.id, run.board, next);
          const task = await read<AgentTask>(caller.projectId, 'task', run.task);
          if (task) await show(caller, task, next);
          return { state: next.state };
        },
      },
      {
        name: 'board.agents.poll',
        description:
          "The person's machine dials out: says it is here and what it can run, and takes the oldest waiting run of its own person's.",
        inputSchema: pollSchema,
        handler: async (caller: Caller, input: z.infer<typeof pollSchema>) => {
          const connector: AgentConnector = {
            actor: caller.actorId,
            name: input.name,
            workspace: input.workspace,
            harnesses: input.harnesses,
            seen: now(),
          };
          await save(caller.projectId, 'connector', caller.actorId, null, connector);
          const mine = (await rows<AgentRun>(caller.projectId, 'run')).filter(
            (run) => run.owner === caller.actorId,
          );
          // A connector starting afresh holds no process: what it left running is lost.
          if (input.fresh)
            for (const run of mine.filter((held) => ['running', 'judging', 'stopping'].includes(held.state))) {
              const lost: AgentRun = { ...run, state: 'error', error: 'lost when its machine restarted' };
              await save(caller.projectId, 'run', run.id, run.board, lost);
              const task = await read<AgentTask>(caller.projectId, 'task', run.task);
              if (task) await show(caller, task, lost);
            }
          const stop = mine.filter((run) => run.state === 'stopping').map((run) => run.id);
          const next = mine
            .filter((run) => run.state === 'queued')
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (!next || input.capacity === false) return { stop };
          const claimed: AgentRun = { ...next, state: 'running', startedAt: now(), step: 'starting' };
          await save(caller.projectId, 'run', next.id, next.board, claimed);
          const task = await read<AgentTask>(caller.projectId, 'task', next.task);
          if (task) await show(caller, task, claimed);
          return { stop, run: claimed };
        },
      },
      {
        name: 'board.agents.report',
        description: "What a run is doing and how it came out, from the person's machine.",
        inputSchema: reportSchema,
        handler: async (caller: Caller, input: z.infer<typeof reportSchema>) => {
          const run = await read<AgentRun>(caller.projectId, 'run', input.run);
          check(run && run.owner === caller.actorId, 'not_found', 'Run not found', 404);
          const final = input.state && !ACTIVE.has(input.state);
          const next: AgentRun = {
            ...run,
            ...(input.step && { step: input.step }),
            ...(input.session && { session: input.session }),
            ...(input.verdicts && { verdicts: input.verdicts as CheckVerdict[] }),
            ...(input.result && { result: input.result }),
            ...(input.error && { error: input.error }),
            ...(run.state !== 'stopping' || final ? input.state && { state: input.state } : {}),
            ...(final && { endedAt: now() }),
          };
          await save(caller.projectId, 'run', run.id, run.board, next);
          const task = await read<AgentTask>(caller.projectId, 'task', run.task);
          if (!task) return { stop: next.state === 'stopping' };
          await show(caller, task, next);
          if (input.verdicts) await verdictsOn(caller, task, next);
          if (final && input.result) await cardOf(caller, task, next);
          return { stop: next.state === 'stopping' };
        },
      },
    ];
    /** Each check turns the colour it came out, its reason in the frame beside it. */
    const verdictsOn = async (caller: Caller, task: AgentTask, run: AgentRun) => {
      const scene = await board.scene(caller, task.board);
      const held = new Set(scene.elements.map((el) => el.id));
      const shown = (run.verdicts ?? []).filter((verdict) => held.has(verdict.check));
      const drawn = await draw(caller, task.board, [
        // Green is earned by an exit code; another agent's yes leaves it for the person's eyes.
        ...shown.map((verdict) => ({
          op: 'edit',
          id: verdict.check,
          color: !verdict.pass ? 'red' : verdict.how === 'command' ? 'green' : 'blue',
        })),
        ...shown.map((verdict, index) => {
          const beside = scene.elements.find((el) => el.id === verdict.check)!;
          return {
            op: 'text',
            key: `v${index}`,
            text: wrapped(line(`${verdict.how === 'judge' ? `${verdict.by}: ` : ''}${verdict.reason}`, 100)),
            fontSize: 13,
            color: 'gray',
            at: [beside.x + CHECK_WIDTH + 16, beside.y + 4],
            in: task.frame,
          };
        }),
      ]);
      const verdicts = Object.entries(drawn.created)
        .filter(([key]) => /^v\d+$/.test(key))
        .map(([, made]) => made);
      await save(caller.projectId, 'task', task.id, task.board, { ...task, verdicts });
    };
    /** The result stands beside the frame, as a card that opens, joined to what it answers. */
    const cardOf = async (caller: Caller, task: AgentTask, run: AgentRun) => {
      const { summary = '', stat = '' } = run.result ?? {};
      const body = [
        summary,
        '',
        '## Checks',
        ...(run.verdicts ?? []).map((verdict) => {
          const said = run.spec.checks.find((held) => held.id === verdict.check)?.text ?? '';
          const outcome = !verdict.pass ? 'Fail' : verdict.how === 'command' ? 'Pass' : 'For your eyes';
          return `- **${outcome}** ${said}: ${verdict.reason} (${verdict.how === 'command' ? 'ran it' : `${verdict.by}'s reading`})`;
        }),
        ...(stat ? ['', '## Changes', '```', stat, '```'] : []),
      ].join('\n');
      const taken = run.startedAt && run.endedAt
        ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000)
        : undefined;
      await draw(caller, task.board, [
        {
          op: 'page',
          key: 'result',
          text: `${NAMES[run.harness]} result${taken === undefined ? '' : `, ${taken} s`}`,
          body,
          near: task.frame,
          side: 'below',
        },
      ]);
    };
    for (const definition of page)
      ctx.effect(() => ctx.tools.register({ ...definition, tier: 'ui' as const }));
  },
};
export default boardAgentsPlugin;
