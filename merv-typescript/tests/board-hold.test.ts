import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { type BoardElement } from '@merv/board/models';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { boardApp } from './fixtures/board.js';

const shape = (id: string, more: object = {}): BoardElement =>
  ({
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ...more,
  }) as BoardElement;

test('a draw is held only while a person watches, and says when they step in', async (t) => {
  const f = await boardApp(t, 'board-hold-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Sketches',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const { tools, board } = f.app.ctx;
  tools.registerCallerRules('conversation', conversationRules);
  const made = await board.create(owner, 'Sketch');
  const source = await f.app.ctx.scope.delegationSource(owner);
  f.app.ctx.scope.registerConversationAuthority({ require: async () => source });
  const pi: Caller = {
    actorId: owner.actorId,
    projectId: owner.projectId,
    conversation: { id: 'pi', epoch: 1, commandId: 'turn', runtimeId: 'runtime' },
  };
  await assert.rejects(
    tools.call('board.write:draw', pi, {
      board: made.id,
      ops: [{ op: 'text', text: 'x', say: 'x'.repeat(161) }],
    }),
  );
  const circle = shape('ring', {
    type: 'freedraw',
    x: 3000,
    y: 3000,
    version: 2,
    seed: 1,
    versionNonce: 3,
    groupIds: [],
    customData: {},
    width: 5,
    height: 5,
    points: [
      [0, 0],
      [5, 5],
    ],
  });
  const draw = async (at: number, more = 0) => {
    const began = Date.now();
    const drawn = (await tools.call('board.write:draw', pi, {
      board: made.id,
      ops: [0, ...Array.from({ length: more }, (_, i) => i + 1)].map((i) => ({
        op: 'box',
        text: 'Here',
        at: [at, i * 200],
        width: 200,
        height: 80,
      })),
    })) as { steppedIn?: unknown; region?: unknown; penMs?: unknown; notRun?: string };
    assert.equal(drawn.region, undefined);
    assert.equal(drawn.penMs, undefined);
    return { ms: Date.now() - began, steppedIn: drawn.steppedIn, notRun: drawn.notRun };
  };
  // Nobody has it open: answered as soon as it is done.
  assert.ok((await draw(0)).ms < 500);
  // The page's own card is never held.
  await tools.call('board.scene', owner, { id: made.id });
  const began = Date.now();
  const card = (await tools.call('board.write:draw', owner, {
    board: made.id,
    ops: [{ op: 'box', key: 'mine', text: 'Mine', at: [0, 300], width: 200, height: 80 }],
  })) as { created: Record<string, string> };
  const mine = card.created.mine;
  assert.ok(Date.now() - began < 500);
  // That card was a person's hand: the agent's next draw does not run, and it is told so at once,
  // in words, and goes on being told until it has read the board.
  const revisionThen = (await board.scene(owner, made.id)).board.revision;
  const told = await draw(600);
  assert.equal((told.steppedIn as { how?: string }).how, 'drew');
  assert.deepEqual((told.steppedIn as { hand?: string[] }).hand, [`labelled ${mine} "Mine"`]);
  assert.ok(told.notRun && told.ms < 500);
  assert.ok((await draw(600)).notRun);
  assert.equal((await board.scene(owner, made.id)).board.revision, revisionThen);
  await tools.call('board.read:get', pi, { board: made.id });
  await tools.call('board.scene', owner, { id: made.id });
  const pen = await draw(1500, 30);
  assert.ok(pen.ms >= 400, `held ${pen.ms} ms`);
  assert.equal(pen.steppedIn, undefined);
  // Open, and their hand comes down meanwhile: at once, and nothing more is stored.
  await tools.call('board.scene', owner, { id: made.id });
  const before = (await board.scene(owner, made.id)).board.revision;
  const during = draw(1800, 30);
  while ((await board.scene(owner, made.id)).board.revision === before);
  await tools.call('board.hand', owner, { id: made.id });
  // The hold ends as their hand comes down, and its answer waits only for what the hand did.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await tools.call('board.save', owner, { id: made.id, elements: [circle] });
  const heard = await during;
  assert.equal((heard.steppedIn as { how?: string }).how, 'drew');
  assert.match(
    (heard.steppedIn as { hand: string[] }).hand[0]!,
    /^a stroke near .*\(a sketch\?\)$/,
  );
  assert.ok(heard.ms < 600, `told after ${heard.ms} ms`);
  assert.equal(heard.notRun, undefined);
  assert.equal((await board.scene(owner, made.id)).board.revision, before + 2);
  // A mark it has read refuses nothing: a next turn's first draw runs.
  await tools.call('board.read:get', pi, { board: made.id });
  await tools.call('board.save', owner, { id: made.id, elements: [{ ...circle, version: 3 }] });
  await tools.call('board.read:get', pi, { board: made.id });
  assert.equal((await draw(2100)).notRun, undefined);
});
