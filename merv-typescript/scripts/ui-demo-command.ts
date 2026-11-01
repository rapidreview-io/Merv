import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import boardAgentsPlugin from '@merv/board/agents';
import type { createApp } from '../src/app.js';
import { scriptPlans, type Step } from './ui-demo-agent.js';

/**
 * The board as command centre, for the browser demo (`npm run demo:command-center`): the experiment's
 * plugin, one seeded sketch, and Pi's distilling. Pi's turn, its tools and the board are real. Its
 * routing is the demo's script, as everywhere in the demo; what it distils a board into comes from a
 * real model: the person's own `claude`, reading the board's picture and words beside their workspace.
 */
const schema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          goal: { type: 'string' },
          checks: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'checks'],
      },
    },
  },
  required: ['tasks'],
};
const PROMPT = `A person drew and wrote on a whiteboard. Distil it into at most three small, independent tasks a coding agent could do in this directory, which you may look through to see what is here.
Each task has a short title, a one-sentence goal, and two to four measurable checks. A check is measurable when someone other than the agent can decide it from the result. Prefer a command in backticks whose exit code decides it: one complete line, runnable as written from the top of this directory with only node and with no network, such as \`node --test\` or \`node spark.mjs loss.csv | grep -q .\`. Never a fragment of a command, and at most one command in a check. Allow one check per task that needs a reader's judgement, stated so they can decide it from the files. Never a check that restates the title. Each task is done in its own copy of this directory, so no task may need another's files. Write each check in under twelve words plus its command.
The board says:
`;

const run = promisify(execFile);
/** The person's own login, as their shell's alias makes it theirs (clients/board-connect does the same). */
async function claudeEnv() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env;
  const said = await run(process.env.SHELL ?? 'sh', ['-ic', 'alias claude']).catch(() => ({
    stdout: '',
  }));
  const dir = /CLAUDE_CONFIG_DIR=(\S+)/.exec(said.stdout)?.[1]?.replace(/^~/, homedir());
  return dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env;
}

type Task = { title: string; goal?: string; checks: string[] };
const SAYS = ['First the piece everything leans on.', 'Then the next thing it lets you see.', 'And one more.'];

export async function seedCommand(
  app: Awaited<ReturnType<typeof createApp>>,
  url: string,
  token: string,
) {
  const plugin = app.ctx.plugin(boardAgentsPlugin);
  await plugin.await();
  const tool = async <T>(name: string, input: object) => {
    const response = await fetch(`${url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as { result: T };
    if (!response.ok) throw new Error(`${name}: ${JSON.stringify(body)}`);
    return body.result;
  };
  // What a person might have drawn: the falling curve, where it flattens, and what they want from it.
  const seeded = await tool<{ board: { id: string } }>('board.write:draw', {
    title: 'Is it still learning?',
    ops: [
      { op: 'text', key: 'q', text: 'Is it still learning?', size: 'l', at: [0, -120] },
      {
        op: 'sketch',
        key: 'curve',
        size: 'native',
        at: [0, 0],
        strokes: [
          { path: 'M0 0 L0 220 L380 220', width: 'medium', color: 'black' },
          { path: 'M6 20 C 50 150, 110 190, 180 198 S 320 205, 372 204', width: 'bold', color: 'blue' },
          { path: 'M196 176 C 180 196, 180 216, 200 226 C 240 240, 368 232, 378 208 C 384 188, 330 178, 196 176 Z', width: 'thin', color: 'red' },
        ],
      },
      { op: 'text', text: 'it stopped here. tell me the step!', size: 's', color: 'red', at: [210, 140] },
      { op: 'note', key: 'a', text: 'loss.csv in, one line of sparkline out, right in the terminal', at: [560, -40] },
      { op: 'note', key: 'b', text: 'Say the step where it plateaus, so I stop the run sooner', color: 'blue', at: [560, 110] },
    ],
  });
  console.log(JSON.stringify({ commandCenterBoard: seeded.board.id }));

  // Asked once per turn: every step of a turn comes back through here, with what it has seen.
  const distilled = new Map<string, Promise<Task[]>>();
  const distil = async (board: string) => {
    const said = await tool<{ frames: unknown[]; shapes: { text?: string; kind: string }[] }>(
      'board.read:get',
      { board },
    );
    const look = await tool<{ image?: { data: string } }>('board.read:look', { board }).catch(
      () => ({ image: undefined }),
    );
    const words = said.shapes.flatMap((shape) => (shape.text ? [`- ${shape.text}`] : [])).join('\n');
    const scratch = mkdtempSync(join(tmpdir(), 'board-distil-'));
    let picture = '';
    if (look.image) {
      picture = join(scratch, 'board.png');
      writeFileSync(picture, Buffer.from(look.image.data, 'base64'));
    }
    const { stdout } = await run(
      'claude',
      [
        '-p',
        `${PROMPT}${words}${picture ? `\n\nThe picture of it is at ${picture}: read that file before you decide, since a drawing can say what the words do not.` : ''}`,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--model',
        'sonnet',
        '--allowedTools',
        'Read',
        'Glob',
        'Grep',
        '--permission-mode',
        'dontAsk',
        '--add-dir',
        scratch,
      ],
      {
        cwd: process.env.BOARD_WORKSPACE ?? scratch,
        env: await claudeEnv(),
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    ).finally(() => rmSync(scratch, { recursive: true, force: true }));
    const answer = JSON.parse(stdout) as { structured_output?: { tasks: Task[] }; result?: string };
    return (answer.structured_output ?? (JSON.parse(answer.result!) as { tasks: Task[] })).tasks;
  };
  scriptPlans(async (asked, note) => {
    if (!/\b(distil+|make tasks)\b/i.test(asked)) return undefined;
    const board = /\[board ([\w-]+)/.exec(note)?.[1] ?? seeded.board.id;
    const key = `${board}:${asked}:${note.length}`;
    if (!distilled.has(key)) distilled.set(key, distil(board));
    const tasks = await distilled.get(key)!.catch((error: Error) => {
      console.error('distil', error.message);
      return [] as Task[];
    });
    if (!tasks.length)
      return [{ say: 'I could not distil that: your local Claude Code did not answer.' }];
    const steps: Step[] = [
      { call: 'board.read', input: { action: 'get', get: { board } } },
      ...tasks.map((task, index) => ({
        call: 'board.task',
        input: {
          board,
          title: task.title,
          ...(task.goal && { goal: task.goal }),
          checks: task.checks,
          say: SAYS[index] ?? SAYS[2]!,
        },
      })),
      { say: 'They are yours to change now. Rewrite a check, or drag a note in.' },
    ];
    return steps;
  });
}
