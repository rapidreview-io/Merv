import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Artifact, Caller } from '@merv/contracts';
import { view } from '@merv/artifacts/content';
import { createApp } from './fixtures/app.js';
import { stateConfig } from './fixtures/state.js';
import { s3Blobs } from './fixtures/s3-blobs.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-content-'));
  const { server, entry } = await s3Blobs(t);
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        entry,
        { id: 'artifacts', name: '@merv/artifacts' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Content',
    actorName: 'Owner',
  });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  return { app, caller, server };
}

const artifact = { id: 'art_x' } as Artifact;
/** Every page of `bytes` at `size`, advancing either by the request or by what came back. */
function pages(bytes: Buffer, size: number, style: 'request' | 'returned') {
  const out: { content: string; offset: number; total: number }[] = [];
  for (let offset = 0; ;) {
    const page = view(artifact, bytes, { offset, length: size }) as (typeof out)[number];
    out.push(page);
    if (page.offset + page.content.length >= page.total) return out;
    offset = style === 'request' ? offset + size : page.offset + page.content.length;
  }
}

test('ranges move forward to whole code points and whole base64 groups', () => {
  const text = Buffer.from('a😀b');
  assert.deepEqual(view(artifact, text, { offset: 0, length: 2 }), {
    artifact,
    content: 'a😀',
    encoding: 'utf8',
    offset: 0,
    total: 4,
  });
  assert.deepEqual(view(artifact, text, { offset: 2, length: 2 }), {
    artifact,
    content: 'b',
    encoding: 'utf8',
    offset: 3,
    total: 4,
  });
  // A start inside a character gives an empty page that still reports where the next one is.
  assert.deepEqual(view(artifact, text, { offset: 2, length: 1 }).content, '');
  assert.equal(view(artifact, text, { offset: 2, length: 1 }).offset, 3);
  assert.deepEqual(view(artifact, text, { offset: 9 }), {
    artifact,
    content: '',
    encoding: 'utf8',
    offset: 4,
    total: 4,
  });
  const binary = Buffer.from([0, 1, 2, 3, 4, 5, 6]); // AAECAwQFBg==
  assert.deepEqual(view(artifact, binary, { offset: 1, length: 5 }), {
    artifact,
    content: 'AwQF',
    encoding: 'base64',
    offset: 4,
    total: 12,
  });
  assert.equal(view(artifact, binary, { length: 5 }).content, 'AAECAwQF');
  assert.equal(view(artifact, binary, { offset: 1, length: 2 }).content, '');
});

