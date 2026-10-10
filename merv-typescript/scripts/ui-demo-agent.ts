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
import type { SandboxRuntimeHandle } from '@merv/sandboxes/types';
import type { createApp } from '../src/app.js';
import { FakeRuntimes } from '../tests/fixtures/runtimes.js';

/**
 * The Agent for the browser demo (`npm run demo:ui -- --agent`): the real Agent service, Fleet and
 * worker, on a machine that is this process and a model that is the script below. Nothing leaves
 * this computer: Fleet rents by starting the worker here, and the worker's model calls are
 * answered by `scripted` instead of the relay. Everything the page is sent — stages, streamed
 * words, proposals, what Run tells the agent, the machine and its idle release — is what
 * production's page is sent. MERV_DEMO_AGENT_IDLE sets the idle release in seconds (600).
 *
 * The script reads the person's words: `pause` and `start` propose the dispatch switch, `claim`
 * proposes a call that will be refused, `status` and `tasks` read first, `file` proposes a read
 * whose result only the person sees, `screen` looks at the person's screen, `open` or `pull up`
 * puts the newest file (or a named page) on it, `board` draws ideas on a new board and opens it
 * (`look at the board` sees the newest one drawn), `new task` creates one,
 * and anything else reads the project
 * and answers at length.
 */
type Step = { call: string; input: object } | { say: string };
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
    say: `I’ve proposed ${enabled ? 'starting' : 'pausing'} dispatch. It ${enabled ? 'lets agents take new work again' : 'stops agents from taking new work; work already leased keeps running'}. Run it when you are ready and tell me what happened.`,
  },
];
/** The first record of a list the agent was shown, whole or as its index. */
const newest = (shown: unknown) =>
  ((Array.isArray(shown) ? shown : (shown as { index?: unknown[] })?.index)?.[0] as { id?: string })
    ?.id;
function plan(asked: string, read: (tool: string) => unknown): Step[] {
  if (/^Ran \S+[:;]|was refused: /.test(asked))
    return [
      {
        say: asked.startsWith('Ran')
          ? 'Done, that is in place.'
          : 'It was refused, so nothing changed.',
      },
    ];
  if (/pause/i.test(asked)) return dispatch(false);
  if (/\brose\b/i.test(asked)) {
    const drawn = read('board.draw') as { board?: { id: string } } | undefined;
    return [
      {
        call: 'board.draw',
        input: {
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
        },
      },
      ...(drawn?.board ? [{ call: 'screen.show', input: { record: drawn.board.id } }] : []),
      { say: drawn?.board ? 'Here is a rose.' : 'I could not draw it.' },
    ];
  }
  if (/\bboard\b/i.test(asked) && /\b(look|see)\b/i.test(asked)) {
    const board = (read('board.read') as { boards?: { id: string }[] } | undefined)?.boards?.[0];
    const seen = (read('screen.look') as { seen?: string } | undefined)?.seen;
    return [
      { call: 'board.read', input: {} },
      { call: 'screen.look', input: { question: asked, at: { record: board?.id ?? 'none' } } },
      { say: seen ?? 'I could not see the board.' },
    ];
  }
  if (/\bboard\b/i.test(asked)) {
    const drawn = read('board.draw') as { board?: { id: string; title: string } } | undefined;
    return [
      {
        call: 'board.draw',
        input: {
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
        },
      },
      ...(drawn?.board ? [{ call: 'screen.show', input: { record: drawn.board.id } }] : []),
      { say: drawn?.board ? `I drew our ideas on ${drawn.board.title}.` : 'I could not draw it.' },
    ];
  }
  if (/screen|looking at/i.test(asked)) {
    const seen = (read('screen.look') as { seen?: string } | undefined)?.seen;
    return [
      { call: 'screen.look', input: { question: asked } },
      { say: seen ?? 'I could not see your screen.' },
    ];
  }
  if (/\b(open|pull up)\b/i.test(asked)) {
    const page = /\b(work|files|paper|code)\b page/i.exec(asked)?.[1];
    const first = page ? undefined : newest(read('artifact.list'));
    const shown = read('screen.show') as { title?: string; said?: string } | undefined;
    return [
      ...(page ? [] : [{ call: 'artifact.list', input: {} }]),
      { call: 'screen.show', input: page ? { page } : { record: first ?? 'none' } },
      { say: shown?.title ? `Here is ${shown.title}.` : (shown?.said ?? 'I could not open it.') },
    ];
  }
  if (/claim/i.test(asked))
    return [
      { call: 'review.start', input: { reviewId: 'review_that_is_gone' } },
      { say: 'I’ve proposed claiming that review for you.' },
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
      { say: 'I’ve proposed downloading that file. Only you see where it is.' },
    ];
  }
  return [{ call: 'project.get', input: {} }, { say: LONG }];
}

type Item = { role?: string; type?: string; name?: string; call_id?: string; output?: string };
/** The model's next move for one request: the turn's plan, as far along as its tool results. */
function next(body: { input: (Item & { content?: { text?: string }[] | string })[] }): Step {
  const from = body.input.findLastIndex((item) => item.role === 'user');
  const content = body.input[from]?.content;
  const asked = (Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '')
    .split('\nUser message:\n')
    .at(-1)!;
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
  const steps = plan(asked.trim(), read);
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
const scripted: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (!request.url.endsWith('/pi-model/responses')) return fetch(request);
  return new Response(stream(next(await request.json())), {
    headers: { 'content-type': 'text/event-stream' },
  });
};

/** The tests' machines, which are ready at once, with a launch that starts the worker in this
 * process on the bootstrap Fleet delivered, a moment later as a machine loads its agent. */
class Machines extends FakeRuntimes {
  private readonly workers = new Map<string, AbortController>();
  override async launch(
    projectId: string,
    current: SandboxRuntimeHandle,
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
  override async stop(projectId: string, current: SandboxRuntimeHandle) {
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
