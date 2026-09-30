import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SandboxClient } from '@merv/sandboxes/client';
import { MervError } from '@merv/contracts';

const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;

test('job output uses proved scoped requests and bounded raw streams', async (t) => {
  const tokenEnv = 'MERV_SANDBOX_OUTPUT_CLIENT_TEST';
  const previous = process.env[tokenEnv];
  process.env[tokenEnv] = 'sbxt_test_output';
  const connection = {
    projectId: 'project_output',
    namespace: 'merv-ml',
    subject: 'project_output',
    tokenEnv,
  };
  let mode = 'normal';
  let proofs = 0;
  let reads = 0;
  let redirected = 0;
  let wrongScope = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${process.env[tokenEnv]}`);
    assert.equal(request.headers['x-sandbox-namespace'], connection.namespace);
    assert.equal(request.headers['x-sandbox-subject'], connection.subject);
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/v1/auth/me') {
      proofs++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          role: 'consumer',
          namespace: wrongScope ? 'other' : connection.namespace,
        }),
      );
      return;
    }
    if (url.pathname === '/redirected') {
      redirected++;
      response.end('should never be followed');
      return;
    }
    reads++;
    assert.equal(url.pathname, '/v1/jobs/job_output/output');
    assert.equal(request.headers.accept, 'application/octet-stream');
    assert.deepEqual([...url.searchParams.keys()], ['stream', 'start', 'end', 'max_bytes']);
    assert.equal(
      Number(url.searchParams.get('max_bytes')),
      Number(url.searchParams.get('end')) - Number(url.searchParams.get('start')),
    );
    assert.ok(['stdout', 'stderr'].includes(url.searchParams.get('stream')!));
    if (mode === 'redirect') {
      response.writeHead(302, { location: '/redirected' });
      response.end('private redirect body');
    } else if (mode === 'refused') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'private_detail', message: 'DO_NOT_DISCLOSE' } }),
      );
    } else if (mode === 'mime') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not raw output');
    } else if (mode === 'declared') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '8001',
      });
      response.end(Buffer.alloc(8001));
    } else {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunks =
        mode === 'oversize'
          ? [Buffer.alloc(4000), Buffer.alloc(4001)]
          : mode === 'range'
            ? [Buffer.alloc(5)]
            : mode === 'boundary'
              ? [Buffer.from([0x82, 0xac, 0xff])]
              : [Buffer.from([0xe2]), Buffer.from([0x82, 0xac])];
      response.write(chunks[0]);
      setImmediate(() => {
        for (const chunk of chunks.slice(1)) response.write(chunk);
        response.end();
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = previous;
  });
  const client = new SandboxClient(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    2000,
  );
  assert.equal(await client.output(connection, 'job_output', 'stdout', 0, 3), '€');
  assert.equal(await client.output(connection, 'job_output', 'stderr', 20, 23), '€');
  assert.equal(proofs, 1);
  mode = 'boundary';
  assert.equal(await client.output(connection, 'job_output', 'stdout', 1, 4), '\uFFFD\uFFFD\uFFFD');
  const before = reads;
  assert.equal(await client.output(connection, 'job_output', 'stdout', 2, 2), '');
  for (const id of ['../secret', 'job/output', '', 'x?stream=stderr'])
    await assert.rejects(client.output(connection, id, 'stdout', 0, 1), code('invalid_sandbox_id'));
  for (const [start, end] of [
    [-1, 1],
    [2, 1],
    [0, 8001],
    [0.5, 1],
    [0, Infinity],
    [NaN, 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
  ])
    await assert.rejects(
      client.output(connection, 'job_output', 'stdout', start, end),
      code('invalid_sandbox_output_range'),
    );
  await assert.rejects(
    client.output(connection, 'job_output', 'other' as 'stdout', 0, 1),
    code('invalid_sandbox_output_range'),
  );
  assert.equal(reads, before, 'invalid and empty ranges must not dispatch');
  for (const value of ['oversize', 'declared', 'mime', 'range']) {
    mode = value;
    await assert.rejects(
      client.output(connection, 'job_output', 'stdout', 0, value === 'range' ? 4 : 8000),
      code('sandbox_unavailable'),
    );
  }
  mode = 'redirect';
  await assert.rejects(
    client.output(connection, 'job_output', 'stdout', 0, 8000),
    code('sandbox_redirect_refused'),
  );
  assert.equal(redirected, 0);
  mode = 'refused';
  await assert.rejects(
    client.output(connection, 'job_output', 'stdout', 0, 8000),
    (error: unknown) => {
      assert.ok(error instanceof MervError);
      assert.equal(error.code, 'sandbox_forbidden');
      assert.ok(!error.message.includes('DO_NOT_DISCLOSE'));
      return true;
    },
  );
  const beforeRefusal = reads;
  process.env[tokenEnv] = 'sbxt_rotated_output';
  wrongScope = true;
  await assert.rejects(
    client.output(connection, 'job_output', 'stdout', 0, 1),
    code('sandbox_forbidden'),
  );
  assert.equal(proofs, 2, 'replacement credentials must prove their own namespace');
  assert.equal(reads, beforeRefusal);
});
