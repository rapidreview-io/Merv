import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { canonical, sha256Hex, type Artifacts, type Reviews, type Scope } from '@merv/contracts';
import { Instant } from '@sandboxes/kernel';
import type { SbxMerv } from '@sandboxes/merv-host';
import type { LeasedSessions } from '@merv/sessions';
import { ReadBrokerRuntime } from '@merv/sessions/read-broker-runtime';
import { readBrokerHttp, READ_BROKER_PATH } from '@merv/sessions/read-broker-http';
import { openState } from './fixtures/state.js';
import { twoStepWorkflow } from './fixtures/session-workflow.js';

const owner = { actorId: 'owner', projectId: 'project' };
const policy = {
  projectId: 'project',
  assignmentId: 'task',
  revision: 1,
  source: {
    reviews: [],
    artifacts: [{ artifactId: 'public', sha256: sha256Hex('public policy'), content: true }],
  },
  destination: { reviews: [], artifacts: [] },
};

async function fixture(hooks: { launch?: () => Promise<void>; read?: () => Promise<void> } = {}) {
  const state = await openState();
  const bytes = Buffer.from(canonical(policy));
  const review = {
    id: 'review',
    projectId: 'project',
    status: 'submitted',
    verdict: 'pass',
    artifactIds: ['policy'],
  };
  let active = true,
    lease = true,
    envelope: any,
    launch: any = null,
    starts = 0;
  const sandbox: any = {
    id: 'sbx',
    namespace: 'namespace',
    native_id: 'native',
    provider: 'modal',
    state: 'ready',
    stopped_at: null,
    lease_expires_at: Instant.fromMillis(Date.now() + 600000),
    request: { protected_runtime: true },
  };
  const runtime = new ReadBrokerRuntime(
    state,
    { require: async () => ({ role: 'operator', user: { id: 'owner' } }) } as unknown as Scope,
    {
      readBrokerAuthority: async () => {
        if (!lease) throw Error('stale lease');
        return {
          caller: owner,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          fingerprint: 'lease-1',
        };
      },
    },
    { get: async () => review } as unknown as Reviews,
    {
      bytes: async (_caller: any, id: string) => {
        if (id !== 'policy') await hooks.read?.();
        return {
          artifact: { id, projectId: 'project' },
          bytes: id === 'policy' ? bytes : Buffer.from('public policy'),
        };
      },
    } as unknown as Artifacts,
    {
      runtimes: () => ({
        inspect: async () => ({
          sandbox: { ...sandbox, state: active ? 'ready' : 'stopped' },
          launch,
        }),
        launch: async (_id: any, request: any) => {
          starts++;
          await hooks.launch?.();
          envelope = JSON.parse(request.bootstrap.getSecretValue());
          launch = {
            namespace: 'namespace',
            sandbox_id: 'sbx',
            launch_id: envelope.peer.launchId,
            job_id: envelope.peer.jobId,
            operation_key: request.operation_key,
            release_id: request.release_id,
            state: 'pending',
            delivery_state: 'launched',
            created_at: Instant.fromMillis(Date.now()),
            expires_at: Instant.parseIso(envelope.expiresAt),
          };
          return launch;
        },
      }),
    } as unknown as SbxMerv,
  );
  await runtime.initialize();
  const approve = () =>
    runtime.approve(owner, {
      control: { sessionId: 'session', runnerId: 'runner', hostRef: 'host' },
      deployment: {
        binding: {
          namespace: 'namespace',
          sandboxId: 'sbx',
          role: 'source',
          projectId: 'project',
          sessionId: 'session',
          assignmentId: 'task',
          revision: 1,
        },
        operationKey: 'op',
        releaseId: 'rt1_' + 'a'.repeat(64),
        ttlSeconds: 60,
      },
      policyArtifactId: 'policy',
      policySha256: sha256Hex(bytes),
      reviewId: 'review',
      reviewSha256: sha256Hex(canonical(review)),
    });
  return {
    state,
    runtime,
    approve,
    review,
    sandbox,
    token: () => envelope.token,
    starts: () => starts,
    stop: () => {
      active = false;
    },
    close: () => {
      lease = false;
    },
    swap: () => {
      launch.job_id = 'other';
    },
  };
}

