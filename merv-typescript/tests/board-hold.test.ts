import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSaying, personInterrupts } from '@merv/api/audience';
import type { Caller } from '@merv/contracts';
import { BoardWatch } from '../packages/board/src/hold.js';
import { PEN, penMs, penUnits, type BoardElement } from '@merv/board/models';
import { conversationRules } from '../packages/pi/src/conversation-rules.js';
import { httpApp } from './fixtures/app.js';

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

test('a shape takes the same time wherever it is reckoned, by the kind it is and how long', () => {
  const none = () => false;
  const box = penUnits([shape('a')], none);
  // 600 units of outline, then what settles it.
  assert.equal(
    Math.round(box[0]!.steps[0]!.ms),
    Math.round(PEN.stroke * 600 ** PEN.reach + PEN.settle),
  );
  // A longer stroke goes faster for its length.
  const long = penMs(penUnits([shape('a', { width: 1000, height: 500 })], none));
  assert.ok(long < 2.5 * penMs(box) && long <= PEN.most + PEN.settle);
  // A label is written with its box as one unit.
  const label = shape('t', { type: 'text', containerId: 'a', text: 'Twelve chars' });
  const [unit, ...rest] = penUnits([shape('a'), label], none);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    unit!.steps.map(({ shape }) => shape.id),
    ['a', 't'],
  );
  // A card is one quick thing; a stroke of a sketch hardly lifts.
  const card = (id: string, data: object) =>
    shape(id, { groupIds: ['g'], customData: data, roundness: null });
  assert.equal(penUnits([card('c', { target: 'x' }), card('p', { card: true })], none).length, 1);
  const sketch = (id: string) =>
    shape(id, {
      type: 'line',
      points: [
        [0, 0],
        [100, 0],
      ],
      customData: { sketch: 'g' },
    });
  const [, second] = penUnits([sketch('s1'), sketch('s2')], none);
  assert.equal(second!.steps[0]!.rest, PEN.lift);
  // A shape beside the last goes on from it; one apart from it is the next thing, after a beat.
  const [, beside] = penUnits([shape('a'), shape('b', { x: 240 })], none);
  const [, apart] = penUnits([shape('a'), shape('b', { x: 800 })], none);
  assert.ok(beside!.steps[0]!.rest < PEN.pause);
  assert.ok(apart!.steps[0]!.rest >= PEN.pause);
  // What stands is changed, not drawn; so is nothing kept to draw again.
  assert.equal(penMs(penUnits([shape('a')], () => true)), PEN.edit);
});

test('a hold ends with its time, at the cap, when the page stops asking and when Main closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const watch = new BoardWatch();
  const settled = (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => (done = true));
    return async (ms: number) => {
      t.mock.timers.tick(ms);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return done;
    };
  };
  // Nobody asked: at once, however long the pen.
  assert.equal(await watch.hold('quiet', 'agent', 60_000, true), undefined);

  watch.asked('b');
  let passed = settled(watch.hold('b', 'agent', 1_000, true));
  assert.equal(await passed(1_000), false);
  assert.equal(await passed(400), true);

  // A leased worker is never held, though the pen's work counts for whoever comes next.
  watch.asked('w');
  assert.equal(await watch.hold('w', 'worker', 5_000, false), undefined);
  passed = settled(watch.hold('w', 'agent', 1_000, true));
  assert.equal(await passed(3_000), false);

  // However long the drawing, forty seconds at the most, while the page keeps asking.
  watch.asked('cap');
  passed = settled(watch.hold('cap', 'agent', 120_000, true));
  for (let at = 0; at < 39; at++) {
    assert.equal(await passed(1_000), false);
    watch.asked('cap');
  }
  assert.equal(await passed(1_000), true);

  // The page goes: the answer comes within moments.
  watch.asked('gone');
  passed = settled(watch.hold('gone', 'agent', 120_000, true));
  assert.equal(await passed(3_000), false);
  assert.equal(await passed(1_500), true);

  watch.asked('closing');
  passed = settled(watch.hold('closing', 'agent', 120_000, true));
  assert.equal(await passed(100), false);
  watch.close();
  assert.equal(await passed(0), true);
  t.mock.timers.reset();
});

