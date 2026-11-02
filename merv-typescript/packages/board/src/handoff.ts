import type { Context } from 'cordis';
import { z } from 'zod';
import { isAgentAudience } from '@merv/api/audience';
import type {} from '@merv/api/types';
import type {} from '@merv/ui/types';
import { check, newId, now, type Caller, type State } from '@merv/contracts';
import { id } from './input.js';
import { redact } from './transcript.js';
import {
  NAMES,
  type Ask,
  type Command,
  type Connector,
  type Harness,
  type Run,
  type RunEvent,
  type RunState,
} from './handoff-models.js';
import type { BoardDrawn } from './types.js';

/**
 * Hand what is on a board to the person's own Claude Code or Codex, on their own machine, and
 * follow the session beside the board. The machine dials out (clients/board-connect) and polls;
 * nothing reaches into it, no repo path or credential reaches here. A session is a record and its
 * events, and a small tag drawn beside what was handed off says how it stands. Starting, steering,
 * stopping and answering an approval are a signed-in person's alone: nothing a board says and
 * nothing an agent writes can do them. Inert unless MERV_BOARD_HANDOFF names who may use it.
 */
/** A machine unheard of for this long is offline. */
const ONLINE_MS = 12_000;
const ACTIVE = new Set<RunState>(['queued', 'running', 'asking']);
const harness = z.enum(['claude', 'codex']);
const line = (max: number) => z.string().trim().min(1).max(max);
const startSchema = z.strictObject({
  board: id,
  elements: z.array(z.string().min(1).max(100)).min(1).max(200),
  harness,
  repo: line(120),
  brief: line(600),
  words: z.string().max(8_000),
  picture: z.strictObject({ data: z.string().max(1_500_000), mimeType: line(40) }).optional(),
});
const readSchema = z.strictObject({ board: id });
const sessionSchema = z.strictObject({ run: id, after: z.number().int().min(0).optional() });
const saySchema = z.strictObject({ run: id, text: line(8_000) });
const stopSchema = z.strictObject({ run: id });
const answerSchema = z.strictObject({ run: id, ask: line(100), option: line(100) });
const pollSchema = z.strictObject({
  name: line(80),
  repos: z.array(line(120)).max(50),
  claude: z.boolean(),
  codex: z.boolean(),
  started: line(40),
});
const eventSchema = z.strictObject({
  id: z.string().max(100).optional(),
  kind: z.enum(['agent', 'tool', 'note']),
  text: z.string().max(20_000),
  status: z.string().max(40).optional(),
});
const reportSchema = z.strictObject({
  run: id,
  state: z.enum(['running', 'asking', 'done', 'stopped', 'failed']).optional(),
  session: z.string().max(200).optional(),
  events: z.array(eventSchema).max(100).optional(),
  ask: z
    .strictObject({
      id: line(100),
      title: z.string().max(400),
      options: z
        .array(
          z.strictObject({ id: line(100), name: z.string().max(200), kind: z.string().max(40) }),
        )
        .max(8),
    })
    .optional(),
  result: z
    .strictObject({
      summary: z.string().max(4_000),
      branch: z.string().max(200),
      dir: z.string().max(400),
      stat: z.string().max(2_000),
    })
    .optional(),
  error: z.string().max(400).optional(),
});

const migrations = [
  {
    version: 1,
    sql: `CREATE TABLE board_handoff(project_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(project_id,kind,id));
CREATE INDEX board_handoff_owner ON board_handoff(project_id,kind,owner);`,
  },
];

