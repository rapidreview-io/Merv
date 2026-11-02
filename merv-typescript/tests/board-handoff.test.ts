import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAudience } from '@merv/api/audience';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { stateConfig } from './fixtures/state.js';

const composition = JSON.parse(
  readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'),
) as ApplicationConfig;

async function boot(flag: string | undefined) {
  if (flag === undefined) delete process.env.MERV_BOARD_HANDOFF;
  else process.env.MERV_BOARD_HANDOFF = flag;
  process.env.MERV_PI_MODEL_API_KEY = 'unused';
  const directory = mkdtempSync(join(tmpdir(), 'merv-board-handoff-'));
  const plugins = composition.plugins.map((entry) =>
    entry.id === 'state' ? { ...entry, config: stateConfig(directory) } : entry,
  );
  const app = await createApp({ directory, config: { plugins }, port: 0 });
  const person = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Mine',
    actorName: 'Me',
  });
  const caller = { actorId: person.actor.id, projectId: person.project.id };
  return { app, ctx: app.ctx, caller };
}

test('hand-off is invisible with the flag unset', async (t) => {
  const { app, ctx, caller } = await boot(undefined);
  t.after(() => app.stop());
  assert.ok(!ctx.ui.rows().some((row) => row.id === 'handoff'));
  const names = (await ctx.tools.describe(caller, false)).map(({ name }) => name);
  assert.ok(!names.some((name) => name.startsWith('handoff.')));
});

test('a person hands off; only their machine takes it; agents cannot', async (t) => {
  const { app, ctx, caller } = await boot('all');
  t.after(() => app.stop());
  assert.ok(ctx.ui.rows().some((row) => row.id === 'handoff'));
  const call = <T>(name: string, input: object, who = caller) =>
    ctx.tools.call(name, who as never, input) as Promise<T>;
  const drawn = await call<{ board: { id: string }; created: Record<string, string> }>(
    'board.write:draw',
    { title: 'Ideas', ops: [{ op: 'text', key: 'idea', text: 'Add a HELLO.md', at: [100, 100] }] },
  );
  const board = drawn.board.id;
  const idea = drawn.created.idea!;
  const start = {
    board,
    elements: [idea],
    harness: 'claude',
    repo: 'repo',
    brief: 'Add HELLO.md',
    words: 'Add a HELLO.md',
  };

  // No machine yet: a hand-off is refused, and so is an agent's.
  await assert.rejects(call('handoff.start', start), /not connected/);
  const started = new Date().toISOString();
  const poll = (fresh = started) =>
    call<{ runs: (Record<string, unknown> & { id: string; commands: { kind: string }[] })[] }>(
      'handoff.poll',
      { name: 'Mac', repos: ['repo'], claude: true, codex: false, started: fresh },
    );
  assert.deepEqual(await poll(), { runs: [] });
  await assert.rejects(
    agentAudience.run(true, () => call('handoff.start', start)),
    /Only a person/,
  );
  await assert.rejects(call('handoff.start', { ...start, repo: 'other' }), /offers/);
  await assert.rejects(call('handoff.start', { ...start, harness: 'codex' }), /not signed in/);

  const { run } = await call<{ run: { id: string; tag: string; state: string } }>(
    'handoff.start',
    start,
  );
  assert.equal(run.state, 'queued');
  const scene = await call<{
    elements: { id: string; containerId?: string; originalText?: string }[];
  }>('board.scene', { id: board });
  const tag = scene.elements.find((el) => el.containerId === run.tag);
  assert.equal(tag?.originalText, 'Claude Code · starting');

  // Another person's machine never sees it; the owner's does, once.
  const other = await ctx.scope.credentials.bootstrap({ projectName: 'Theirs', actorName: 'Them' });
  const theirs = await call<{ runs: unknown[] }>(
    'handoff.poll',
    { name: 'Other', repos: ['repo'], claude: true, codex: false, started },
    { actorId: other.actor.id, projectId: other.project.id },
  );
  assert.deepEqual(theirs.runs, []);
  const mine = await poll();
  assert.equal(mine.runs[0]?.id, run.id);

  // The machine reports; the person steers, answers and stops; the tag follows.
  await call('handoff.report', {
    run: run.id,
    state: 'running',
    session: 's1',
    events: [
      {
        id: 'm1',
        kind: 'agent',
        text: 'On it. token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      },
    ],
  });
  assert.equal((await poll()).runs.length, 0);
  await call('handoff.say', { run: run.id, text: 'Keep it short' });
  await call('handoff.report', {
    run: run.id,
    state: 'asking',
    ask: {
      id: 'a1',
      title: 'Write HELLO.md',
      options: [
        { id: 'yes', name: 'Yes', kind: 'allow_once' },
        { id: 'no', name: 'No', kind: 'reject_once' },
      ],
    },
  });
  await assert.rejects(
    call('handoff.answer', { run: run.id, ask: 'a1', option: 'maybe' }),
    /options/,
  );
  await call('handoff.answer', { run: run.id, ask: 'a1', option: 'yes' });
  await call('handoff.stop', { run: run.id });
  const next = await poll();
  assert.deepEqual(
    next.runs[0]?.commands.map(({ kind }) => kind),
    ['steer', 'answer', 'stop'],
  );
  const session = await call<{
    run: { state: string; ask?: unknown };
    events: { kind: string; text: string; status?: string }[];
  }>('handoff.session', { run: run.id });
  assert.equal(session.run.state, 'running');
  assert.equal(session.run.ask, undefined);
  assert.deepEqual(
    session.events.map(({ kind, status }) => [kind, status ?? '']),
    [
      ['you', ''],
      ['agent', ''],
      ['you', ''],
      ['ask', 'allowed'],
    ],
  );
  assert.doesNotMatch(session.events[1]!.text, /sk-ant/);
  assert.match(session.events[1]!.text, /redacted/);

  // The machine restarted mid-run: the session is lost until spoken to again, then loads.
  await call('handoff.report', { run: run.id, state: 'running' });
  await poll(new Date(Date.now() + 1).toISOString());
  const lost = await call<{ run: { state: string; error?: string } }>('handoff.session', {
    run: run.id,
  });
  assert.equal(lost.run.state, 'failed');
  assert.match(lost.run.error ?? '', /restarted/);
  await call('handoff.say', { run: run.id, text: 'Carry on' });
  const again = await poll(new Date(Date.now() + 1).toISOString());
  assert.equal(again.runs[0]?.id, run.id);
  assert.equal(again.runs[0]?.session, 's1');
  assert.equal(again.runs[0]?.commands[0]?.kind, 'say');
});