test('both paging styles reproduce random astral text and random base64 exactly', () => {
  const alphabet = ['a', 'é', '中', '😀', '𝄞', '\n', '👍🏽'];
  for (let round = 0; round < 20; round++) {
    const text = Array.from(
      { length: 1 + Math.floor(Math.random() * 40) },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('');
    const binary = Buffer.concat([Buffer.from([0]), randomBytes(Math.floor(Math.random() * 40))]);
    for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      for (const style of ['request', 'returned'] as const) {
        const utf8 = pages(Buffer.from(text), size, style);
        assert.equal(utf8.map((p) => p.content).join(''), text, `${size} ${style} ${text}`);
        for (const page of utf8) assert.ok(!/\p{Surrogate}/u.test(page.content), page.content);
        const base64 = pages(binary, size, style);
        const input = `${size} ${style} ${binary.toString('hex')}`;
        assert.equal(base64.map((p) => p.content).join(''), binary.toString('base64'), input);
        assert.deepEqual(
          Buffer.concat(base64.map((p) => Buffer.from(p.content, 'base64'))),
          binary,
          input,
        );
        for (const page of base64) assert.equal(page.content.length % 4, 0, input);
      }
  }
});

test('pages round-trip through create, and malformed ranges are refused before reading', async (t) => {
  const { app, caller } = await fixture(t);
  const note = await app.ctx.artifacts.create(caller, { title: 'Emoji', content: 'a😀b' });
  const first = await app.ctx.artifacts.read(caller, note.id, { offset: 0, length: 2 });
  const second = await app.ctx.artifacts.read(caller, note.id, { offset: 2, length: 2 });
  assert.deepEqual(
    [first.content, first.offset, second.content, second.offset],
    ['a😀', 0, 'b', 3],
  );
  for (const page of [first, second]) {
    const copy = await app.ctx.artifacts.create(caller, { title: 'Page', content: page.content });
    assert.equal((await app.ctx.artifacts.read(caller, copy.id)).content, page.content);
  }
  for (const range of [
    { offset: -5 },
    { offset: Number.NaN },
    { offset: 1.5 },
    { offset: '1' },
    { length: 0 },
    { length: 1.5 },
    { length: Infinity },
  ])
    await assert.rejects(
      app.ctx.artifacts.read(caller, 'art_missing', range as { offset?: number }),
      { code: 'invalid_range' },
      JSON.stringify(range),
    );
  await assert.rejects(app.ctx.artifacts.read(caller, 'art_missing', { offset: 0 }), {
    code: 'not_found',
  });
});

test('base64 without a media type is typed from its bytes', async (t) => {
  const { app, caller } = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const image = await app.ctx.artifacts.create(caller, {
    title: 'Pixel',
    content: png.toString('base64'),
    encoding: 'base64',
  });
  assert.equal(image.mediaType, 'application/octet-stream');
  const text = await app.ctx.artifacts.create(caller, {
    title: 'Notes',
    content: Buffer.from('# Notes\né').toString('base64'),
    encoding: 'base64',
  });
  assert.equal(text.mediaType, 'text/markdown');
  const nul = await app.ctx.artifacts.create(caller, {
    title: 'NUL',
    content: Buffer.from('a\0b').toString('base64'),
    encoding: 'base64',
  });
  assert.equal(nul.mediaType, 'application/octet-stream');
  const declared = await app.ctx.artifacts.create(caller, {
    title: 'Declared',
    content: png.toString('base64'),
    encoding: 'base64',
    mediaType: 'Image/PNG',
  });
  assert.equal(declared.mediaType, 'image/png');
});

test('create and uploadBegin refuse malformed media types and request IDs with coded errors', async (t) => {
  const { app, caller, server } = await fixture(t);
  const upload = { title: 'Rows', size: 10, sha256: 'a'.repeat(64), mediaType: 'text/csv' };
  for (const mediaType of [42, true, [], {}, 'text/plain; charset=utf-8', 'text']) {
    await assert.rejects(
      app.ctx.artifacts.create(caller, {
        title: 'Typed',
        content: 'x',
        mediaType: mediaType as string,
      }),
      { code: 'invalid_media_type' },
      String(mediaType),
    );
    await assert.rejects(
      app.ctx.artifacts.uploadBegin(caller, { ...upload, mediaType: mediaType as string }),
      { code: 'invalid_media_type' },
      String(mediaType),
    );
  }
  for (const title of [42, '', '   ', 'x'.repeat(301)])
    await assert.rejects(
      app.ctx.artifacts.create(caller, { title: title as string, content: 'x' }),
      { code: 'invalid_artifact' },
    );
  for (const requestId of [42, '', 'r'.repeat(129)])
    await assert.rejects(
      app.ctx.artifacts.uploadBegin(caller, { ...upload, requestId: requestId as string }),
      { code: 'invalid_artifact' },
      String(requestId),
    );
  assert.deepEqual(server.requests, []);
  // Whitespace is a request ID like any other: it is only hashed.
  const blank = await app.ctx.artifacts.uploadBegin(caller, { ...upload, requestId: '  ' });
  const again = await app.ctx.artifacts.uploadBegin(caller, { ...upload, requestId: '  ' });
  assert.equal(again.uploadId, blank.uploadId);
  assert.match(blank.uploadId, /^aup_[0-9a-f]{64}$/);
});
