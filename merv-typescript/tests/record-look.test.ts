import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'cordis';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { ArtifactPicture } from '../packages/artifacts/src/picture.js';
import { artifactToolsPlugin } from '../packages/artifacts/src/tools.js';
import { BoardRenderer } from '../packages/board/src/renderer.js';
import { boardToolsPlugin } from '../packages/board/src/tools.js';
import { recordLookTool } from '../packages/pi/src/record-look.js';

const code = (name: string) => (error: unknown) => (error as { code?: string })?.code === name;

test('record.look shows any caller a board or an image artifact as MCP image content', async (t) => {
  const tools = new ToolRegistry({ require: async () => ({}) as never });
  t.after(() => tools.close());
  const image = { data: '/9j/', mimeType: 'image/jpeg' as const };
  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  const drawn = { image, viewport, width: 100, height: 100 };
  const renders: unknown[][] = [];
  t.mock.method(BoardRenderer.prototype, 'render', async (...args: unknown[]) => {
    renders.push(args);
    return drawn;
  });
  t.mock.method(ArtifactPicture.prototype, 'render', async (...args: unknown[]) => {
    renders.push(args);
    return { ...drawn, source: { width: 100, height: 100 } };
  });
  // The real drawers, over a board and artifact store that hold one record each.
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    tools,
    board: { scene: async (_: unknown, id: string) => ({ board: { id }, elements: [] }) },
    artifacts: {
      get: async (_: unknown, id: string) => ({
        mediaType: id === 'art_notes' ? 'text/plain' : 'image/png',
        size: 3,
      }),
      readStored: async () => ({ encoding: 'base64', content: 'iVBO' }),
    },
  } as unknown as Context;
  boardToolsPlugin.apply(ctx);
  artifactToolsPlugin.apply(ctx);
  tools.register(recordLookTool(tools));
  const caller = { projectId: 'project_1', actorId: 'actor_1' };
  const look = (input: unknown) => tools.invoke('record.look', caller, input, true);

  const board = await look({ record: 'board_1', focus: 'frame_1', view: { action: 'fit' } });
  assert.deepEqual(board.mcp?.content[1], { type: 'image', ...image });
  assert.deepEqual(JSON.parse((board.mcp?.content[0] as { text: string }).text), {
    page: '/ui/boards/board_1',
    seen: 'Actual Excalidraw board image. Coordinates in viewport are board units.',
    viewport,
  });
  assert.deepEqual(renders.shift()?.slice(2), [{ action: 'fit' }, 'frame_1']);

  const art = await look({ record: 'art_photo' });
  assert.deepEqual(art.mcp?.content[1], { type: 'image', ...image });
  assert.equal((art.value as { page: string }).page, '/ui/artifacts/art_photo');
  assert.deepEqual(renders.shift(), ['iVBO', 'image/png', undefined]);

  // What has no picture, or is no record, is refused as input.
  await assert.rejects(look({ record: 'art_notes' }), code('invalid_input'));
  await assert.rejects(look({ record: 'exp_1' }), code('invalid_input'));
  await assert.rejects(look({ page: 'Work' }), code('invalid_input'));
  await assert.rejects(look({ record: 'board 1' }), code('invalid_input'));
  assert.equal(renders.length, 0);
});
