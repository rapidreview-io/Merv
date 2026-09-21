import { createService, type Caller, type CodeProjectStatus } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { ApiServer } from '../packages/api/src/http.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import type { CodeApiProvider } from '../packages/api/src/types.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { importRepository } from '../src/code-import.js';
import { boundProject } from './fixtures/code-binding.js';
import { git, gitSource } from './fixtures/code-store.js';

const PART = 4 * 1024 * 1024;

async function fixture(t: TestContext) {
  const state = new SqliteState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Code transfers', actorName: 'Controller' });
  const caller = await scope.caller({ kind: 'actor', actor: await scope.authenticate(boot.token) });
  const tools = new ToolRegistry(scope);
  const api = new ApiServer(scope, tools, { port: 0 });
  const url = await api.start();
  t.after(async () => {
    await api.stop();
    await tools.close();
    await state.close();
  });
  const calls: unknown[][] = [];
  const v2: NonNullable<CodeApiProvider['v2']> = {
    call: async (caller, route, body) => (
      calls.push(['call', caller.projectId, route, body]),
      { ok: route }
    ),
    putPart: async (caller, operationId, offset, bytes) => (
      calls.push(['part', caller.projectId, operationId, offset, bytes.length]),
      { received: offset + bytes.length }
    ),
    readPart: async (caller, exportId, input) => (
      calls.push(['read', caller.projectId, exportId, input]),
      Buffer.from([0, 1, 2, 255])
    ),
  };
  const provider: CodeApiProvider = {
    nextCommand: async () => null,
    completeCommand: async () => assert.fail('unused'),
    v2,
  };
  const send = async (
    path: string,
    options: { method?: string; body?: BodyInit; type?: string; token?: string } = {},
  ) => {
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? 'POST',
      headers: {
        authorization: `Bearer ${options.token ?? boot.token}`,
        'content-type': options.type ?? 'application/json',
      },
      body: options.body ?? '{}',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.startsWith('application/json');
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      allow: response.headers.get('allow'),
      body: json ? JSON.parse(bytes.toString('utf8')) : bytes,
    };
  };
  return { scope, api, url, boot, caller, calls, provider, v2, send };
}

