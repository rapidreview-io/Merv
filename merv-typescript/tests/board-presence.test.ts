import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BoardLooking, BoardScene } from '@merv/board';
import type { Caller } from '@merv/contracts';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { httpApp } from './fixtures/app.js';

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-presence-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const made = await f.app.ctx.board.create(owner, 'Sketch');
  return { ...f, boot, owner, made };
}

test('a page sees where an agent looked or drew, and is never counted as one', async (t) => {
  const f = await fixture(t);
  const { tools } = f.app.ctx;
  tools.registerCallerRules('conversation', conversationRules);
  const scene = async () =>
    (await tools.call('board.scene', f.owner, { id: f.made.id })) as BoardScene;
  const ops = [{ op: 'box', text: 'Here', at: [100, 200], width: 200, height: 80 }];

  // The person's own card, drawn through the same tool from the page, shows no cursor.
  await tools.call('board.write:draw', f.owner, { board: f.made.id, ops });
  assert.equal((await scene()).looking, undefined);
  const before = (await scene()).board.revision;

  // An outside agent over MCP is named by its client, and its answer does not carry the region.
  const client = new Client({ name: 'claude-code', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${f.boot.token}` } },
    }),
  );
  const called = await client.callTool({
    name: 'board.write',
    arguments: { action: 'draw', draw: { board: f.made.id, ops: [{ ...ops[0], at: [500, 40] }] } },
  });
  assert.doesNotMatch(JSON.stringify(called.content), /region/);
  const [drew] = (await scene()).looking as BoardLooking[];
  assert.equal(drew!.name, 'Claude Code');
  assert.equal(drew!.drew, true);
  assert.deepEqual(
    { x: drew!.region.x, y: drew!.region.y, width: drew!.region.width },
    { x: 500, y: 40, width: 200 },
  );

  // Pi is Pi, on the same person's actor.
  const source = await f.app.ctx.scope.delegationSource(f.owner);
  f.app.ctx.scope.registerConversationAuthority({ require: async () => source });
  const pi: Caller = {
    actorId: f.owner.actorId,
    projectId: f.owner.projectId,
    conversation: { id: 'pi', epoch: 1, commandId: 'turn', runtimeId: 'runtime' },
  };
  await tools.call('board.write:draw', pi, {
    board: f.made.id,
    ops: [{ ...ops[0], at: [0, 900] }],
  });
  const looking = (await scene()).looking as BoardLooking[];
  assert.deepEqual(looking.map(({ name }) => name).sort(), ['Claude Code', 'Pi']);
  // Being seen changes nothing kept: only the two draws moved the board.
  assert.equal((await scene()).board.revision, before + 2);

  // After 20 seconds nobody is there.
  const real = Date.now;
  t.after(() => void (Date.now = real));
  Date.now = () => real() + 21_000;
  assert.equal((await scene()).looking, undefined);
});
