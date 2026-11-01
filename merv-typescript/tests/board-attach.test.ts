import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BoardScene } from '@merv/board';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

const client = new URL('../../clients/board/board.mjs', import.meta.url).pathname;

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-attach-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const { tools } = f.app.ctx;
  const url = f.app.ctx.api.url!;
  const board = (await f.app.ctx.board.create(owner, 'Sketch')).id;
  const other = (await f.app.ctx.board.create(owner, 'Other')).id;
  const coded = async () =>
    ((await tools.call('board.attach', owner, { id: board })) as { code: string }).code;
  const data = mkdtempSync(join(tmpdir(), 'board-plugin-'));
  const env = { ...process.env, BOARD_URL: url, CLAUDE_PLUGIN_DATA: data };
  const run = (args: string[], stdin = '') =>
    // Not spawnSync's own wait: the server these talk to lives in this process.
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [client, ...args], { env });
      let out = '';
      child.stdout.on('data', (part) => (out += part));
      child.on('close', () => resolve(out));
      child.stdin.end(stdin);
    });
  const hook = (input: object) => run(['hook'], JSON.stringify({ session_id: 's1', ...input }));
  const attached = async (steps = 0) =>
    (
      (await tools.call('board.scene', owner, {
        id: board,
        since: Number.MAX_SAFE_INTEGER,
        steps,
      })) as BoardScene
    ).attached;
  return { owner, tools, url, board, other, coded, data, env, run, hook, attached };
}

test('a session pairs by code once, and only that session is attached', async (t) => {
  const f = await fixture(t);
  const said = await f.run(['pair', await f.coded(), 's1', f.data]);
  assert.match(said, /Attached to board "Sketch"/);
  const file = join(f.data, 'attached', 's1.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).board, f.board);
  assert.match(await f.run(['pair', 'AAAAAA', 's2', f.data]), /Not attached/);
  // An unattached session's hook says nothing and sends nothing.
  assert.equal(await f.run(['hook'], JSON.stringify({ session_id: 's2', prompt: 'x' })), '');
  assert.equal((await f.attached())?.sessions.length, 1);
  assert.equal((await f.attached())?.steps.length, 0);
});

test('events reach the page redacted and cut short, tool output never', async (t) => {
  const f = await fixture(t);
  await f.run(['pair', await f.coded(), 's1', f.data]);
  await f.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(500) });
  const key = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const call = {
    tool_name: 'Bash',
    tool_use_id: 't1',
    tool_input: { command: `curl -H ${key} x`, secret_body: 'body-of-file' },
  };
  await f.hook({ hook_event_name: 'PreToolUse', ...call });
  await f.hook({
    hook_event_name: 'PostToolUseFailure',
    ...call,
    tool_response: 'private output',
  });
  const told = await f.attached();
  const all = JSON.stringify(told);
  assert.equal(told!.steps[0]!.text.length, 200);
  assert.ok(!all.includes(key));
  assert.ok(!all.includes('private output'));
  assert.ok(!all.includes('body-of-file'));
  const step = told!.steps[1]!;
  assert.equal(step.tool, 'Bash');
  assert.equal(step.failed, true);
  assert.ok(step.until);
  assert.equal(told!.steps.length, 2, "a call's end lands on its start");
  // Only what is new, by the number the last answer gave.
  assert.equal((await f.attached(told!.seq))!.steps.length, 0);
  await f.hook({ hook_event_name: 'SessionEnd' });
  assert.equal((await f.attached(told!.seq))!.sessions.length, 0);
});

