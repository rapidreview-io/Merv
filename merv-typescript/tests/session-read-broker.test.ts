import { Instant } from '@sandboxes/kernel';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, sha256Hex } from '@merv/contracts';
import {
  SessionReadBroker,
  type ReadBrokerBinding,
  type ReadBrokerPeer,
  type ReadBrokerPolicy,
} from '@merv/sessions/read-broker';
import { provisionReadBroker } from '@merv/sessions/read-broker-provision';
import { openState } from './fixtures/state.js';

async function fixture() {
  const state = await openState();
  let now = Date.parse('2026-10-26T12:00:00Z'),
    live = true,
    revision = 1;
  const review = {
    id: 'review_public',
    projectId: 'project_one',
    status: 'accepted',
    snapshotHash: 'a'.repeat(64),
  };
  const bytes = new TextEncoder().encode('A😀public authority');
  const binding: ReadBrokerBinding = {
    namespace: 'namespace_one',
    sandboxId: 'sbx_one',
    launchId: 'launch_one',
    jobId: 'job_one',
    role: 'source',
    projectId: 'project_one',
    sessionId: 'session_one',
    assignmentId: 'task_one',
    revision: 1,
    manifestId: 'manifest_one',
  };
  const peer = (b = binding): ReadBrokerPeer => ({
    namespace: b.namespace,
    sandboxId: b.sandboxId,
    launchId: b.launchId,
    jobId: b.jobId,
    role: b.role,
  });
  const policy: ReadBrokerPolicy = {
    projectId: binding.projectId,
    assignmentId: binding.assignmentId,
    revision: 1,
    source: {
      reviews: [{ reviewId: review.id, sha256: sha256Hex(canonical(review)) }],
      artifacts: [{ artifactId: 'art_public', sha256: sha256Hex(bytes), content: true }],
    },
    destination: {
      reviews: [{ reviewId: review.id, sha256: sha256Hex(canonical(review)) }],
      artifacts: [],
    },
  };
  let beforeRead: (() => void | Promise<void>) | undefined,
    reads = 0;
  const broker = new SessionReadBroker(
    state,
    {
      runtime: async () => {},
      policy: async (id) => {
        if (id !== binding.manifestId) throw Error('private policy failure');
        return policy;
      },
      authorize: async (b) => {
        if (
          !live ||
          b.sessionId !== binding.sessionId ||
          b.assignmentId !== binding.assignmentId ||
          b.projectId !== binding.projectId ||
          b.revision !== revision
        )
          throw Error('private parent credential');
        return {
          caller: { actorId: 'actor_one', projectId: binding.projectId },
          fingerprint: `execution-${revision}`,
          expiresAt: new Date(Date.parse('2026-10-26T12:10:00Z')).toISOString(),
        };
      },
      review: async () => {
        reads++;
        await beforeRead?.();
        return review;
      },
      artifact: async (_caller, id) => {
        reads++;
        await beforeRead?.();
        return { id, projectId: binding.projectId, bytes };
      },
    },
    () => now,
  );
  await broker.initialize();
  return {
    state,
    broker,
    binding,
    peer,
    policy,
    bytes,
    review,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
    close: () => {
      live = false;
    },
    replace: () => {
      revision++;
    },
    duringRead: (fn: () => void | Promise<void>) => {
      beforeRead = fn;
    },
  };
}
const refusal = { code: 'read_broker_denied', message: 'Public authority read was refused' };
const getReview = { name: 'review.get', arguments: { reviewId: 'review_public' } };

test('exact adapter calls use role-specific immutable public pins and UTF16 ranges', async () => {
  const f = await fixture(),
    issued = await f.broker.issue(f.binding, 60);
  const call = (name: string, args: unknown) =>
    f.broker.call(issued.token, f.peer(), { name, arguments: args });
  assert.deepEqual(
    JSON.parse((await call('review.get', { reviewId: 'review_public' })).content[0]!.text),
    f.review,
  );
  assert.equal(
    JSON.parse((await call('artifact.get', { artifactId: 'art_public' })).content[0]!.text).hash,
    sha256Hex(f.bytes),
  );
  const first = JSON.parse(
    (await call('artifact.read', { artifactId: 'art_public', offset: 0, length: 2 })).content[0]!
      .text,
  );
  assert.equal(first.content, 'A');
  const next = JSON.parse(
    (await call('artifact.read', { artifactId: 'art_public', offset: 1, length: 8192 })).content[0]!
      .text,
  );
  assert.equal(first.content + next.content, new TextDecoder().decode(f.bytes));
  await assert.rejects(
    call('artifact.read', { artifactId: 'art_public', offset: 2, length: 8192 }),
    refusal,
  );
  await assert.rejects(
    call('artifact.read', { artifactId: 'art_public', offset: 0, length: 8193 }),
    refusal,
  );
});

