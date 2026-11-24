/**
 * Speaking and drawing together, as the board holds every drawer to it: new ink reaches a waiting
 * page as it lands, no line is lost to a later change, the model is held to the page's telling,
 * a malformed call is told what to change, and one short contract is on every tool that draws.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { BoardWatch } from '../packages/board/src/hold.js';
import { httpApp } from './fixtures/app.js';

async function fixture(t: test.TestContext) {
  const f = await httpApp(t, 'board-speak-draw-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Ideas',
    actorName: 'Owner',
  });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const board = await f.app.ctx.board.create(caller, 'Ideas');
  const tools = f.app.ctx.tools;
  /** An agent's draw, as Merv's own agent and a lent session make it. */
  const draw = async (ops: object[]) =>
    (
      await tools.invoke(
        'board.write',
        caller,
        { action: 'draw', draw: { board: board.id, ops } },
        true,
      )
    ).value as {
      board: { revision: number };
      created: Record<string, string>;
      pace?: string;
    };
  /** The page's own calls. */
  const page = async <T>(name: string, input: object) =>
    (await tools.invoke(name, caller, input)).value as T;
  return { ...f, caller, board, draw, page };
}
type Scene = {
  board: { revision: number };
  elements: { id: string; customData?: { say?: string } }[];
};

test('a line survives its shape being touched again before the page fetched it', async (t) => {
  const f = await fixture(t);
  const first = await f.draw([{ op: 'box', key: 'a', text: 'key', say: 'You start with a key.' }]);
  // The next call joins an arrow to that box before any page has looked: the box changes again.
  await f.draw([
    {
      op: 'box',
      key: 'b',
      text: 'hash()',
      near: first.created.a,
      side: 'right',
      say: 'It goes through a hash function.',
    },
    { op: 'arrow', from: first.created.a, to: 'b' },
  ]);
  const scene = await f.page<Scene>('board.scene', { id: f.board.id, since: 0 });
  const lines = scene.elements.map((el) => el.customData?.say).filter(Boolean);
  assert.deepEqual(lines.sort(), ['It goes through a hash function.', 'You start with a key.']);
  // What a page has fetched is not said to it again when the shape changes later.
  await f.draw([{ op: 'move', id: first.created.a, at: [400, 400] }]);
  const later = await f.page<Scene>('board.scene', { id: f.board.id, since: scene.board.revision });
  assert.ok(
    later.elements.some((el) => el.id === first.created.a),
    'the moved box comes again',
  );
  assert.deepEqual(later.elements.map((el) => el.customData?.say).filter(Boolean), []);
});

test('the next call waits until the page has handed every line so far to its voice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const watch = new BoardWatch();
  const release = async (told: () => void) => {
    let done = false;
    const held = watch.hold('b', 'agent', 400, true, 7).then(() => (done = true));
    t.mock.timers.tick(700);
    await Promise.resolve();
    assert.equal(done, false, 'ink long done, but lines are still unsaid: the model waits');
    told();
    t.mock.timers.tick(400);
    await held;
  };
  // The page speaks, has not fetched revision 7 yet, then has it with a line still to say, then none.
  watch.asked('b', { since: 6, unsaid: 0 });
  await release(() => watch.asked('b', { since: 7, unsaid: 0 }));
  watch.asked('b', { since: 7, unsaid: 2 });
  await release(() => watch.asked('b', { since: 8, unsaid: 0 }));
  // A page that only shows the lines holds nothing back beyond the ink.
  const silent = new BoardWatch();
  silent.asked('c');
  const at = Date.now();
  await silent.hold('c', 'agent', 400, true, 3);
  assert.ok(Date.now() - at < 200);
  watch.close();
  silent.close();
});

test('a cached transcript still checks artifact access on every page', async (t) => {
  const f = await fixture(t);
  const artifact = await f.app.ctx.artifacts.create(f.caller, {
    title: 'Session',
    content: JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'Explain this' },
    }),
  });
  const reads: string[] = [];
  const call = f.app.ctx.tools.call.bind(f.app.ctx.tools);
  t.mock.method(f.app.ctx.tools, 'call', (...args: Parameters<typeof call>) => {
    if (args[0].startsWith('artifact.read:')) reads.push(args[0]);
    return call(...args);
  });
  const read = (who: Caller) =>
    f.app.ctx.tools.invoke('board.read:transcript', who, { artifact: artifact.id, from: 1, to: 1 });
  const first = await read(f.caller);
  assert.deepEqual(await read(f.caller), first);
  const other = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Stranger',
  });
  await assert.rejects(
    read({
      projectId: other.project.id,
      actorId: other.actor.id,
      credentialId: other.credential.id,
    }),
    { code: 'not_found' },
  );
  assert.deepEqual(reads, ['artifact.read:content', 'artifact.read:get', 'artifact.read:get']);
});

test('another client save, said lines and page cards wake board readers after commit', async (t) => {
  const f = await fixture(t);
  const service = f.app.ctx.board;
  const drawn = await f.draw([{ op: 'box', text: 'Original' }]);
  let revision = drawn.board.revision;
  const wake = async (change: () => Promise<unknown>) => {
    let answered = false;
    const waiting = f
      .page<{ revision: number }>('board.wait', { id: f.board.id, since: revision })
      .then((value) => {
        answered = true;
        return value;
      });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(answered, false);
    await change();
    const result = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(Error('board did not wake')), 2000);
        timer.unref();
      }),
    ]);
    assert.ok(result.revision > revision);
    revision = result.revision;
    assert.equal((await service.scene(f.caller, f.board.id)).board.revision, revision);
  };
  const scene = await service.scene(f.caller, f.board.id);
  await wake(() =>
    service.save(f.caller, f.board.id, [
      { ...scene.elements[0], version: scene.elements[0].version + 1, x: 200 },
    ]),
  );
  await wake(() => service.said(f.caller, f.board.id, { by: 'person', words: 'A spoken line' }));
  await wake(() =>
    service.draw(f.caller, {
      board: f.board.id,
      ops: [{ op: 'page', text: 'Plan', body: 'First' }],
    }),
  );
});
