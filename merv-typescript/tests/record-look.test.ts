import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'cordis';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { ArtifactPicture } from '../packages/artifacts/src/picture.js';
import { artifactToolsPlugin } from '../packages/artifacts/src/tools.js';
import { BoardRenderer } from '../packages/board/src/renderer.js';
import { boardToolsPlugin } from '../packages/board/src/tools.js';
import { fixture } from './fixtures/pi.js';
import { fit } from '../packages/pi/src/fit.js';
import { screenImage } from '../packages/pi/src/tool-image.js';
import { recordLookTool } from '../packages/pi/src/record-look.js';

const code = (name: string) => (error: unknown) => (error as { code?: string })?.code === name;

function pictures(t: TestContext, tools: ToolRegistry, data = '/9j/') {
  const image = { data, mimeType: 'image/jpeg' as const };
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
  return { image, viewport, renders };
}

test('noun looks and retired record.look preserve image results, flat inputs and worker listings', async (t) => {
  let snapshots = 0;
  const tools = new ToolRegistry({ require: async () => ({}) as never }, undefined, async (fn) => {
    snapshots++;
    return fn();
  });
  t.after(() => tools.close());
  const { image, viewport, renders } = pictures(t, tools);
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

  const crop = { action: 'region', x: 1, y: 2, width: 20, height: 30 };
  const before = snapshots;
  const noun = await tools.invoke(
    'artifact.read',
    caller,
    {
      action: 'look',
      look: { artifactId: 'art_photo', view: crop },
    },
    true,
  );
  assert.equal(snapshots, before + 1, 'artifact look runs in a read snapshot');
  assert.deepEqual(noun, art);
  assert.deepEqual(renders.shift(), ['iVBO', 'image/png', crop]);
  const agentNames = (await tools.describe(caller, true)).map(({ name }) => name);
  assert.ok(agentNames.includes('artifact.read'));
  assert.ok(!agentNames.includes('record.look'));
  const worker = { ...caller, session: { id: 'session_1' } };
  tools.registerSessionPolicy({
    allowsTool: async (_caller, _name, read) => !!read,
    prepare: async (caller, tool, input) => ({ caller, tool, input }),
    validate: async () => {},
    cancel: () => {},
    run: async (invocation, handler) => handler(invocation.caller, invocation.input),
  });
  const listing = await tools.describe(worker, true);
  const retired = listing.find(({ name }) => name === 'record.look')!;
  assert.equal(
    retired.description,
    'See a board or a JPEG, PNG or WebP image artifact as an image, drawn by Merv without anyone’s screen. focus: a board frame, group or shape id. view: fit, region (board units or source pixels), pan or zoom. Does not change the record.',
  );
  assert.deepEqual(
    listing.map(({ name }) => name),
    [
      'artifact.get',
      'artifact.list',
      'artifact.read',
      'artifact.storage_status',
      'board.look',
      'board.read',
      'board.scene',
      'record.look',
    ],
  );
  assert.deepEqual(Object.keys(retired.inputSchema.properties!), ['record', 'focus', 'view']);
  assert.ok(
    !('action' in listing.find(({ name }) => name === 'artifact.read')!.inputSchema.properties!),
  );
  assert.deepEqual(
    await tools.invoke('record.look', worker, { record: 'art_photo', focus: 'ignored' }, true),
    art,
  );
  assert.deepEqual(renders.shift(), ['iVBO', 'image/png', undefined]);

  assert.deepEqual(
    await tools.invoke(
      'record.look',
      worker,
      { record: 'board_1', focus: 'frame_1', view: { action: 'fit' } },
      true,
    ),
    board,
  );
  assert.deepEqual(renders.shift()?.slice(2), [{ action: 'fit' }, 'frame_1']);

  // What has no picture, or is no record, is refused as input.
  await assert.rejects(look({ record: 'art_notes' }), code('invalid_input'));
  await assert.rejects(
    tools.invoke(
      'artifact.read',
      caller,
      {
        action: 'look',
        look: { artifactId: 'art_notes' },
      },
      true,
    ),
    code('invalid_input'),
  );
  await assert.rejects(
    tools.invoke(
      'artifact.read',
      caller,
      {
        action: 'look',
        look: { artifactId: 'art_photo', view: { action: 'zoom', factor: 0 } },
      },
      true,
    ),
    code('invalid_input'),
  );
  await assert.rejects(
    look({ record: 'art_photo', artifactId: 'art_other' }),
    code('invalid_input'),
  );
  await assert.rejects(look({ record: 'exp_1' }), code('invalid_input'));
  await assert.rejects(look({ page: 'Work' }), code('invalid_input'));
  await assert.rejects(look({ record: 'board 1' }), code('invalid_input'));
  assert.equal(renders.length, 0);
});

test('a frozen Pi turn still calls record.look and receives its full image', async (t) => {
  const f = await fixture(t);
  const { image, viewport } = pictures(t, f.tools, 'A'.repeat(48_000));
  // A real persisted turn from before retirement can contain record.look even though new turns
  // no longer offer it. Seed only that frozen name; the relay still enforces the turn's allowlist.
  const bound = await f.begun(f.operator);
  assert.ok(!bound.work.tools.some(({ name }) => name === 'record.look'));
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE pi_commands SET data_json=jsonb_set(data_json::jsonb, '{tools}', '[\"record.look\"]'::jsonb)::text WHERE conversation_id=? AND id=?",
      bound.input.conversationId,
      bound.input.commandId,
    ),
  );
  for (const [record, page, seen] of [
    [
      'art_photo',
      '/ui/artifacts/art_photo',
      'Actual reference image. Viewport coordinates are source pixels; use region for readable details.',
    ],
    [
      'board_1',
      '/ui/boards/board_1',
      'Actual Excalidraw board image. Coordinates in viewport are board units.',
    ],
  ]) {
    const result = await f.pi.tool(bound.token, {
      ...bound.input,
      name: 'record.look',
      input: { record },
    });
    assert.deepEqual(result, { page, seen, image, viewport });
    assert.deepEqual(screenImage(fit('record.look', result)), {
      image,
      metadata: { page, seen, viewport },
    });
  }
  await assert.rejects(
    f.pi.tool(bound.token, {
      ...bound.input,
      name: 'artifact.read',
      input: { action: 'look', look: { artifactId: 'art_photo' } },
    }),
    code('pi_tool_forbidden'),
  );
});