test('tokens remain hash-only; unknown tools, outcomes and cross-role/job/project peers never reach readers', async () => {
  const f = await fixture(),
    issued = await f.broker.issue(f.binding, 60);
  const stored = await f.state.read(async (sql) => ({
    grants: await sql.all('SELECT * FROM session_read_broker_grants'),
    credentials: await sql.all('SELECT * FROM identity_credentials'),
  }));
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  for (const request of [
    { name: 'task.write', arguments: {} },
    { name: 'artifact.read', arguments: { artifactId: 'art_outcomes', offset: 0, length: 100 } },
    { ...getReview, projectId: 'project_other' },
    { name: 'artifact.get', arguments: { artifactId: 'art_public', role: 'source' } },
  ])
    await assert.rejects(f.broker.call(issued.token, f.peer(), request), refusal);
  for (const peer of [
    { ...f.peer(), role: 'destination' as const },
    { ...f.peer(), jobId: 'job_other' },
    { ...f.peer(), namespace: 'namespace_other' },
  ])
    await assert.rejects(f.broker.call(issued.token, peer, getReview), refusal);
  assert.equal(f.reads(), 0);
  const destination = { ...f.binding, role: 'destination' as const, jobId: 'job_destination' };
  const dest = await f.broker.issue(destination, 60);
  await assert.rejects(
    f.broker.call(dest.token, f.peer(destination), {
      name: 'artifact.get',
      arguments: { artifactId: 'art_public' },
    }),
    refusal,
  );
  await assert.rejects(f.broker.issue({ ...f.binding, projectId: 'project_other' }, 60), refusal);
});

test('replays are live reads; expiry, explicit revoke, parent close and replacement deny later reads', async () => {
  for (const mode of ['expiry', 'revoke', 'close', 'replace'] as const) {
    const f = await fixture(),
      issued = await f.broker.issue(f.binding, 60);
    await f.broker.call(issued.token, f.peer(), getReview);
    await f.broker.call(issued.token, f.peer(), getReview);
    assert.equal(f.reads(), 2);
    if (mode === 'expiry') f.advance(60_000);
    if (mode === 'revoke') await f.broker.revoke(issued.grantId);
    if (mode === 'close') f.close();
    if (mode === 'replace') f.replace();
    await assert.rejects(f.broker.call(issued.token, f.peer(), getReview), refusal);
    assert.equal(f.reads(), 2);
  }
});

test('revocation during open-world read suppresses response and no upstream secret is exposed', async () => {
  const f = await fixture(),
    issued = await f.broker.issue(f.binding, 60);
  f.duringRead(f.close);
  await assert.rejects(f.broker.call(issued.token, f.peer(), getReview), refusal);
  await assert.rejects(f.broker.issue(f.binding, 60), refusal);
});

test('changed manifest or pinned public record denies rather than silently accepting new authority', async () => {
  const f = await fixture(),
    issued = await f.broker.issue(f.binding, 60);
  f.review.status = 'rejected';
  await assert.rejects(f.broker.call(issued.token, f.peer(), getReview), refusal);
  f.policy.destination.artifacts.push({
    artifactId: 'art_outcomes',
    sha256: 'c'.repeat(64),
    content: true,
  });
  await assert.rejects(f.broker.call(issued.token, f.peer(), getReview), refusal);
  assert.equal(f.reads(), 1);
});

test('database revocation during a suspended read suppresses response; ambient snapshots and transactions refuse', async () => {
  const f = await fixture(),
    issued = await f.broker.issue(f.binding, 60);
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const suspended = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.duringRead(async () => {
    entered();
    await suspended;
  });
  const result = f.broker.call(issued.token, f.peer(), getReview);
  await reading;
  await f.broker.revoke(issued.grantId);
  resume();
  await assert.rejects(result, refusal);
  const fresh = await f.broker.issue(f.binding, 60);
  f.duringRead(() => {});
  const before = f.reads();
  await f.state.snapshot(async () => {
    await assert.rejects(f.broker.call(fresh.token, f.peer(), getReview), refusal);
  });
  await f.state.transaction(async () => {
    await assert.rejects(f.broker.call(fresh.token, f.peer(), getReview), refusal);
  });
  assert.equal(f.reads(), before);
});