export const boardHandoffPlugin = {
  name: 'merv-board-handoff',
  inject: ['board', 'tools', 'state', 'ui'],
  async apply(ctx: Context) {
    const flag = process.env.MERV_BOARD_HANDOFF?.trim();
    if (!flag) return;
    const listed = new Set(
      flag
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean),
    );
    const emails = [...listed].filter((one) => one.includes('@'));
    const subjects = new Map<string, string | null>();
    /** Whether this person is let in: everyone, or a listed actor, account id or email. */
    const allowed = async (caller: Caller) => {
      if (flag === 'all' || listed.has(caller.actorId)) return true;
      const subject = caller.human?.subject;
      if (!subject) return false;
      if (listed.has(subject)) return true;
      const identity = ctx.get('identity') as
        { findUserByEmail(email: string): Promise<{ subject: string } | null> } | undefined;
      if (!identity) return false;
      for (const email of emails) {
        if (!subjects.has(email))
          subjects.set(
            email,
            (await identity.findUserByEmail(email).catch(() => null))?.subject ?? null,
          );
        if (subjects.get(email) === subject) return true;
      }
      return false;
    };
    const admit = async (caller: Caller) =>
      check(await allowed(caller), 'forbidden', 'Hand-off is not open to this account', 403);
    const person = (caller: Caller) =>
      check(!isAgentAudience(caller), 'forbidden', 'Only a person can do this', 403);

    const state: State = ctx.state;
    await state.migrate('board-handoff', migrations);
    const put = (caller: Caller, kind: string, key: string, owner: string, record: object) =>
      state.transaction((tx) =>
        tx.run(
          `INSERT INTO board_handoff(project_id,kind,id,owner,record) VALUES(?,?,?,?,?)
           ON CONFLICT(project_id,kind,id) DO UPDATE SET record=excluded.record`,
          caller.projectId,
          kind,
          key,
          owner,
          JSON.stringify(record),
        ),
      );
    const get = async <T>(caller: Caller, kind: string, key: string) => {
      const row = await state.transaction((tx) =>
        tx.get<{ record: string }>(
          'SELECT record FROM board_handoff WHERE project_id=? AND kind=? AND id=?',
          caller.projectId,
          kind,
          key,
        ),
      );
      return row ? (JSON.parse(row.record) as T) : undefined;
    };
    const all = async <T>(caller: Caller, kind: string, owner?: string) =>
      (
        await state.transaction((tx) =>
          tx.all<{ record: string }>(
            `SELECT record FROM board_handoff WHERE project_id=? AND kind=?${owner ? ' AND owner=?' : ''} ORDER BY id`,
            caller.projectId,
            kind,
            ...(owner ? [owner] : []),
          ),
        )
      ).map((row) => JSON.parse(row.record) as T);

    const connectorOf = async (caller: Caller) => {
      const held = await get<Connector>(caller, 'connector', caller.actorId);
      return held && { ...held, online: Date.now() - Date.parse(held.seen) < ONLINE_MS };
    };
    // One change to a run at a time: the machine's reports and the person's words arrive together.
    const locks = new Map<string, Promise<unknown>>();
    const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
      const next = (locks.get(key) ?? Promise.resolve()).then(work, work);
      locks.set(
        key,
        next.catch(() => undefined),
      );
      return next;
    };
    const runOf = async (caller: Caller, key: string) => {
      const run = await get<Run>(caller, 'run', key);
      check(run && run.owner === caller.actorId, 'not_found', 'Session not found', 404);
      return run;
    };
    const saveRun = (caller: Caller, run: Run) =>
      put(caller, 'run', run.id, run.owner, { ...run, updatedAt: now() });
    const addEvent = async (caller: Caller, run: Run, event: Omit<RunEvent, 'seq' | 'at'>) => {
      // An event with an id is one thing growing (a message, a tool call): its row is rewritten.
      const known = event.id
        ? (await all<RunEvent>(caller, `event:${run.id}`)).find((one) => one.id === event.id)
        : undefined;
      const seq = known?.seq ?? ++run.seq;
      await put(caller, `event:${run.id}`, String(seq).padStart(8, '0'), run.owner, {
        ...event,
        text: redact(event.text),
        seq,
        at: known?.at ?? now(),
      });
    };
    const WORDS: Record<RunState, string> = {
      queued: 'starting',
      running: 'running',
      asking: 'needs you',
      done: 'done',
      stopped: 'stopped',
      failed: 'failed',
    };
    /** The tag's words: who has it and how it stands, in a few plain words. */
    const standing = (run: Run, online: boolean | undefined) =>
      `${NAMES[run.harness]} · ${!online && ACTIVE.has(run.state) ? 'offline' : WORDS[run.state]}`;
    const draw = (caller: Caller, board: string, ops: unknown[]) =>
      ctx.board.draw(caller, { board, ops } as never, [], false).catch(() => undefined);
    const show = async (caller: Caller, run: Run) =>
      draw(caller, run.board, [
        { op: 'edit', id: run.tag, text: standing(run, (await connectorOf(caller))?.online) },
      ]);
    const shown = ({ words: _w, commands: _c, ...run }: Run) => run;
    /** A machine gone quiet with sessions running: their tags say offline until it is heard again. */
    const sweep = async () => {
      const quiet = await state.transaction((tx) =>
        tx.all<{ project_id: string; owner: string; record: string }>(
          "SELECT project_id,owner,record FROM board_handoff WHERE kind='connector'",
        ),
      );
      for (const row of quiet) {
        if (Date.now() - Date.parse((JSON.parse(row.record) as Connector).seen) < ONLINE_MS)
          continue;
        const caller = { actorId: row.owner, projectId: row.project_id } as Caller;
        for (const run of await all<Run>(caller, 'run', row.owner)) {
          if (!ACTIVE.has(run.state) || run.offline) continue;
          await serial(run.id, async () => {
            const live = (await get<Run>(caller, 'run', run.id)) ?? run;
            live.offline = true;
            await saveRun(caller, live);
            await draw(caller, live.board, [
              { op: 'edit', id: live.tag, text: standing(live, false) },
            ]);
          });
        }
      }
    };
    ctx.effect(() => {
      const timer = setInterval(() => void sweep().catch(() => undefined), 5000);
      return () => clearInterval(timer);
    });
    const command = async (caller: Caller, run: Run, made: Omit<Command, 'id'>) => {
      run.commands.push({ id: newId('cmd'), ...made });
      await saveRun(caller, run);
    };

    ctx.effect(() =>
      ctx.ui.register({
        id: 'handoff',
        label: 'Hand-off',
        group: 'hidden',
        order: 99,
        path: '/handoff',
        view: { kind: 'hidden' },
      }),
    );
    const tools = [
      {
        name: 'handoff.read',
        description: "A board's hand-off sessions and whether the person's machine is on.",
        inputSchema: readSchema,
        readOnly: true,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof readSchema>) => {
          if (!(await allowed(caller))) return { enabled: false, runs: [], connector: null };
          const connector = await connectorOf(caller);
          const runs = (await all<Run>(caller, 'run', caller.actorId))
            .filter((run) => run.board === input.board)
            .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(shown);
          return { enabled: true, connector: connector ?? null, runs };
        },
      },
      {
        name: 'handoff.session',
        description: 'One hand-off session and its events after a sequence number.',
        inputSchema: sessionSchema,
        readOnly: true,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof sessionSchema>) => {
          await admit(caller);
          const run = await runOf(caller, input.run);
          const events = (await all<RunEvent>(caller, `event:${run.id}`)).filter(
            (event) => event.seq > (input.after ?? 0),
          );
          return { run: shown(run), events, online: !!(await connectorOf(caller))?.online };
        },
      },
      {
        name: 'handoff.start',
        description: "Hand shapes on a board to one of the person's own agents, on their machine.",
        inputSchema: startSchema,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof startSchema>) => {
          await admit(caller);
          person(caller);
          const connector = await connectorOf(caller);
          check(connector?.online, 'handoff_offline', 'Your machine is not connected', 409);
          check(
            connector.repos.includes(input.repo),
            'handoff_repo',
            'Not a folder it offers',
            400,
          );
          check(
            connector[input.harness],
            'handoff_harness',
            `${NAMES[input.harness]} is not signed in there`,
            400,
          );
          const scene = await ctx.board.scene(caller, input.board);
          const near = scene.elements.find((el) => input.elements.includes(el.id));
          check(near, 'not_found', 'Those shapes are no longer on the board', 404);
          const run: Run = {
            id: newId('handoff'),
            board: input.board,
            owner: caller.actorId,
            harness: input.harness,
            repo: input.repo,
            brief: input.brief,
            words: input.words,
            tag: '',
            state: 'queued',
            commands: [],
            seq: 0,
            createdAt: now(),
            updatedAt: now(),
          };
          const drawn = (await draw(caller, input.board, [
            {
              op: 'box',
              key: 'tag',
              text: standing(run, true),
              width: 190,
              height: 36,
              fontSize: 14,
              near: near.id,
              side: 'below',
            },
          ])) as BoardDrawn | undefined;
          check(drawn?.created.tag, 'handoff_tag', 'Could not draw beside it', 500);
          run.tag = drawn.created.tag;
          await saveRun(caller, run);
          if (input.picture) await put(caller, 'picture', run.id, run.owner, input.picture);
          await addEvent(caller, run, { kind: 'you', text: input.brief });
          await saveRun(caller, run);
          return { run: shown(run) };
        },
      },
      {
        name: 'handoff.say',
        description: 'Say something to a hand-off session: a follow-up, or steering mid-turn.',
        inputSchema: saySchema,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof saySchema>) => {
          await admit(caller);
          return serial(input.run, async () => {
            person(caller);
            const run = await runOf(caller, input.run);
            check(run.state !== 'queued', 'handoff_busy', 'It has not started yet', 409);
            const steer = run.state === 'running' || run.state === 'asking';
            await addEvent(caller, run, { kind: 'you', text: input.text });
            if (!steer) run.state = 'running';
            await command(caller, run, { kind: steer ? 'steer' : 'say', text: input.text });
            await show(caller, run);
            return { steered: steer };
          });
        },
      },
      {
        name: 'handoff.stop',
        description: 'Stop the turn a hand-off session is on.',
        inputSchema: stopSchema,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof stopSchema>) => {
          await admit(caller);
          return serial(input.run, async () => {
            person(caller);
            const run = await runOf(caller, input.run);
            check(ACTIVE.has(run.state), 'handoff_idle', 'It is not running', 409);
            await command(caller, run, { kind: 'stop' });
            return {};
          });
        },
      },
      {
        name: 'handoff.answer',
        description: "Answer a hand-off session's approval request with one of its options.",
        inputSchema: answerSchema,
        for: 'people' as const,
        handler: async (caller: Caller, input: z.infer<typeof answerSchema>) => {
          await admit(caller);
          return serial(input.run, async () => {
            person(caller);
            const run = await runOf(caller, input.run);
            const ask = run.ask;
            check(ask?.id === input.ask, 'handoff_ask', 'That question is no longer open', 409);
            const option = ask.options.find((one) => one.id === input.option);
            check(option, 'handoff_option', 'Not one of its options', 400);
            delete run.ask;
            run.state = 'running';
            await addEvent(caller, run, {
              kind: 'ask',
              id: `ask:${ask.id}`,
              text: ask.title,
              status: option.kind.startsWith('allow') ? 'allowed' : 'denied',
            });
            await command(caller, run, { kind: 'answer', ask: ask.id, option: option.id });
            await show(caller, run);
            return {};
          });
        },
      },
      // The machine's own two: a poll that carries what it offers, and reports of what happened.
      {
        name: 'handoff.poll',
        description:
          "The connector's poll: what to start and what the person said, for this machine.",
        inputSchema: pollSchema,
        handler: async (caller: Caller, input: z.infer<typeof pollSchema>) => {
          await admit(caller);
          const before = await get<Connector>(caller, 'connector', caller.actorId);
          const connector: Connector = { ...input, seen: now() };
          await put(caller, 'connector', caller.actorId, caller.actorId, connector);
          const runs = await all<Run>(caller, 'run', caller.actorId);
          const restarted = before && before.started !== input.started;
          // Heard again after a quiet spell: tags that said offline say what they did.
          for (const run of runs)
            if (run.offline && !restarted) {
              delete run.offline;
              await saveRun(caller, run);
              await show(caller, run);
            }
          const out: object[] = [];
          for (const held of runs) {
            await serial(held.id, async () => {
              const run = (await get<Run>(caller, 'run', held.id)) ?? held;
              if (
                restarted &&
                ACTIVE.has(run.state) &&
                run.state !== 'queued' &&
                !run.commands.length
              ) {
                // The machine came back without the session: it is lost until spoken to again.
                run.state = 'failed';
                run.error = 'Your machine restarted. Say something to carry on.';
                await saveRun(caller, run);
                await show(caller, run);
                return;
              }
              if (run.state !== 'queued' && !run.commands.length) return;
              const { commands } = run;
              run.commands = [];
              await saveRun(caller, run);
              const picture = run.session
                ? undefined
                : await get<object>(caller, 'picture', run.id);
              out.push({ ...run, commands, ...(picture && { picture }) });
            });
          }
          return { runs: out };
        },
      },
      {
        name: 'handoff.report',
        description: "The connector's report of a session: its state, events and result.",
        inputSchema: reportSchema,
        handler: async (caller: Caller, input: z.infer<typeof reportSchema>) => {
          await admit(caller);
          return serial(input.run, async () => {
            const run = await runOf(caller, input.run);
            for (const event of input.events ?? []) await addEvent(caller, run, event);
            if (input.session) run.session = input.session;
            if (input.ask) {
              run.ask = input.ask;
              await addEvent(caller, run, {
                kind: 'ask',
                id: `ask:${input.ask.id}`,
                text: input.ask.title,
                status: 'open',
              });
            }
            if (input.result) run.result = input.result;
            if (input.error) run.error = input.error;
            if (input.state) {
              if (input.state !== 'asking') delete run.ask;
              if (input.state === 'running') {
                delete run.error;
                delete run.offline;
              }
              run.state = input.state;
            }
            await saveRun(caller, run);
            if (input.state || input.ask) await show(caller, run);
            return {};
          });
        },
      },
    ];
    for (const definition of tools)
      ctx.effect(() => ctx.tools.register({ ...definition, tier: 'ui' as const }));
  },
};
export default boardHandoffPlugin;
