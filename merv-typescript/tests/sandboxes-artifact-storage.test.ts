import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxArtifactStorage } from '../packages/sandboxes/src/artifact-storage.js';

test('artifact object requests use the ML project subject and surface its storage cap', async (t) => {
  const original = globalThis.fetch;
  const tokenEnv = 'MERV_ARTIFACT_STORAGE_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  const seen: { path: string; subject: string | null; body?: any }[] = [];
  let cap = false;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const subject = new Headers(init?.headers).get('x-sandbox-subject');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    seen.push({ path, subject, body });
    const json = (value: object, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (path === '/v1/storage/objects' && cap)
      return json(
        {
          error: {
            code: 'capacity_unavailable',
            message: 'member storage quota would be exceeded',
            details: { reason: 'storage_cap_exceeded' },
          },
        },
        503,
      );
    if (path === '/v1/storage/objects')
      return json(
        {
          object: { id: 'obj_one' },
          part_size: 5,
          part_count: 1,
          completed_parts: [],
          next_part: null,
          parts: [
            { part_number: 1, size_bytes: 5, url: 'https://bucket.example/part', headers: {} },
          ],
        },
        201,
      );
    if (path.endsWith('/upload'))
      return json({
        part_size: 5,
        part_count: 1,
        completed_parts: [1],
        next_part: null,
        parts: [],
      });
    if (path.endsWith('/complete'))
      return json({ id: 'obj_one', size_bytes: 5, sha256: 'a'.repeat(64), state: 'available' });
    if (path.endsWith('/download-short')) return json({ url: 'https://bucket.example/file' });
    throw new Error(`Unexpected ${path}`);
  };
  t.after(() => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
  });
  const storage = new SandboxArtifactStorage('https://sandbox.example', 1000, {
    namespace: 'merv-ml',
    tokenEnv,
    storageOrigins: ['https://bucket.example'],
  });
  const input = { title: 'Rows', size: 5, sha256: 'a'.repeat(64), mediaType: 'text/csv' };
  const begun = await storage.begin('project_one', 'aup_one', input);
  assert.equal(begun.objectId, 'obj_one');
  assert.equal(begun.plan.parts[0]?.url, 'https://bucket.example/part');
  // The media type stays artifact metadata: the stored object is opaque bytes.
  assert.deepEqual(seen.find((entry) => entry.path === '/v1/storage/objects')?.body, {
    name: 'artifacts/aup_one',
    idempotency_key: 'aup_one',
    sha256: input.sha256,
    size_bytes: 5,
    content_type: 'application/octet-stream',
    retain_until_deleted: true,
  });
  assert.deepEqual((await storage.resume('project_one', 'obj_one', 1)).completedParts, [1]);
  assert.equal((await storage.complete('project_one', 'obj_one')).state, 'available');
  assert.equal(
    (await storage.download('project_one', 'obj_one')).url,
    'https://bucket.example/file',
  );
  assert.ok(seen.every((entry) => entry.subject === 'project_one'));
  cap = true;
  await assert.rejects(storage.begin('project_two', 'aup_two', input), {
    code: 'sandbox_storage_cap_exceeded',
  });
});

