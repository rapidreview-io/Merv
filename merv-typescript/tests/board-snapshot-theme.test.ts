import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoardWatch } from '../packages/board/src/hold.js';
import { boardToolsPlugin } from '../packages/board/src/tools.js';
import { BoardRendering } from '../packages/board/src/rendering.js';
import { BoardRenderer } from '../packages/board/src/renderer.js';

const caller = { projectId: 'project', actorId: 'person' };
test('display appearance is scoped to person and board and never mutates authored data', async (t) => {
  const calls: any[][] = [];
  t.mock.method(BoardRenderer.prototype, 'render', async (...args: any[]) => {
    calls.push(args);
    return {};
  });
  const scene = { board: { id: 'board', paper: '#fffce8' }, elements: [] } as any;
  const rendering = new BoardRendering({
    scene: async () => scene,
    image: async () => {
      throw Error('unused');
    },
  });
  t.after(() => rendering.close());
  const draw = async (who = caller, options = {}) => {
    await rendering.render(who, scene, options);
    return calls.at(-1)!.slice(6);
  };
  assert.deepEqual(await draw(), ['#fffce8', 'light']);
  const definitions = new Map<string, any>();
  let refused = false;
  boardToolsPlugin.apply({
    board: {
      watch: new BoardWatch(),
      scene: async () => {
        if (refused) throw Error('not allowed');
        return scene;
      },
      display: rendering.display.bind(rendering),
    },
    state: {},
    inject() {},
    effect: (fn: () => unknown) => {
      const close = fn();
      if (typeof close === 'function') t.after(() => close());
    },
    provide() {},
    tools: new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'register'
            ? (definition: any) => definitions.set(definition.name, definition)
            : () => {},
      },
    ),
  } as any);
  const read = definitions.get('board.scene');
  const input = read.inputSchema.parse({ id: 'board', appearance: 'dark' });
  await read.handler(caller, input);
  await read.handler({ ...caller, conversation: { id: 'pi' } }, { ...input, appearance: 'light' });
  refused = true;
  await assert.rejects(read.handler(caller, { ...input, appearance: 'light' }), /not allowed/);
  assert.deepEqual(await draw(), ['#ffffff', 'dark']);
  assert.deepEqual(await draw({ ...caller, actorId: 'other' }), ['#fffce8', 'light']);
  assert.deepEqual(await draw({ ...caller, projectId: 'other' }), ['#fffce8', 'light']);
  assert.deepEqual(await draw(caller, { appearance: 'light' }), ['#fffce8', 'light']);
  assert.equal(scene.board.paper, '#fffce8');
  scene.board.paper = '#121212';
  assert.deepEqual(await draw(), ['#121212', 'light'], 'authored dark paper is not inverted');
  scene.board.paper = '#fffce8';
  rendering.display(caller, 'board', 'light');
  assert.deepEqual(await draw(), ['#fffce8', 'light']);
  scene.board.id = 'another-board';
  assert.deepEqual(await draw(), ['#fffce8', 'light']);
});