test('a person stepping in ends a hold and says how, once to each agent', async () => {
  const watch = new BoardWatch();
  watch.asked('b');
  const held = watch.hold('b', 'one', 60_000, true);
  watch.hand('b');
  assert.deepEqual(await held, { how: 'drew' });
  // Calls it already sent do not land, until it has read what was told.
  assert.deepEqual(watch.ahead('b', 'one'), { how: 'drew' });
  watch.hand('b');
  assert.deepEqual(watch.ahead('b', 'one'), { how: 'drew' });
  watch.read('b', 'one');
  assert.equal(watch.ahead('b', 'one'), undefined);
  // An agent new to the board is told only what comes after it arrives.
  assert.equal(await watch.hold('b', 'two', 0, true), undefined);
  // A message or a stop, heard through the call's own signal.
  watch.asked('b');
  const said = new AbortController();
  const speaking = personInterrupts.run(said.signal, () => watch.hold('b', 'one', 60_000, true));
  said.abort('said');
  assert.deepEqual(await speaking, { how: 'said' });
});

test('a draw is held only while a person watches, and says when they step in', async (t) => {
  const f = await httpApp(t, 'board-hold-');
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
  const draw = async (at: number) => {
    const began = Date.now();
    const drawn = (await tools.call('board.write:draw', pi, {
      board: made.id,
      ops: [{ op: 'box', text: 'Here', at: [at, 0], width: 200, height: 80 }],
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
  // Open and quiet: as long as the pen, and what it says goes out before the pen is waited for.
  await tools.call('board.scene', owner, { id: made.id });
  let saidAfter = -1;
  const speaking = Date.now();
  const spoken = (await agentSaying.run(
    () => (saidAfter = Date.now() - speaking),
    () =>
      tools.call('board.write:draw', pi, {
        board: made.id,
        ops: [{ op: 'box', text: 'Said', at: [900, 0], width: 200, height: 80 }],
        saying: 'The river first.',
      }),
  )) as { steppedIn?: unknown };
  assert.ok(saidAfter >= 0 && saidAfter < Date.now() - speaking - 300, `said at ${saidAfter}`);
  assert.equal(spoken.steppedIn, undefined);
  await assert.rejects(
    tools.call('board.write:draw', pi, { board: made.id, ops: [], saying: 'x'.repeat(141) }),
  );
  // A message is told what they did since this conversation last saw the board, once.
  await tools.call('board.save', owner, {
    id: made.id,
    elements: [
      shape('note1', {
        type: 'text',
        text: 'no',
        x: 900,
        y: 120,
        version: 2,
        seed: 1,
        versionNonce: 2,
        groupIds: [],
        customData: {},
      }),
    ],
  });
  const note = await tools.notes(owner, 'pi');
  assert.match(note, new RegExp(`^\\[board ${made.id}, since you last looked: wrote "no" near `));
  assert.equal(await tools.notes(owner, 'pi'), '');
  assert.ok((await draw(1500)).notRun);
  // An agent back at the board reads what it has not been told; here nothing is left to tell.
  const read = (await tools.call('board.read:get', pi, { board: made.id })) as { hand?: string[] };
  assert.equal(read.hand, undefined);
  await tools.call('board.scene', owner, { id: made.id });
  const pen = await draw(1500);
  assert.ok(pen.ms >= 400, `held ${pen.ms} ms`);
  assert.equal(pen.steppedIn, undefined);
  // Open, and their hand comes down meanwhile: at once, and nothing more is stored.
  await tools.call('board.scene', owner, { id: made.id });
  const before = (await board.scene(owner, made.id)).board.revision;
  const during = draw(1800);
  while ((await board.scene(owner, made.id)).board.revision === before);
  await tools.call('board.hand', owner, { id: made.id });
  const heard = await during;
  assert.equal((heard.steppedIn as { how?: string }).how, 'drew');
  assert.ok(heard.ms < 400, `told after ${heard.ms} ms`);
  assert.equal(heard.notRun, undefined);
  assert.equal((await board.scene(owner, made.id)).board.revision, before + 1);
});