test('a person crossing out a step reaches the session once, with its words', async (t) => {
  const f = await fixture(t);
  const body = (name: string, input: object) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, input }),
  });
  await f.run(['pair', await f.coded(), 's1', f.data]);
  const { token } = JSON.parse(readFileSync(join(f.data, 'attached', 's1.json'), 'utf8'));
  const drawn = await fetch(
    `${f.url}/board-attach/call`,
    body('board.write', {
      action: 'draw',
      draw: { ops: [{ op: 'box', key: 'three', text: 'three.txt' }] },
    }),
  ).then((r) => r.json() as Promise<{ content: { text: string }[] }>);
  const { created, placed, board } = JSON.parse(drawn.content[0]!.text);
  assert.equal(board.id, f.board, 'a draw lands on the attached board, whatever it names');
  const scene = (await f.tools.call('board.scene', f.owner, { id: f.board })) as BoardScene;
  const box = scene.elements.find((el) => el.id === created.three)!;
  const [x, y, width, height] = placed.three ?? [box.x, box.y, box.width, box.height];
  assert.equal(
    await f.hook({ hook_event_name: 'PostToolUse', tool_name: 'x', tool_use_id: 'a' }),
    '',
  );
  await f.tools.call('board.save', f.owner, {
    id: f.board,
    elements: [
      {
        ...box,
        id: 'stroke1',
        type: 'freedraw',
        x: x! - 10,
        y: y! - 10,
        width: width! + 20,
        height: height! + 20,
        points: [
          [0, 0],
          [width! + 20, height! + 20],
        ],
        boundElements: null,
        version: 1,
        versionNonce: 1,
        customData: {},
      },
    ],
  });
  const note = await f.hook({ hook_event_name: 'PostToolUse', tool_name: 'x', tool_use_id: 'b' });
  const context = JSON.parse(note).hookSpecificOutput;
  assert.equal(context.hookEventName, 'PostToolUse');
  assert.match(context.additionalContext, /across .*"three\.txt" \(crossed out\?\)/);
  assert.equal(
    await f.hook({ hook_event_name: 'PostToolUse', tool_name: 'x', tool_use_id: 'c' }),
    '',
    'told once',
  );
});

test('a token reaches its own board and nothing else', async (t) => {
  const f = await fixture(t);
  await f.run(['pair', await f.coded(), 's1', f.data]);
  const { token } = JSON.parse(readFileSync(join(f.data, 'attached', 's1.json'), 'utf8'));
  const send = (name: string, input: object) =>
    fetch(`${f.url}/board-attach/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, input }),
    }).then(async (r) => ({ status: r.status, body: await r.text() }));
  assert.equal((await send('artifact.read', { action: 'list' })).status, 400);
  assert.match((await send('board.read', { action: 'list', list: {} })).body, /Not while attached/);
  const read = await send('board.read', { action: 'get', get: { board: f.other } });
  assert.match(read.body, /Sketch/);
  assert.ok(!read.body.includes('Other'), 'pinned to the attached board');
  const scene = (await f.tools.call('board.scene', f.owner, { id: f.board })) as BoardScene;
  assert.equal(scene.attached, undefined, 'a page that did not ask is not told');
  await f.tools.call('board.detach', f.owner, { session: (await f.attached())!.sessions[0]!.id });
  assert.equal((await send('board.read', { action: 'get', get: {} })).status, 401);
});

test('an unreachable board costs a hook under a second, then nothing', () => {
  const data = mkdtempSync(join(tmpdir(), 'board-plugin-'));
  const env = { ...process.env, BOARD_URL: 'http://127.0.0.1:9', CLAUDE_PLUGIN_DATA: data };
  // Nothing listens: it fails at once, and the file says to leave the board alone a while.
  spawnSync('mkdir', ['-p', join(data, 'attached')]);
  spawnSync('sh', [
    '-c',
    `echo '{"url":"http://10.255.255.1:9","token":"t","board":"b"}' > ${join(data, 'attached', 's.json')}`,
  ]);
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'Stop' });
  const started = Date.now();
  const first = spawnSync(process.execPath, [client, 'hook'], { env, input, encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(first.stdout, '');
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  const again = Date.now();
  spawnSync(process.execPath, [client, 'hook'], { env, input });
  assert.ok(Date.now() - again < 300, `${Date.now() - again} ms`);
});