test('the second workspace protocol is forwarded unread, under the bounds of its own routes', async (t) => {
  const f = await fixture(t);
  // Without Code there is nothing to forward to.
  assert.deepEqual(
    [
      (await f.send('/code/v2/workspace')).status,
      (await f.send('/code/v2/workspace')).body.error.code,
    ],
    [503, 'code_unavailable'],
  );
  // Code that keeps no repositories offers the rest of its controls and not this protocol.
  const withdraw = f.api.registerCode({ ...f.provider, v2: undefined });
  assert.deepEqual(
    [
      (await f.send('/code/v2/workspace')).status,
      (await f.send('/code/v2/workspace')).body.error.code,
    ],
    [503, 'code_store_unavailable'],
  );
  withdraw();
  f.api.registerCode(f.provider);

  const begun = await f.send('/code/v2/uploads', { body: JSON.stringify({ any: ['shape', 1] }) });
  assert.deepEqual([begun.status, begun.body], [200, { ok: 'uploads' }]);
  assert.equal((await f.send('/code/v2/uploads/cop_1/complete')).body.ok, 'uploads/cop_1/complete');
  const part = await f.send('/code/v2/uploads/cop_1/parts/8388608', {
    method: 'PUT',
    type: 'application/octet-stream',
    body: Buffer.alloc(PART, 7),
  });
  assert.deepEqual([part.status, part.body], [200, { received: 8388608 + PART }]);
  const read = await f.send('/code/v2/downloads/exp_1/read', { body: '{"offset":0,"length":4}' });
  assert.deepEqual(
    [read.status, read.type, [...(read.body as Buffer)]],
    [200, 'application/octet-stream', [0, 1, 2, 255]],
  );
  assert.deepEqual(f.calls, [
    ['call', f.caller.projectId, 'uploads', { any: ['shape', 1] }],
    ['call', f.caller.projectId, 'uploads/cop_1/complete', {}],
    ['part', f.caller.projectId, 'cop_1', 8388608, PART],
    ['read', f.caller.projectId, 'exp_1', { offset: 0, length: 4 }],
  ]);
  f.calls.length = 0;

  // A part is opaque bytes of at most the part size, on PUT; everything else is JSON on POST.
  const refusals: [
    path: string,
    options: Parameters<typeof f.send>[1],
    status: number,
    code: string,
  ][] = [
    [
      '/code/v2/uploads/cop_1/parts/0',
      { method: 'PUT', type: 'application/octet-stream', body: Buffer.alloc(PART + 1) },
      413,
      'body_too_large',
    ],
    [
      '/code/v2/uploads/cop_1/parts/0',
      { method: 'PUT', body: '{}' },
      415,
      'unsupported_media_type',
    ],
    [
      '/code/v2/uploads/cop_1/parts/0',
      { type: 'application/octet-stream', body: Buffer.alloc(1) },
      405,
      'method_not_allowed',
    ],
    [
      '/code/v2/uploads',
      { type: 'application/octet-stream', body: Buffer.alloc(1) },
      415,
      'unsupported_media_type',
    ],
    ['/code/v2/uploads', { method: 'PUT' }, 405, 'method_not_allowed'],
    [
      '/code/v2/uploads',
      { body: JSON.stringify({ pad: 'x'.repeat(70_000) }) },
      413,
      'body_too_large',
    ],
    ['/code/v2/uploads?force=1', {}, 400, 'invalid_input'],
    [
      '/code/v2/uploads/cop_1/parts/0?offset=9',
      { method: 'PUT', type: 'application/octet-stream', body: Buffer.alloc(1) },
      400,
      'invalid_input',
    ],
    // A worker's credential reaches its tools and nothing else, whatever it names.
    ['/code/v2/uploads', { token: `ms_${'w'.repeat(43)}` }, 403, 'session_transport_forbidden'],
    [
      '/code/v2/uploads/cop_1/parts/0',
      {
        method: 'PUT',
        type: 'application/octet-stream',
        body: Buffer.alloc(1),
        token: `ms_${'w'.repeat(43)}`,
      },
      403,
      'session_transport_forbidden',
    ],
    ['/code/v2/uploads', { token: 'not-a-credential' }, 401, 'unauthorized'],
  ];
  for (const [path, options, status, code] of refusals) {
    const refused = await f.send(path, options);
    assert.deepEqual([refused.status, refused.body.error?.code], [status, code], path);
  }
  // Offsets that are not plain non-negative integers are not part routes at all.
  for (const offset of ['-1', '01', '1.5', '1e3', ''])
    assert.notEqual(
      (
        await f.send(`/code/v2/uploads/cop_1/parts/${offset}`, {
          method: 'PUT',
          type: 'application/octet-stream',
          body: Buffer.alloc(1),
        })
      ).status,
      200,
      offset,
    );
  assert.deepEqual(f.calls, []);
});

test(
  'a part is forwarded only while the credential that sent it still holds, however long its bytes took',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    f.api.registerCode(f.provider);
    const admin = await f.scope.issueActor(f.caller, { name: 'Second operator', role: 'operator' });
    const adminCaller = await f.scope.caller({
      kind: 'actor',
      actor: await f.scope.authenticate(admin.token),
    });
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => (admitted = resolve));
    const original = f.scope.require.bind(f.scope);
    f.scope.require = async (...args) => {
      const result = await original(...args);
      admitted();
      return result;
    };
    const response = new Promise<{ status: number; body: { error: { code: string } } }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${f.url}/code/v2/uploads/cop_1/parts/0`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${f.boot.token}`,
              'content-type': 'application/octet-stream',
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk) => chunks.push(chunk));
            incoming.on('end', () =>
              resolve({
                status: incoming.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              }),
            );
          },
        );
        request.on('error', reject);
        request.write(Buffer.alloc(10));
        void started.then(async () => {
          await f.scope.revokeCredential(adminCaller, f.caller.credentialId!);
          request.end(Buffer.alloc(10));
        });
      },
    );
    const result = await response;
    assert.deepEqual([result.status, result.body.error.code], [403, 'forbidden']);
    assert.deepEqual(f.calls, []);
  },
);