test('object reads stay on the signed origin, stop one byte past the bound and speak the blobs vocabulary', async (t) => {
  const tokenEnv = 'MERV_ARTIFACT_READ_TEST_GRANT';
  process.env[tokenEnv] = 'sbxt_test_consumer_grant';
  const hits: string[] = [];
  let closed = false;
  const server = createServer((request, response) => {
    hits.push(request.url!);
    if (request.url === '/ten') return response.end('ten bytes!');
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/ten' });
      return response.end();
    }
    if (request.url === '/missing' || request.url === '/broken') {
      response.statusCode = request.url === '/missing' ? 404 : 500;
      return response.end();
    }
    if (request.url === '/endless') {
      // Eleven bytes, then a body that never ends: only a reader that stops can return.
      response.on('close', () => (closed = true));
      response.write('eleven byte');
    }
    // '/silent' never answers.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const original = globalThis.fetch;
  let link: unknown = `${origin}/ten`;
  let expires: string | undefined;
  let refusal: number | undefined;
  let completed: object = {};
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    // Everything off the control plane is a real request: the adapter's own fetch.
    if (url.origin !== 'https://sandbox.example') return await original(input, init);
    const json = (value: object, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/v1/auth/me') return json({ role: 'consumer', namespace: 'merv-ml' });
    if (url.pathname.endsWith('/download-short'))
      return refusal
        ? json({}, refusal)
        : json({ url: link, ...(expires ? { expires_at: expires } : {}) });
    if (url.pathname.endsWith('/complete')) return json(completed);
    throw new Error(`Unexpected ${url.pathname}`);
  };
  t.after(async () => {
    globalThis.fetch = original;
    delete process.env[tokenEnv];
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const storage = new SandboxArtifactStorage('https://sandbox.example', 200, {
    namespace: 'merv-ml',
    tokenEnv,
    storageOrigins: [origin],
  });

  // A loopback http storage origin is a signed origin like any https one.
  assert.equal((await storage.read('project_one', 'obj_one', 10)).toString(), 'ten bytes!');
  const soon = Date.parse((await storage.download('project_one', 'obj_one')).expiresAt);
  assert.ok(soon > Date.now() && soon <= Date.now() + 50_000);
  expires = '2030-01-01T00:00:00Z';
  assert.equal(
    (await storage.download('project_one', 'obj_one')).expiresAt,
    '2030-01-01T00:00:00.000Z',
  );

  link = `${origin}/endless`;
  assert.equal((await storage.read('project_one', 'obj_one', 10)).toString(), 'eleven byte');
  for (let wait = 0; !closed && wait < 100; wait++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true, 'the unfinished body is cancelled');

  link = `${origin}/redirect`;
  hits.length = 0;
  await assert.rejects(storage.read('project_one', 'obj_one', 10), {
    code: 'blob_unavailable',
    status: 503,
  });
  assert.deepEqual(hits, ['/redirect']);
  link = `${origin}/missing`;
  await assert.rejects(storage.read('project_one', 'obj_one', 10), {
    code: 'blob_not_found',
    status: 404,
  });
  link = `${origin}/broken`;
  await assert.rejects(storage.read('project_one', 'obj_one', 10), {
    code: 'blob_unavailable',
    status: 503,
  });
  link = `${origin}/silent`;
  const started = Date.now();
  await assert.rejects(storage.read('project_one', 'obj_one', 10), {
    code: 'blob_unavailable',
    status: 503,
  });
  assert.ok(Date.now() - started < 5_000);
  link = 'https://elsewhere.example/object';
  await assert.rejects(storage.read('project_one', 'obj_one', 10), {
    code: 'sandbox_origin_refused',
    status: 502,
  });

  for (const [status, expected] of [
    [404, { code: 'blob_not_found', status: 404 }],
    [503, { code: 'blob_unavailable', status: 503 }],
    [403, { code: 'sandbox_forbidden', status: 403 }],
  ] as const) {
    refusal = status;
    await assert.rejects(storage.download('project_one', 'obj_one'), expected);
    await assert.rejects(storage.read('project_one', 'obj_one', 10), expected);
  }

  completed = { id: 'obj_one', size_bytes: '5', sha256: 'a'.repeat(64), state: 'available' };
  await assert.rejects(storage.complete('project_one', 'obj_one'), {
    code: 'sandbox_unavailable',
    status: 502,
  });
  completed = { id: 'obj_one', size_bytes: 5, sha256: 'a'.repeat(64), state: 'available' };
  assert.deepEqual(await storage.complete('project_one', 'obj_one'), {
    objectId: 'obj_one',
    size: 5,
    sha256: 'a'.repeat(64),
    state: 'available',
  });
});
