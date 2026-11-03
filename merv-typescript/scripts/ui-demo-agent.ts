import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import { FleetService } from '@merv/fleet';
import fleetToolsPlugin from '@merv/fleet/tools';
import fleetUiPlugin from '@merv/fleet/ui';
import piPlugin from '@merv/pi';
import piApiPlugin from '@merv/pi/api';
import piToolsPlugin from '@merv/pi/tools';
import piUiPlugin from '@merv/pi/ui';
import { runPiWorker } from '@merv/pi/worker';
import type { FleetRuntimeHandle } from '@merv/fleet/types';
import { profiles } from '../tests/fixtures/runtime-records.js';
import type { createApp } from '../src/app.js';
import { FakeRuntimes } from '../tests/fixtures/runtimes.js';

/**
 * The Agent for the browser demo (`npm run demo:ui -- --agent`): the real Agent service, Fleet and
 * worker, on a machine that is this process and a model that is the script below. Nothing leaves
 * this computer: Fleet rents by starting the worker here, and the worker's model calls are
 * answered by `scripted` instead of the relay. Everything the page is sent — stages, streamed
 * words, tool calls and their receipts, the machine and its idle release — is what
 * production's page is sent. MERV_DEMO_AGENT_IDLE sets the idle release in seconds (600).
 *
 * The script reads the person's words: `pause` and `start` flip the dispatch switch, `claim`
 * makes a call that will be refused, `status` and `tasks` read first, `file` fetches the newest
 * file's download link, `screen` looks at the person's screen, `open` or `pull up`
 * puts the newest file (or a named page) on it, `board` draws ideas on a new board and opens it
 * (`look at the board` sees the newest one drawn), `new task` creates one,
 * and anything else reads the project
 * and answers at length.
 */
export type Step = { call: string; input: object } | { say: string };
const LONG = [
  'Here is where the project stands.',
  '',
  '**Work.** Two tasks are in progress and one waits for review. The sweep over weight decay is the one to watch: its agent last reported forty seconds ago.',
  '',
  '**Next.** Once the held-out split is clean, the width ablation can start. Nothing needs you right now.',
  '',
  '| Unit | Stage |',
  '| --- | --- |',
  '| Clean the held-out split | In progress |',
  '| Pin the evaluation seeds | In review |',
].join('\n');
const dispatch = (enabled: boolean): Step[] => [
  { call: 'session.dispatch', input: { enabled } },
  {
    say: `I’ve ${enabled ? 'started' : 'paused'} dispatch. ${enabled ? 'Agents take new work again' : 'Agents take no new work; work already leased keeps running'}.`,
  },
];
/** One action of a noun tool, its arguments under its own name. */
export const act = (tool: string, action: string, input: object): Step => ({
  call: tool,
  input: { action, [action]: input },
});
/** The first record of a list the agent was shown, whole or as its index. */
const newest = (shown: unknown) =>
  ((Array.isArray(shown) ? shown : (shown as { index?: unknown[] })?.index)?.[0] as { id?: string })
    ?.id;
