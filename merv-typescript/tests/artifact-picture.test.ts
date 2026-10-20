import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactPicture } from '../packages/artifacts/src/picture.js';
import { artifactToolsPlugin } from '../packages/artifacts/src/tools.js';
test('image reference lookup authorizes first, reads full bounded binary, and passes source-pixel crop', async (t) => {
  let drawer: any;
  const calls: any[] = [];
  t.mock.method(ArtifactPicture.prototype, 'render', async (...args: any[]) => {
    calls.push(args);
    return {
      image: { data: '/9j/', mimeType: 'image/jpeg' as const },
      viewport: { x: 0, y: 0, width: 20, height: 20 },
      width: 20,
      height: 20,
      source: { width: 20, height: 20 },
    };
  });
  artifactToolsPlugin.apply({
    effect: (f: any) => f(),
    tools: {
      register: () => () => {},
      noun: () => () => {},
      contributeInstructions: () => () => {},
      contributePicture: (_p: any, f: any) => {
        drawer = f;
        return () => {};
      },
    },
    artifacts: {
      get: async (c: any) => {
        if (c.actorId === 'denied') throw Error('denied');
        return { mediaType: c.type ?? 'image/jpeg', size: 5_000_000 };
      },
      readStored: async (_c: any, _id: any, range: any) => {
        assert.equal(range.length, 6_666_668);
        return { encoding: 'base64', content: '/9j/' };
      },
    },
  } as any);
  const crop = { action: 'region', x: 1, y: 2, width: 10, height: 20 };
  const result = await drawer({ actorId: 'allowed' }, 'art_reference', undefined, crop);
  assert.deepEqual(calls, [['/9j/', 'image/jpeg', crop]]);
  assert.equal(result.path, '/ui/artifacts/art_reference');
  assert.equal(await drawer({ actorId: 'allowed', type: 'text/plain' }, 'art_text'), undefined);
  await assert.rejects(() => drawer({ actorId: 'denied' }, 'art_reference'), /denied/);
  assert.equal(calls.length, 1);
});
