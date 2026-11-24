import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  accountRequest,
  call,
  captureProjectOwner,
  currentToken,
  onAccessLost,
  projectSelection,
  scopeVersion,
  setProject,
  setToken,
  setTokenRefresher,
} from '../packages/ui/web/api.js';
import { deferred } from './fixtures/deferred.js';
function setup(t: TestContext) {
  setToken('fixture');
  setProject('a');
  setTokenRefresher(undefined);
  t.after(() => {
    setTokenRefresher(undefined);
    setToken(null);
  });
  const owner = captureProjectOwner('a', scopeVersion());
  assert.ok(owner);
  return owner;
}
const refusal = (code = 'unauthorized', status = 401) =>
  Response.json({ error: { code, message: code } }, { status });
test('writes stay with their rendered project and refuse an invalid owner before dispatch', async (t) => {
  const owner = setup(t),
    seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('x-merv-project-id')!);
    return Response.json({ result: {} });
  });
  setProject(null);
  await accountRequest('/board-images/image', { method: 'PUT', raw: new Uint8Array([1]), owner });
  assert.equal(projectSelection(), null);
  setProject('b');
  await call('board.save', { id: 'old-board' }, owner);
  assert.equal(projectSelection(), 'b');
  assert.deepEqual(seen, ['a', 'a']);
  setProject('a');
  assert.equal(captureProjectOwner('b', scopeVersion()), null);
  assert.equal(captureProjectOwner('a', scopeVersion() - 1), null);
  await assert.rejects(call('board.save', {}, null), { code: 'owner_changed' });
  setToken('replacement');
  await assert.rejects(call('board.save', {}, owner), { code: 'owner_changed' });
  assert.deepEqual(seen, ['a', 'a'], 'invalid owners send no writes');
});
test('replacing the account fences requests at every asynchronous boundary', async (t) => {
  const errors: string[] = [];
  t.after(onAccessLost((e) => errors.push(e.code)));
  for (const phase of ['fetch', 'json', 'blob', 'refresh']) {
    const owner = setup(t),
      gate = deferred<void>(),
      started = deferred<void>();
    let calls = 0;
    setTokenRefresher(async () => {
      started.resolve();
      await gate.promise;
      return 'stale-refresh';
    });
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (phase === 'fetch') {
        started.resolve();
        await gate.promise;
      }
      if (phase === 'refresh') return refusal();
      const response = Response.json({ result: {} });
      if (phase === 'json')
        response.json = async () => {
          started.resolve();
          await gate.promise;
          return { result: {} };
        };
      if (phase === 'blob')
        response.blob = async () => {
          started.resolve();
          await gate.promise;
          return new Blob();
        };
      return response;
    });
    const pending = accountRequest('/write', { owner, bytes: phase === 'blob' });
    await started.promise;
    setToken('replacement');
    setProject('b');
    gate.resolve();
    await assert.rejects(pending, { code: 'owner_changed' });
    assert.equal(calls, 1);
    assert.equal(currentToken(), 'replacement');
    assert.deepEqual(errors, [], phase);
    fetch.mock.restore();
  }
});
test('late access refusals notify only the current project owner', async (t) => {
  const errors: string[] = [];
  t.after(onAccessLost((e) => errors.push(e.code)));
  let code = 'unauthorized';
  t.mock.method(globalThis, 'fetch', async () =>
    refusal(code, code === 'unauthorized' ? 401 : 403),
  );
  for (code of ['unauthorized', 'membership_required']) {
    const owner = setup(t);
    errors.length = 0;
    setProject('b');
    await assert.rejects(call('board.save', {}, owner), { code });
    setProject('a');
    await assert.rejects(call('board.save', {}, owner), { code });
    assert.deepEqual(errors, []);
    await assert.rejects(call('board.save', {}, captureProjectOwner('a', scopeVersion())), {
      code,
    });
    assert.deepEqual(errors, [code]);
  }
});
