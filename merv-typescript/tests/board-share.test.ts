import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';

test('a share reads only its board, is owner-controlled, revocable, and grants no write authority', async (t) => {
  const { app, tool } = await httpApp(t, 'board-share-');
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Private',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const board = app.ctx.board;
  const made = await board.create(owner, 'Shared drawing');
  const hidden = await board.create(owner, 'Private drawing');
  await board.draw(owner, {
    board: made.id,
    ops: [{ op: 'note', text: 'Visible', say: 'A spoken line' }],
  });
  await board.draw(owner, { board: hidden.id, ops: [{ op: 'note', text: 'Secret' }] });
  const colleague = await app.ctx.scope.credentials.issueActor(owner, {
    name: 'Reader',
    role: 'reader',
  });
  await assert.rejects(
    board.share({ projectId: owner.projectId, actorId: colleague.actor.id }, made.id),
    /owner/,
  );
  const { token } = await board.share(owner, made.id);
  assert.ok(token);
  const read = async (path: string, bearer = token, method = 'GET') => {
    const response = await fetch(`${app.ctx.api.url}/board-share/${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}` },
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  };
  const scene = await read('scene');
  assert.equal(scene.status, 200);
  assert.deepEqual(Object.keys(scene.body).sort(), ['elements', 'revision', 'title']);
  assert.deepEqual((await read(`scene?id=${hidden.id}`)).body, scene.body);
  const history = await read('history');
  assert.equal(history.status, 200);
  assert.equal(history.body.changes.length, 1);
  assert.notEqual(history.body.changes[0].actorId, owner.actorId);
  const publicData = JSON.stringify([scene.body, history.body]);
  assert.ok(!publicData.includes(owner.projectId));
  assert.ok(!publicData.includes(owner.actorId));
  assert.ok(!publicData.includes('Secret'));
  assert.ok(publicData.includes('A spoken line'));
  for (const method of ['POST', 'PUT', 'DELETE'])
    assert.equal((await read('scene', token, method)).status, 404);
  for (const name of ['board.save', 'board.set', 'board.share']) {
    const response = await tool(name, token, { id: made.id });
    assert.equal(response.status, 401);
  }
  assert.equal((await tool('board.scene', token, { id: hidden.id })).status, 401);
  const wrong = `mbs_${'x'.repeat(43)}`;
  for (const path of ['scene', 'history', `images/${'a'.repeat(40)}`]) {
    const result = await read(path, wrong);
    assert.equal(result.status, 404);
    assert.ok(!JSON.stringify(result.body).includes('Visible'));
  }
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  );
  const file = 'b'.repeat(40);
  await board.storeImage(owner, file, PNG);
  assert.equal((await read(`images/${file}`)).status, 404);
  await board.save(owner, made.id, [
    {
      id: 'picture',
      type: 'image',
      version: 1,
      versionNonce: 1,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      isDeleted: false,
      fileId: file,
      link: `/projects/${owner.projectId}`,
      customData: { target: hidden.id, changedBy: owner.actorId, details: 'Private metadata' },
    },
  ]);
  const image = await fetch(`${app.ctx.api.url}/board-share/images/${file}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  const publicScene = await read('scene');
  const publicHistory = await read('history');
  const shared = JSON.stringify([publicScene.body, publicHistory.body]);
  for (const secret of [hidden.id, owner.projectId, owner.actorId, 'Private metadata'])
    assert.ok(!shared.includes(secret));
  const rows = await app.ctx.state.transaction((tx) =>
    tx.all<{ digest: string }>('SELECT digest FROM board_shares'),
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(rows[0]!.digest, token);
  const rotated = await board.share(owner, made.id);
  assert.equal((await read('scene')).status, 404);
  assert.equal((await read('scene', rotated.token)).status, 200);
  await board.share(owner, made.id, true);
  for (const path of ['scene', 'history', `images/${file}`]) {
    const result = await read(path, rotated.token);
    assert.equal(result.status, 404);
    assert.ok(!JSON.stringify(result.body).includes('Visible'));
  }
  assert.equal((await board.scene(owner, made.id)).board.revision, 2);
});