test('code-import brings a local branch into a served project, in steps, as its administrator only', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-import-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.map((entry) =>
    entry.id === 'api'
      ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
      : entry.id === 'ui'
        ? { ...entry, config: { assets: join(directory, 'unused-assets') } }
        : entry,
  );
  const app = await createApp({ directory: join(directory, 'data'), config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Imported', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const source = gitSource(t);
  const one = source.commit({
    'README.md': 'one\n',
    // Incompressible and larger than one part, so the first transfer takes two.
    'big.bin': randomBytes(PART + 100_000),
  });
  source.git('tag', 'v1');
  const two = source.commit({ 'README.md': 'two\n' });
  const before =
    git(source.repository, ['for-each-ref']) + git(source.repository, ['status', '--porcelain']);
  const url = app.ctx.api.url!;

  await assert.rejects(
    importRepository({ url, repository: source.repository, ref: 'v1', token: boot.token }),
    { code: 'code_import_refused', message: /code_project_unbound/ },
  );
  await boundProject(app.ctx.state, owner.projectId, two, 'operator-repository');
  const producer = await app.ctx.scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  await assert.rejects(
    importRepository({ url, repository: source.repository, ref: 'v1', token: producer.token }),
    { code: 'code_import_refused' },
  );
  await assert.rejects(
    importRepository({ url, repository: source.repository, ref: one, token: boot.token }),
    { code: 'code_import_ref' },
  );
  await assert.rejects(
    importRepository({
      url: `${url}?x=1`,
      repository: source.repository,
      ref: 'v1',
      token: boot.token,
    }),
    { code: 'code_import_url' },
  );

  // The older tag first, then the branch: the second transfer carries only what is new.
  const first = await importRepository({
    url,
    repository: source.repository,
    ref: 'v1',
    token: boot.token,
  });
  assert.deepEqual(
    [first.status, first.head, first.received === first.bytes],
    ['completed', one, true],
  );
  assert.ok(first.bytes! > PART);
  let status = (await app.ctx.code.status(owner)) as CodeProjectStatus;
  assert.deepEqual([status.project!.durability, status.project!.main.stored], ['code', false]);
  const second = await importRepository({
    url,
    repository: source.repository,
    ref: 'main',
    token: boot.token,
  });
  assert.deepEqual([second.status, second.head], ['completed', two]);
  assert.ok(second.bytes! < 5_000, 'the branch is sent as a continuation of the tag');
  status = (await app.ctx.code.status(owner)) as CodeProjectStatus;
  assert.deepEqual(
    [status.project!.main.stored, status.store!.tips.sort(), status.operations],
    [true, [one, two].sort(), []],
  );
  await assert.rejects(
    importRepository({ url, repository: source.repository, ref: 'main', token: boot.token }),
    { code: 'code_import_current' },
  );
  // The operator's repository was only read.
  assert.equal(
    git(source.repository, ['for-each-ref']) + git(source.repository, ['status', '--porcelain']),
    before,
  );
});

test('a server configured with no repository root keeps none, and everything else of Code works', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-rootless-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins
    .filter(({ id }) => !['api', 'identity', 'ui'].includes(id) && !/-(api|ui)$/.test(id))
    .map((entry) => (entry.id === 'code' ? { id: entry.id, name: entry.name } : entry));
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Rootless', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await boundProject(app.ctx.state, owner.projectId, 'a'.repeat(40));
  const status = await app.ctx.code.status(owner);
  assert.deepEqual(
    [status.store, status.operations, status.project!.durability],
    [null, [], 'legacy-local'],
  );
  await assert.rejects(
    app.ctx.code.importRepository(owner, {
      source: 'github',
      ref: 'refs/heads/main',
      requestId: 'r',
    }),
    { code: 'code_store_unavailable', status: 503 },
  );
  assert.equal(existsSync(join(directory, 'code')), false);
  assert.equal(
    (
      await app.ctx.tasks.create(owner, {
        title: 'T',
        goal: 'G',
        checks: ['C'],
        workspace: 'git',
        requestId: 't',
      })
    ).workspace,
    'git',
  );
});