test('trusted provisioning sends only a redacted job-bound bootstrap and returns no bearer', async () => {
  const f = await fixture();
  let envelope: any,
    recorded = false;
  const result = await provisionReadBroker(
    f.broker,
    {
      failed: async () => {},
      claim: async () => ({
        binding: f.binding,
        operationKey: 'approved-role-job',
        releaseId: 'pinned-release',
        ttlSeconds: 60,
      }),
      launch: async (sandboxId, request) => {
        assert.equal(JSON.stringify(request).includes('mbr_'), false);
        envelope = JSON.parse(request.bootstrap.getSecretValue());
        assert.equal(envelope.peer.sandboxId, sandboxId);
        assert.equal(envelope.peer.role, 'source');
        assert.match(envelope.peer.jobId, /^rtj_/);
        return {
          namespace: f.binding.namespace,
          privateUnexpectedField: envelope.token,
          sandbox_id: sandboxId,
          launch_id: envelope.peer.launchId,
          job_id: envelope.peer.jobId,
          operation_key: request.operation_key,
          release_id: request.release_id,
          state: 'pending',
          delivery_state: 'launched',
          created_at: Instant.parseIso('2026-10-26T12:00:00Z'),
          expires_at: Instant.parseIso(envelope.expiresAt),
        };
      },
      record: async (_id, _grant, receipt) => {
        assert.equal(JSON.stringify(receipt).includes('mbr_'), false);
        recorded = true;
      },
    },
    'approved-deployment',
  );
  assert.equal(recorded, true);
  assert.equal(JSON.stringify(result).includes(envelope.token), false);
  assert.deepEqual(
    JSON.parse((await f.broker.call(envelope.token, envelope.peer, getReview)).content[0]!.text),
    f.review,
  );
});

test('uncertain delivery, swapped runtime identity and receipt failure revoke possibly delivered credentials', async () => {
  for (const mode of ['uncertain', 'identity', 'record'] as const) {
    const f = await fixture();
    let envelope: any;
    await assert.rejects(
      provisionReadBroker(
        f.broker,
        {
          failed: async () => {},
          claim: async () => ({
            binding: f.binding,
            operationKey: 'approved-role-job',
            releaseId: 'pinned-release',
            ttlSeconds: 60,
          }),
          launch: async (sandboxId, request) => {
            envelope = JSON.parse(request.bootstrap.getSecretValue());
            return {
              namespace: f.binding.namespace,
              sandbox_id: mode === 'identity' ? 'other' : sandboxId,
              launch_id: envelope.peer.launchId,
              job_id: envelope.peer.jobId,
              operation_key: request.operation_key,
              release_id: request.release_id,
              state: 'pending',
              delivery_state: mode === 'uncertain' ? 'uncertain' : 'launched',
              created_at: Instant.parseIso('2026-10-26T12:00:00Z'),
              expires_at: Instant.parseIso(envelope.expiresAt),
            };
          },
          record: async () => {
            if (mode === 'record') throw Error('private failure');
          },
        },
        'approved-deployment',
      ),
      { code: 'read_broker_provision_denied' },
    );
    await assert.rejects(f.broker.call(envelope.token, envelope.peer, getReview), refusal);
  }
});

test('cleanup failure never leaks raw credentials and reports uncertain revocation safely', async () => {
  const f = await fixture();
  let failed: boolean | undefined;
  f.broker.revoke = async () => {
    throw Error('mbr_private_database_error');
  };
  await assert.rejects(
    provisionReadBroker(
      f.broker,
      {
        claim: async () => ({
          binding: f.binding,
          operationKey: 'op',
          releaseId: 'release',
          ttlSeconds: 60,
        }),
        launch: async () => {
          throw Error('mbr_private_transport_error');
        },
        record: async () => {},
        failed: async (_id, _grant, revoked) => {
          failed = revoked;
          throw Error('mbr_private_alert_error');
        },
      },
      'deployment',
    ),
    {
      code: 'read_broker_provision_denied',
      message: 'Public authority runtime provisioning was refused',
    },
  );
  assert.equal(failed, false);
});