test('persisted approval to protected launch to HTTP adapter; duplicate deployment and wrong methods refuse', async (t) => {
  const f = await fixture(),
    id = await f.approve();
  await f.runtime.provision(id);
  await assert.rejects(f.runtime.provision(id), { code: 'read_broker_provision_denied' });
  assert.equal(f.starts(), 1);
  const server = createServer(readBrokerHttp(f.runtime));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${READ_BROKER_PATH}`;
  const call = (body: any, token = f.token()) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const input = {
    name: 'artifact.read',
    arguments: { artifactId: 'public', offset: 0, length: 8192 },
  };
  const response = await call(input);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse((await response.json()).content[0].text).content, 'public policy');
  assert.equal((await call({ ...input, role: 'destination' })).status, 403);
  assert.equal((await call(input, 'ms_' + 'a'.repeat(43))).status, 403);
  assert.equal(
    (await call({ name: 'artifact.get', arguments: { artifactId: 'private-outcomes' } })).status,
    403,
  );
  f.stop();
  assert.equal((await call(input)).status, 403);
});

test('accepted manifest state and real bound runtime/session are revalidated on every read', async () => {
  for (const failure of ['review', 'job', 'lease'] as const) {
    const f = await fixture();
    await f.runtime.provision(await f.approve());
    if (failure === 'review') f.review.verdict = 'fail';
    if (failure === 'job') f.swap();
    if (failure === 'lease') f.close();
    await assert.rejects(
      f.runtime.read(f.token(), { name: 'artifact.get', arguments: { artifactId: 'public' } }),
      { code: 'read_broker_denied' },
    );
  }
});

test('real Sessions guard binds controlled attachment and frozen lease, and denies moved work', async (t) => {
  const f = await twoStepWorkflow(t, 'readbroker');
  const task = await f.start(),
    offered = await f.offer(task.id);
  const sessions = f.sessions as LeasedSessions;
  const binding = {
    namespace: 'namespace',
    sandboxId: 'sandbox',
    launchId: 'launch',
    jobId: 'job',
    role: 'source' as const,
    projectId: f.owner.projectId,
    sessionId: offered.session.id,
    assignmentId: task.id,
    revision: offered.session.expectedRevision,
    manifestId: 'manifest',
  };
  const control = { sessionId: offered.session.id, ...offered.control };
  const authority = () =>
    f.app.ctx.state.transaction((tx) =>
      sessions.readBrokerAuthority(f.owner, control, binding, tx),
    );
  assert.equal((await authority()).caller.session?.id, offered.session.id);
  await assert.rejects(
    f.app.ctx.state.transaction((tx) =>
      sessions.readBrokerAuthority(f.owner, { ...control, hostRef: 'wrong' }, binding, tx),
    ),
  );
  await f.move(task.id, 'submit');
  await assert.rejects(authority());
});

test('real TLS receiver and duplex FD framing reach the authenticated engine without returning the bearer', async (t) => {
  const f = await fixture();
  await f.runtime.provision(await f.approve());
  const directory = await mkdtemp(join(tmpdir(), 'merv-read-broker-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem'),
    cert = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const server = createTlsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    readBrokerHttp(f.runtime),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}${READ_BROKER_PATH}`;
  const code = `import json,socket,sys,threading,time
from merv_sandboxes.runtimes import read_broker as b
secret=json.load(sys.stdin)
read=b.https_reader(secret['endpoint'],secret['token'])
# Test-only explicit trust store, retaining hostname/certificate verification.
import os,ssl
original_context=ssl.create_default_context
ssl.create_default_context=lambda:original_context(cafile=os.environ['SSL_CERT_FILE'])
b.wait_ready(secret['endpoint'],secret['token'],time.time()+20)
root,role=socket.socketpair()
thread=threading.Thread(target=b.serve,args=(root,read,time.time()+20));thread.start()
b.send(role,{'name':'artifact.read','arguments':{'artifactId':'public','offset':0,'length':8192}})
reply=json.loads(b.receive(role,b.MAX_RESPONSE))
role.close();thread.join(2)
assert not thread.is_alive()
print(json.dumps(reply))
`;
  const child = spawn('python3', ['-c', code], {
    env: {
      PATH: process.env.PATH!,
      SSL_CERT_FILE: cert,
      PYTHONPATH: resolve('vendor/merv-sandboxes/typescript/packages/runtimes/assets/python'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdin.end(JSON.stringify({ endpoint, token: f.token() }));
  const [exit] = await once(child, 'exit');
  assert.equal(exit, 0, stderr);
  assert.equal(stdout.includes(f.token()), false);
  assert.equal(stderr.includes(f.token()), false);
  assert.equal(JSON.parse(JSON.parse(stdout).content[0].text).content, 'public policy');
});

test('a concurrent duplicate never mutates the successful claimant or its authority', async () => {
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    held = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const f = await fixture({
      launch: async () => {
        enter();
        await held;
      },
    }),
    id = await f.approve();
  const first = f.runtime.provision(id);
  await entered;
  await assert.rejects(f.runtime.provision(id), { code: 'read_broker_provision_denied' });
  assert.equal(
    (await f.state.read((sql) =>
      sql.get<{ state: string }>(
        'SELECT state FROM session_read_broker_deployments WHERE id=?',
        id,
      ),
    ))!.state,
    'claimed',
  );
  resume();
  await first;
  assert.equal(f.starts(), 1);
  await f.runtime.read(f.token(), { name: 'artifact.get', arguments: { artifactId: 'public' } });
});

test('operator revocation and runtime stop during suspended public reads suppress the reply', async () => {
  for (const mode of ['revoke', 'stop'] as const) {
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      held = new Promise<void>((resolve) => {
        resume = resolve;
      });
    const f = await fixture({
        read: async () => {
          enter();
          await held;
        },
      }),
      id = await f.approve();
    await f.runtime.provision(id);
    const reading = f.runtime.read(f.token(), {
      name: 'artifact.get',
      arguments: { artifactId: 'public' },
    });
    await entered;
    if (mode === 'revoke') await f.runtime.revoke(owner, id);
    else f.stop();
    resume();
    await assert.rejects(reading, { code: 'read_broker_denied' });
    await assert.rejects(f.runtime.ready(f.token()), { code: 'read_broker_denied' });
  }
});
