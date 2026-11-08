import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import type { BoardElement } from '@merv/board';
import { boardApp } from './fixtures/board.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const MIB = 1024 * 1024;

const image = (id: string, fileId: string, version = 1): BoardElement =>
  ({
    id,
    type: 'image',
    version,
    versionNonce: 1,
    isDeleted: false,
    x: 10,
    y: 20,
    width: 100,
    height: 100,
    fileId,
  }) as BoardElement;

async function fixture(t: test.TestContext) {
  const f = await boardApp(t, 'board-images-');
  const boot = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Pictures',
    actorName: 'Owner',
  });
  const owner = { token: boot.token, project: boot.project.id };
  const other = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Stranger',
  });
  const caller = (boot: typeof other): Caller => ({
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  });
  const member = await f.app.ctx.scope.credentials.issueActor(caller(boot), {
    name: 'Colleague',
    role: 'reader',
  });
  const request = (path: string, who: { token: string; project: string }, init: RequestInit = {}) =>
    fetch(`${f.app.ctx.api.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${who.token}`,
        'x-merv-project-id': who.project,
        'content-type': 'application/octet-stream',
      },
    });
  const put = (fileId: string, body: Buffer, who = owner) =>
    request(`/board-images/${fileId}`, who, { method: 'PUT', body: new Uint8Array(body) });
  const get = (fileId: string, who = owner) => request(`/board-images/${fileId}`, who);
  return {
    ...f,
    board: f.app.ctx.board,
    owner,
    colleague: { token: member.token, project: owner.project },
    stranger: { token: other.token, project: other.project.id },
    ownerCaller: caller(boot),
    strangerCaller: caller(other),
    put,
    get,
  };
}

test('an image is stored and read back by its project alone, under no public link', async (t) => {
  const f = await fixture(t);
  const put = await f.put('file1', PNG);
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { fileId: 'file1', mediaType: 'image/png', size: PNG.length });

  // A colleague reads the same bytes, as they were stored and never cached past membership.
  const read = await f.get('file1', f.colleague);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), PNG);

  // No bearer, no bytes.
  assert.equal((await fetch(`${f.app.ctx.api.url}/board-images/file1`)).status, 401);
  // Someone of another project, naming this one, is refused; naming their own, it is not there.
  assert.equal(
    (await f.get('file1', { token: f.stranger.token, project: f.owner.project })).status,
    403,
  );
  assert.equal((await f.get('file1', f.stranger)).status, 404);
  // Nor can they store into this project.
  assert.equal(
    (await f.put('file2', PNG, { token: f.stranger.token, project: f.owner.project })).status,
    403,
  );
  assert.equal((await f.get('file2')).status, 404);
  // Nor does anyone who reads a project without belonging to it see what its people pasted.
  const platform = { issuer: 'i', subject: 's', expiresAt: '2099-01-01T00:00:00Z' };
  await assert.rejects(f.board.image({ ...f.ownerCaller, platform }, 'file1'), {
    code: 'forbidden',
  });
  // Their own project's copy under the same name is separate.
  assert.equal((await f.put('file1', Buffer.from('GIF89a-stranger'), f.stranger)).status, 200);
  assert.deepEqual(Buffer.from(await (await f.get('file1')).arrayBuffer()), PNG);
});

test('an image is taken by what its bytes are, whatever is claimed, and up to 10 MiB', async (t) => {
  const f = await fixture(t);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  for (const [bytes, type] of [
    [PNG, 'image/png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
    [Buffer.from('GIF87a....'), 'image/gif'],
    [webp, 'image/webp'],
  ] as const) {
    const fileId = `ok-${type.slice(6)}`;
    assert.equal((await f.put(fileId, bytes)).status, 200, type);
    assert.equal((await f.get(fileId)).headers.get('content-type'), type);
  }
  for (const bad of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    Buffer.from('<html><script>alert(1)</script></html>'),
    Buffer.from('RIFF....WAVEfmt '),
    Buffer.from('BM............'),
    Buffer.alloc(0),
  ]) {
    const refused = await f.put('bad', bad);
    assert.equal(refused.status, 415, bad.toString());
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'image_type');
  }
  assert.equal((await f.get('bad')).status, 404);

  const fits = Buffer.concat([PNG, Buffer.alloc(10 * MIB - PNG.length)]);
  assert.equal((await f.put('largest', fits)).status, 200);
  assert.equal((await f.get('largest')).headers.get('content-length'), String(10 * MIB));
  assert.equal((await f.put('over', Buffer.concat([fits, Buffer.alloc(1)]))).status, 413);
  await assert.rejects(
    f.board.storeImage(f.ownerCaller, 'over', Buffer.concat([fits, Buffer.alloc(1)])),
    { code: 'image_too_large' },
  );
  assert.equal((await f.get('over')).status, 404);

  for (const name of ['a/b', 'a.b', 'x'.repeat(101)])
    await assert.rejects(f.board.storeImage(f.ownerCaller, name, PNG), {
      code: 'invalid_board_input',
    });
});

test('bytes outlive their shape by its 30 days, and any shape of the project keeps them', async (t) => {
  const f = await fixture(t);
  const [one, two] = [
    await f.board.create(f.ownerCaller, 'One'),
    await f.board.create(f.ownerCaller, 'Two'),
  ];
  for (const file of ['shared', 'alone', 'never-drawn', 'fresh']) await f.put(file, PNG);
  await f.board.save(f.ownerCaller, one.id, [image('a', 'shared'), image('b', 'alone')]);
  await f.board.save(f.ownerCaller, two.id, [image('c', 'shared')]);
  // Both of board one's images are deleted; `shared` is still on board two.
  await f.board.save(f.ownerCaller, one.id, [
    { ...image('a', 'shared', 2), isDeleted: true },
    { ...image('b', 'alone', 2), isDeleted: true },
  ]);
  // A deleted shape within its window keeps its bytes, for undo and for a late merge.
  await f.board.save(f.ownerCaller, one.id, [image('x', 'shared')]);
  assert.equal((await f.get('alone')).status, 200);

  const long = new Date(Date.now() - 31 * 86_400_000).toISOString();
  await f.app.ctx.state.transaction(async (tx) => {
    // What history names is kept for as long as it lasts (board-replay.test.ts): here, it never did.
    await tx.run(`DELETE FROM board_history_files`);
    await tx.run(`UPDATE board_elements SET deleted_at=? WHERE deleted`, long);
    await tx.run(`UPDATE board_images SET stored_at=? WHERE file_id<>'fresh'`, long);
  });
  await f.board.save(f.ownerCaller, one.id, [image('y', 'shared')]);
  assert.equal((await f.get('alone')).status, 404, 'no shape can name it any more');
  assert.equal((await f.get('never-drawn')).status, 404, 'stored long ago and never drawn');
  assert.equal((await f.get('shared')).status, 200, 'live shapes name it');
  assert.equal((await f.get('fresh')).status, 200, 'just stored, its shape is on the way');
});