/** What `Draft …` writes in the outcome the note names, a section a call, as the guide asks. */
const SECTIONS = [
  "Goal: measure what the recall layer is worth, on the board's held-out set.",
  '## Method\n\n- Remove the top-k recall layer\n- Keep the reranker\n  - no retraining\n- Score answer F1, n=2,000',
  '## Risks\n\nThe reranker may overfit once recall is gone, so a **second split** is held back to compare.\n\n| Arm | F1 |\n| --- | --- |\n| baseline | 0.71 |\n| ablation | ? |',
  '## Budget\n\nFour GPU hours, on one machine.',
];
function drafted(asked: string, note: string): Step[] {
  const board = /\[board ([\w-]+)/.exec(note)?.[1];
  const outcome = /outcome ([\w-]+)/.exec(note)?.[1];
  if (!board || !outcome) return [{ say: 'Open the outcome beside a board, and ask me again.' }];
  const calls = SECTIONS.map((section, index) =>
    act(
      'board.write',
      'outcome',
      index
        ? {
            board,
            outcome,
            edits: [
              {
                find: SECTIONS[index - 1]!.slice(-40),
                replace: `${SECTIONS[index - 1]!.slice(-40)}\n\n${section}`,
              },
            ],
          }
        : {
            board,
            outcome,
            title: asked.includes('PRD') ? 'Retrieval ablation PRD' : 'Retrieval ablation plan',
            content: section,
            expectedRevision: 1,
          },
    ),
  );
  return [...calls, { say: 'It is written beside the board; change whatever you like.' }];
}
/** The shapes the note says are selected or circled, with where get says each stands. */
function pointed(note: string, read: (tool: string) => unknown) {
  const ids = /(?:selected|circled) ([\w,-]+)/.exec(note)?.[1]?.split(',') ?? [];
  const got = read('board.read') as { shapes?: { id: string; at: number[]; size: number[] }[] };
  const shapes = (got?.shapes ?? []).filter((shape) => ids.includes(shape.id));
  const x = Math.min(...shapes.map((s) => s.at[0]!));
  const y = Math.min(...shapes.map((s) => s.at[1]!));
  const right = Math.max(...shapes.map((s) => s.at[0]! + s.size[0]!));
  const bottom = Math.max(...shapes.map((s) => s.at[1]! + s.size[1]!));
  return { ids, shapes, box: { x, y, width: right - x, height: bottom - y } };
}
type Plan = (asked: string, read: (tool: string) => unknown, note?: string) => Step[];
export function plan(asked: string, read: (tool: string) => unknown, note = ''): Step[] {
  if (/^Draft /.test(asked)) return drafted(asked, note);
  const board = /\[board ([\w-]+)/.exec(note)?.[1];
  // The person's own lines carried on, as a proposal in their pen, joined to their last stroke.
  if (board && /\b(finish|continue|complete)\b/i.test(asked)) {
    const { ids, shapes, box } = pointed(note, read);
    const w = Math.max(80, box.width || 0);
    const h = Math.max(40, box.height || 0);
    return [
      act('board.read', 'get', { board }),
      ...(shapes.length
        ? [
            act('board.write', 'draw', {
              board,
              ops: [
                {
                  op: 'sketch',
                  proposed: true,
                  like: ids[0],
                  size: 'native',
                  at: [box.x + box.width, box.y],
                  strokes: [
                    {
                      path: `M0 ${h} C ${w / 3} ${h}, ${w / 3} 0, ${(2 * w) / 3} 0 S ${w} ${h / 2}, ${w * 1.2} 0`,
                    },
                  ],
                  say: 'Carrying your line on the way it was going.',
                },
              ],
            }),
            { say: 'Keep it if that is where it was going.' },
          ]
        : [{ say: 'Select the lines to finish, and ask again.' }]),
    ];
  }
  // A variant beside the original, in a frame of its own, so both stand on one screen.
  if (board && /\b(another way|variant|alternative)\b/i.test(asked)) {
    const { shapes, box } = pointed(note, read);
    const rightmost = shapes.toSorted((a, b) => b.at[0]! + b.size[0]! - a.at[0]! - a.size[0]!)[0];
    const side = Math.max(240, Math.round(box.width || 0));
    return [
      act('board.read', 'get', { board }),
      ...(rightmost
        ? [
            act('board.write', 'draw', {
              board,
              ops: [
                {
                  op: 'frame',
                  key: 'v',
                  title: 'Another way: as a loop',
                  width: Math.max(240, Math.round(box.width)),
                  height: Math.max(160, Math.round(box.height)),
                  near: rightmost.id,
                  side: 'right',
                  say: 'Same idea, as a loop instead.',
                },
              ],
            }),
            act('board.write', 'draw', {
              board,
              ops: [
                { op: 'box', key: 'a', text: 'Draft', in: 'v', width: side / 2 },
                {
                  op: 'box',
                  key: 'b',
                  text: 'Check',
                  in: 'v',
                  width: side / 2,
                  say: 'Then it checks itself.',
                },
                { op: 'arrow', from: 'a', to: 'b' },
                { op: 'arrow', from: 'b', to: 'a', label: 'again' },
              ],
            }),
            { say: 'Both are there now, side by side.' },
          ]
        : [{ say: 'Select what to try another way, and ask again.' }]),
    ];
  }
  // A mark on its drawing is answered on the spot, beside what it marks.
  if (board && /circled|selected/.test(note) && /\b(this|here|fix|change|wrong)\b/i.test(asked)) {
    const { ids } = pointed(note, read);
    return [
      act('board.read', 'get', { board }),
      act('board.write', 'draw', {
        board,
        ops: [
          {
            op: 'note',
            text: 'Changed here',
            color: 'blue',
            near: ids[0],
            side: 'below',
            say: 'Right, this is the part to change.',
          },
        ],
      }),
      { say: 'I changed it where you marked.' },
    ];
  }
  const file = /^Create a task from outcome .*?(art_[\w-]+)/.exec(asked)?.[1];
  if (file)
    return [
      act('task.write', 'create', {
        title: 'Retrieval ablation',
        goal: `Read ${file} first, then do as it says.`,
        checks: ['Done as the file says'],
        requestId: `demo-agent-${randomUUID()}`,
      }),
      { say: 'I created the task, and a Fleet worker will take it up.' },
    ];
  if (/pause/i.test(asked)) return dispatch(false);
  // A drawing in many small calls, to watch and to step in on.
  if (/\bin steps\b/i.test(asked)) {
    const drawn = read('board.write') as { board?: { id: string } } | undefined;
    const on = /board_\w+/.exec(asked)?.[0] ?? drawn?.board?.id;
    const steps = ['Input', 'Hidden', 'Output', 'Loss', 'Update', 'Repeat', 'Check', 'Done'];
    const box = (text: string, i: number) => ({
      op: 'box',
      text,
      at: [(i % 4) * 240, Math.floor(i / 4) * 160],
      width: 200,
    });
    // Two calls of four, each with a line at its first box and at its third.
    return [
      ...[0, 4].map((from) =>
        act('board.write', 'draw', {
          ...(on ? { board: on } : { title: 'In steps' }),
          ops: steps.slice(from, from + 4).map((text, i) => ({
            ...box(text, from + i),
            ...(i % 2 === 0 && { say: `${text} comes next, and the rest leans on it.` }),
          })),
        }),
      ),
      { say: 'That is all of it.' },
    ];
  }
  if (/\brose\b/i.test(asked)) {
    const drawn = read('board.write') as { board?: { id: string } } | undefined;
    return [
      act('board.write', 'draw', {
        title: 'A rose',
        ops: [
          {
            op: 'sketch',
            key: 'rose',
            size: 'l',
            strokes: [
              {
                path: 'M50 10 C 25 5, 15 30, 25 45 C 30 55, 70 55, 75 45 C 85 30, 75 5, 50 10 Z',
                fill: 'red',
                color: 'red',
              },
              {
                path: 'M25 45 C 20 60, 40 70, 50 62 C 40 60, 30 55, 25 45 Z',
                fill: 'pink',
                color: 'red',
              },
              {
                path: 'M75 45 C 80 60, 60 70, 50 62 C 60 60, 70 55, 75 45 Z',
                fill: 'pink',
                color: 'red',
              },
              {
                path: 'M50 22 C 40 22, 38 35, 50 38 C 60 40, 62 28, 54 26 C 48 25, 46 31, 51 32',
                color: 'red',
              },
              { path: 'M50 62 C 48 90, 52 120, 50 160', color: 'green', width: 'bold' },
              {
                path: 'M50 110 C 30 95, 15 105, 20 115 C 30 118, 42 115, 50 110 Z',
                fill: 'green',
                color: 'green',
              },
              {
                path: 'M50 130 C 70 115, 85 125, 80 135 C 70 138, 58 135, 50 130 Z',
                fill: 'green',
                color: 'green',
              },
            ],
          },
        ],
      }),
      ...(drawn?.board ? [act('screen.read', 'show', { record: drawn.board.id })] : []),
      { say: drawn?.board ? 'Here is a rose.' : 'I could not draw it.' },
    ];
  }
  if (/\bboard\b/i.test(asked) && /\b(look|see)\b/i.test(asked)) {
    const board = (read('board.read') as { boards?: { id: string }[] } | undefined)?.boards?.[0];
    const seen = (read('screen.read') as { seen?: string } | undefined)?.seen;
    return [
      { call: 'board.read', input: {} },
      act('screen.read', 'look', { question: asked, at: { record: board?.id ?? 'none' } }),
      { say: seen ?? 'I could not see the board.' },
    ];
  }
  if (/\bboard\b/i.test(asked)) {
    const drawn = read('board.write') as { board?: { id: string; title: string } } | undefined;
    return [
      act('board.write', 'draw', {
        title: 'Calibration ideas',
        ops: [
          { op: 'text', key: 'h', text: 'Keep the LEDGAR gain, lose no calibration', size: 'l' },
          { op: 'note', key: 'a', text: 'Temperature per head, fit on dev only', near: 'h' },
          {
            op: 'note',
            key: 'b',
            text: 'KL to the base on general replay',
            color: 'blue',
            near: 'a',
          },
          {
            op: 'note',
            key: 'c',
            text: 'LoRA instead of last-block updates',
            color: 'green',
            near: 'b',
          },
          { op: 'frame', key: 'f', title: 'Methods to try', holds: ['a', 'b', 'c'] },
          {
            op: 'flow',
            nodes: [
              { key: 'base', text: 'Base model' },
              { key: 'adapt', text: 'Adapt on LEDGAR' },
              { key: 'eval', text: 'Fresh holdouts', shape: 'diamond' },
            ],
            edges: [
              { from: 'base', to: 'adapt' },
              { from: 'adapt', to: 'eval', label: 'then' },
            ],
          },
        ],
      }),
      ...(drawn?.board ? [act('screen.read', 'show', { record: drawn.board.id })] : []),
      { say: drawn?.board ? `I drew our ideas on ${drawn.board.title}.` : 'I could not draw it.' },
    ];
  }
  if (/screen|looking at/i.test(asked)) {
    const seen = (read('screen.read') as { seen?: string } | undefined)?.seen;
    return [
      act('screen.read', 'look', { question: asked }),
      { say: seen ?? 'I could not see your screen.' },
    ];
  }
  if (/\b(open|pull up)\b/i.test(asked)) {
    const page = /\b(work|files|paper|code)\b page/i.exec(asked)?.[1];
    const first = page ? undefined : newest(read('artifact.list'));
    const shown = read('screen.read') as { title?: string; said?: string } | undefined;
    return [
      ...(page ? [] : [{ call: 'artifact.list', input: {} }]),
      act('screen.read', 'show', page ? { page } : { record: first ?? 'none' }),
      { say: shown?.title ? `Here is ${shown.title}.` : (shown?.said ?? 'I could not open it.') },
    ];
  }
  if (/claim/i.test(asked))
    return [
      { call: 'review.start', input: { reviewId: 'review_that_is_gone' } },
      { say: 'Claiming that review was refused, so nothing changed.' },
    ];
  if (/\b(start|resume)\b/i.test(asked)) return dispatch(true);
  if (/status|running/i.test(asked))
    return [
      { call: 'system.status', input: {} },
      { call: 'workflow.status_and_next', input: {} },
      { say: 'Dispatch is on, three machines are online and nothing is stuck.' },
    ];
  if (/new task/i.test(asked))
    return [
      {
        call: 'task.create',
        input: {
          title: 'Plot the grokking step against weight decay',
          goal: 'One figure that shows where generalization begins for each decay setting.',
          checks: ['The figure covers all four settings', 'The data behind it is attached'],
          requestId: `demo-agent-${randomUUID()}`,
        },
      },
      { say: 'I created the task. A Fleet worker will pick it up once dispatch offers it.' },
    ];
  if (/tasks?/i.test(asked)) {
    const first = newest(read('task.list'));
    return [
      { call: 'task.list', input: {} },
      { say: first ? `The newest task is ${first}.` : 'There are no tasks yet.' },
    ];
  }
  if (/file/i.test(asked)) {
    const first = newest(read('artifact.list'));
    return [
      { call: 'artifact.list', input: {} },
      ...(first ? [{ call: 'artifact.read', input: { artifactId: first, mode: 'download' } }] : []),
      { say: first ? 'I fetched a download link for the newest file.' : 'There are no files yet.' },
    ];
  }
  return [{ call: 'project.get', input: {} }, { say: LONG }];
}

type Item = { role?: string; type?: string; name?: string; call_id?: string; output?: string };
/** The model's next move for one request: the turn's plan, as far along as its tool results. */
function next(
  body: { input: (Item & { content?: { text?: string }[] | string })[] },
  planned: Plan,
): Step {
  const from = body.input.findLastIndex((item) => item.role === 'user');
  const content = body.input[from]?.content;
  const whole = Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
  const asked = whole.split('\nUser message:\n').at(-1)!;
  const after = body.input.slice(from + 1);
  const read = (tool: string) => {
    const call = after.find((item) => item.name === tool.replaceAll('.', '_'));
    const output = after.find(
      (item) => item.type === 'function_call_output' && item.call_id === call?.call_id,
    );
    try {
      return JSON.parse(output?.output ?? 'null');
    } catch {
      return null;
    }
  };
  const steps = planned(asked.trim(), read, whole);
  const done = after.filter((item) => item.type === 'function_call_output').length;
  return steps[Math.min(done, steps.length - 1)]!;
}

/** One reply in the Responses stream's own events, its words a few at a time. */
function stream(step: Step): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = randomUUID().replaceAll('-', '');
  const item =
    'call' in step
      ? {
          id: `fc_${id}`,
          type: 'function_call',
          call_id: `call_${id}`,
          name: step.call.replaceAll('.', '_'),
          arguments: JSON.stringify(step.input),
        }
      : {
          id: `msg_${id}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: step.say, annotations: [] }],
        };
  const words = 'say' in step ? (step.say.match(/\S+\s*/g) ?? []) : [];
  return new ReadableStream({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      send({ type: 'response.created', response: { id: `resp_${id}` } });
      await new Promise((resolve) => setTimeout(resolve, 600));
      send({ type: 'response.output_item.added', output_index: 0, item });
      for (const delta of words) {
        send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta });
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({
        type: 'response.completed',
        response: {
          id: `resp_${id}`,
          status: 'completed',
          incomplete_details: null,
          output: [item],
          usage: { input_tokens: 12, output_tokens: 8 },
        },
      });
      controller.close();
    },
  });
}
/** A worker's fetch whose model calls `planned` answers; everything else goes where it was going. */
export const scriptedBy =
  (planned: Plan): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.endsWith('/pi-model/responses')) return fetch(request);
    return new Response(stream(next(await request.json(), planned)), {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
const scripted = scriptedBy(plan);

/** The tests' machines, which are ready at once, with a launch that starts the worker in this
 * process on the bootstrap Fleet delivered, a moment later as a machine loads its agent. */
class Machines extends FakeRuntimes {
  private readonly workers = new Map<string, AbortController>();
  override async launch(
    projectId: string,
    current: FleetRuntimeHandle,
    key: string,
    bootstrap?: string,
  ) {
    if (!this.workers.has(current.sandboxId)) {
      const worker = new AbortController();
      this.workers.set(current.sandboxId, worker);
      setTimeout(
        () =>
          void runPiWorker(JSON.parse(bootstrap!), {
            signal: worker.signal,
            fetchImpl: scripted,
          }).catch(() => {}),
        2000,
      );
    }
    return super.launch(projectId, current, key);
  }
  override async stop(projectId: string, current: FleetRuntimeHandle) {
    this.workers.get(current.sandboxId)?.abort();
    await super.stop(projectId, current);
    this.release(current.sandboxId);
    return this.inspect(projectId, current);
  }
}

/** Composes Fleet on the machines above and the Agent's plugins on it, as production composes them. */
export async function seedAgent(app: Awaited<ReturnType<typeof createApp>>, url: string) {
  const host = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Agent host',
    actorName: 'Agent host',
  });
  process.env.MERV_PI_SECRET ??= randomBytes(32).toString('base64url');
  process.env.MERV_PI_MODEL_API_KEY ??= 'scripted';
  process.env.MERV_DEMO_AGENT_HOST_KEY = host.token;
  app.ctx.plugin({
    name: 'demo-fleet',
    inject: ['state', 'scope'],
    async apply(ctx: Context) {
      const fleet = new FleetService(ctx.state, ctx.scope, new Machines(), {
        profiles,
        pollIntervalMs: 1000,
        hostProjectId: host.project.id,
      });
      await fleet.initialize();
      ctx.effect(() => () => fleet.close());
      ctx.provide('fleet', fleet);
      fleet.start();
    },
  });
  const pi = app.ctx.plugin(piPlugin, {
    baseUrl: url,
    idleTimeoutSeconds: Number(process.env.MERV_DEMO_AGENT_IDLE ?? 600),
    host: { projectId: host.project.id, credentialEnv: 'MERV_DEMO_AGENT_HOST_KEY' },
    machines: [
      { key: 'standard', label: 'Standard', slots: 3 },
      { key: 'large', label: 'Large', slots: 4, agent: true },
    ],
    agentMoves: true,
  });
  // Fleet's own tools and sidebar too, so the agent's machine stands on Work as it does in production.
  for (const plugin of [fleetToolsPlugin, fleetUiPlugin, piToolsPlugin, piApiPlugin, piUiPlugin])
    app.ctx.plugin(plugin);
  await pi.await();
}
