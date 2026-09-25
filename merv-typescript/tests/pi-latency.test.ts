import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService, type Caller, type Transaction } from '@merv/contracts';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
import { FleetService } from '../packages/fleet/src/index.js';
import { PiService } from '../packages/pi/src/index.js';
import { PiHttp } from '../packages/pi/src/api.js';
import type { PiBootstrap } from '../packages/pi/src/types.js';
import { createApp } from './fixtures/app.js';
import { assessment } from './fixtures/review-verdict.js';

class LocalRuntimes implements SandboxRuntimes {
  profileId = 'latency-fixture';
  leaseSeconds = 600;
  get profiles() {
    return [{ key: 'standard', id: this.profileId, leaseSeconds: this.leaseSeconds }];
  }
  describe = async () => null;
  connected = () => true;
  private handle?: SandboxRuntimeHandle;

  async provision(): Promise<SandboxRuntimeHandle> {
    this.handle ??= {
      sandboxId: 'sbx_latency',
      state: 'ready',
      ready: true,
      deleted: false,
      leaseExpiresAt: '2099-01-01T00:00:00Z',
      revision: 1,
      launch: null,
    };
    return structuredClone(this.handle);
  }
  async inspect(): Promise<SandboxRuntimeHandle> {
    assert.ok(this.handle);
    return structuredClone(this.handle);
  }
  async launch(
    _projectId: string,
    _handle: SandboxRuntimeHandle,
    key: string,
  ): Promise<SandboxRuntimeHandle> {
    assert.ok(this.handle);
    this.handle.launch ??= {
      sandboxId: this.handle.sandboxId,
      launchId: 'rln_latency',
      operationKey: key,
      releaseId: 'latency-fixture',
      jobId: 'job_latency',
      state: 'pending',
      deliveryState: 'launched',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    return structuredClone(this.handle);
  }
  async acknowledge(): Promise<SandboxRuntimeHandle> {
    assert.ok(this.handle?.launch);
    this.handle.launch.state = 'consumed';
    return structuredClone(this.handle);
  }
  async stop(): Promise<SandboxRuntimeHandle> {
    assert.ok(this.handle);
    this.handle.state = 'deleting';
    this.handle.ready = false;
    return structuredClone(this.handle);
  }
  async renew(): Promise<SandboxRuntimeHandle> {
    return this.inspect();
  }
}

const clock = () => Number(process.hrtime.bigint()) / 1_000_000;

test(
  'native dispatch and review admissions remain measurable while Pi streams over SSE without token writes',
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-pi-latency-'));
    const app = await createApp({
      directory,
      api: true,
      port: 0,
      components: [
        'state',
        'scope',
        'blobs',
        'artifacts',
        'domain-events',
        'workflows',
        'context-builder',
        'reviews',
        'tasks',
        'sessions',
      ],
    });
    const { state, scope, artifacts, reviews, sessions, tasks } = app.ctx;
    type Operation = 'progress' | 'dispatch' | 'review' | 'background';
    const operations = new AsyncLocalStorage<{ kind: Operation; readOnly?: boolean }>();
    const counts = Object.fromEntries(
      ['progress', 'dispatch', 'review', 'background'].map((kind) => [
        kind,
        { writes: 0, writerTransactions: 0, readTransactions: 0 },
      ]),
    ) as Record<
      Operation,
      { writes: number; writerTransactions: number; readTransactions: number }
    >;
    const snapshot = state.snapshot.bind(state);
    state.snapshot = ((fn: () => unknown) =>
      operations.run({ kind: operations.getStore()?.kind ?? 'background', readOnly: true }, () =>
        snapshot(fn),
      )) as typeof state.snapshot;
    const transaction = state.transaction.bind(state);
    state.transaction = ((fn: (tx: Transaction) => unknown) => {
      const operation = operations.getStore();
      const count = counts[operation?.kind ?? 'background'];
      count[operation?.readOnly ? 'readTransactions' : 'writerTransactions']++;
      return transaction((tx) => {
        const { run, get, all } = tx;
        const record = (sql: string) => {
          if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) count.writes++;
        };
        Object.assign(tx, {
          run: (sql: string, ...params: never[]) => (record(sql), run(sql, ...params)),
          get: (sql: string, ...params: never[]) => (record(sql), get(sql, ...params)),
          all: (sql: string, ...params: never[]) => (record(sql), all(sql, ...params)),
        });
        return fn(tx);
      });
    }) as typeof state.transaction;
    const boot = await scope.bootstrap({ projectName: 'Pi latency', actorName: 'Operator' });
    const operator: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const producerActor = await scope.issueActor(operator, { name: 'Producer', role: 'producer' });
    const reviewerActor = await scope.issueActor(operator, { name: 'Reviewer', role: 'reviewer' });
    const producer: Caller = {
      projectId: operator.projectId,
      actorId: producerActor.actor.id,
      credentialId: producerActor.credential.id,
    };
    const reviewer: Caller = {
      projectId: operator.projectId,
      actorId: reviewerActor.actor.id,
      credentialId: reviewerActor.credential.id,
    };
    const fleet = await createService(
      new FleetService(state, scope, new LocalRuntimes(), {
        enabled: true,
        globalLimit: 2,
        projectLimit: 2,
        pollIntervalMs: 30_000,
      }),
    );
    const secretEnv = `MERV_PI_LATENCY_${randomUUID().replaceAll('-', '')}`;
    process.env[secretEnv] = randomBytes(32).toString('base64url');
    // Machines are rented in the Pi host project, by its key.
    const host = await scope.bootstrap({ projectName: 'Pi host', actorName: 'Pi host' });
    const credentialEnv = `${secretEnv}_HOST`;
    process.env[credentialEnv] = host.token;
    const pi = await createService(
      new PiService(state, scope, fleet, app.ctx.tools, app.ctx.blobs, {
        enabled: true,
        baseUrl: app.ctx.api.url!,
        secretEnv,
        pollIntervalMs: 30_000,
        host: { projectId: host.project.id, credentialEnv },
      }),
    );
    const piHttp = new PiHttp(pi);
    const streamResponse = piHttp.stream.bind(piHttp);
    piHttp.stream = (...args) =>
      operations.run({ kind: 'progress' }, () => streamResponse(...args));
    const unmount = app.ctx.api.mount('/pi-worker', (req, res) =>
      operations.run({ kind: 'progress' }, () => piHttp.worker(req, res)),
    );
    const unregister = app.ctx.api.registerPi(piHttp);
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamDone: Promise<void> | undefined;
    t.after(async () => {
      await stream?.cancel().catch(() => undefined);
      await streamDone?.catch(() => undefined);
      piHttp.close();
      unregister();
      unmount();
      await pi.close();
      await fleet.close();
      await app.stop();
      delete process.env[secretEnv];
      delete process.env[credentialEnv];
      rmSync(directory, { recursive: true, force: true });
    });

    let sequence = 0;
    const task = async () =>
      await tasks.create(producer, {
        title: `Lease candidate ${++sequence}`,
        goal: 'Produce evidence',
        checks: ['Evidence is independently verifiable.'],
        requestId: `task-${sequence}`,
      });
    await task();
    await task();
    await sessions.setDispatch(operator, { enabled: true });
    await sessions.heartbeatRunner(producer, {
      runnerId: 'latency-runner',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 2 }],
      capacity: 2,
    });
    const proof = await artifacts.create(producer, {
      title: 'Proof',
      content: 'The verified value is 42.',
    });
    const reviewInput = async () => {
      const requested = await reviews.request(producer, {
        subjectId: `latency-subject-${++sequence}`,
        subjectRevision: 0,
        producerId: producer.actorId,
        artifactIds: [proof.id],
        criteria: ['The retained evidence is correct.'],
        requestId: `review-${sequence}`,
      });
      const started = await reviews.start(reviewer, requested.id);
      return {
        reviewId: started.id,
        claimId: started.claimId!,
        expectedRevision: started.subjectRevision,
        verdict: 'pass' as const,
        notes: 'Independently verified the retained result.',
        ...assessment(started),
        requestId: `submit-${sequence}`,
      };
    };
    const baselineReview = await reviewInput();
    const streamedReview = await reviewInput();
    const admission = async (kind: 'dispatch' | 'review', action: () => Promise<unknown>) => {
      const beforeWrites = counts[kind].writes;
      const start = clock();
      const result = await operations.run({ kind }, action);
      return {
        result,
        ms: Math.round((clock() - start) * 100) / 100,
        writes: counts[kind].writes - beforeWrites,
      };
    };
    const lease = () =>
      sessions.lease(producer, {
        runnerId: 'latency-runner',
        requestId: randomUUID(),
        secret: `ms_${randomBytes(32).toString('base64url')}`,
        platform: { name: 'codex', harness: 'codex' },
      });
    const baselineDispatch = await admission('dispatch', lease);
    assert.equal((baselineDispatch.result as Awaited<ReturnType<typeof lease>>).reason, 'offered');
    assert.ok(baselineDispatch.writes > 0, 'the baseline lease must write durable State');
    const baselineVerdict = await admission('review', () =>
      reviews.submit(reviewer, baselineReview),
    );
    assert.equal(
      (baselineVerdict.result as Awaited<ReturnType<typeof reviews.submit>>).status,
      'submitted',
    );
    assert.ok(baselineVerdict.writes > 0, 'the baseline review must write durable State');

    const conversation = await pi.create(operator, { requestId: 'latency-chat', title: 'Latency' });
    const sent = await pi.send(operator, conversation.id, {
      commandId: 'latency-turn',
      text: 'Stream locally',
    });
    const hostCaller = {
      projectId: host.project.id,
      actorId: host.actor.id,
      credentialId: host.credential.id,
    };
    const allocation = await fleet.inspect(hostCaller, sent.runtimeId);
    const token = (JSON.parse(await pi.bootstrap(allocation)) as PiBootstrap).workerToken;
    await fleet.tick();
    await fleet.tick();
    const { work } = await pi.next(token, { workerId: 'latency-worker' });
    assert.ok(work);
    const bound = {
      conversationId: conversation.id,
      commandId: work.command.id,
      workerId: 'latency-worker',
    };
    assert.deepEqual(await pi.begin(token, bound), { apply: true });

    const response = await fetch(`${app.ctx.api.url}/pi/${conversation.id}/events`, {
      headers: { authorization: `Bearer ${boot.token}` },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    stream = response.body.getReader();
    let frames = 0;
    let snapshotFrames = 0;
    let streamedText = 0;
    streamDone = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await stream!.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (
          let boundary = buffer.indexOf('\n\n');
          boundary >= 0;
          boundary = buffer.indexOf('\n\n')
        ) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          frames++;
          if (frame.includes('event: snapshot')) snapshotFrames++;
          if (frame.includes('event: delta') && frame.includes('"type":"text"')) streamedText++;
        }
      }
    })();
    const progress = async (batch: number) => {
      const result = await fetch(`${app.ctx.api.url}/pi-worker/progress`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...bound,
          events: Array.from({ length: 32 }, (_, index) => ({
            type: 'text',
            text: `token ${batch}:${index}`,
          })),
        }),
      });
      assert.equal(result.status, 200, await result.text());
    };
    // The first text records when the answer began to show: one write per turn, not per token.
    await progress(0);
    assert.equal(counts.progress.writes, 1, 'only the first text of a turn writes State');
    const beforeProgress = { ...counts.progress };
    const streaming = (async () => {
      for (let batch = 1; batch < 25; batch++) await progress(batch);
    })();
    const streamedDispatch = await admission('dispatch', lease);
    assert.equal((streamedDispatch.result as Awaited<ReturnType<typeof lease>>).reason, 'offered');
    assert.notEqual(
      (streamedDispatch.result as Awaited<ReturnType<typeof lease>>).session?.id,
      (baselineDispatch.result as Awaited<ReturnType<typeof lease>>).session?.id,
      'the streaming admission must offer another workflow instance',
    );
    assert.ok(streamedDispatch.writes > 0, 'the streaming lease must write durable State');
    const streamedVerdict = await admission('review', () =>
      reviews.submit(reviewer, streamedReview),
    );
    assert.equal(
      (streamedVerdict.result as Awaited<ReturnType<typeof reviews.submit>>).status,
      'submitted',
    );
    assert.ok(streamedVerdict.writes > 0, 'the streaming review must write durable State');
    await streaming;
    const firstStageWrites = counts.progress.writes - beforeProgress.writes;
    assert.equal(firstStageWrites, 0, 'progress alongside admissions must not write State');
    const beforeMoreTokens = { ...counts.progress };
    for (let batch = 25; batch < 49; batch++) await progress(batch);
    const extraStageWrites = counts.progress.writes - beforeMoreTokens.writes;
    assert.equal(extraStageWrites, 0, 'doubling the token count must not write State');
    assert.equal(
      counts.progress.writerTransactions,
      1,
      'streaming takes one writer transaction, for its first text',
    );
    assert.ok(
      counts.progress.readTransactions < 49,
      'a streaming turn and its page read their authority about once a second, not once a request',
    );
    await stream.cancel();
    await streamDone;
    assert.ok(
      snapshotFrames > 0 && streamedText > 0,
      'SSE must deliver canonical and transient frames',
    );
    t.diagnostic(
      JSON.stringify({
        baseline: {
          dispatch: { ms: baselineDispatch.ms, writes: baselineDispatch.writes },
          review: { ms: baselineVerdict.ms, writes: baselineVerdict.writes },
        },
        streaming: {
          dispatch: { ms: streamedDispatch.ms, writes: streamedDispatch.writes },
          review: { ms: streamedVerdict.ms, writes: streamedVerdict.writes },
        },
        progress: {
          firstStage: { tokens: 24 * 32, writes: firstStageWrites },
          extraStage: { tokens: 24 * 32, writes: extraStageWrites },
          writerTransactions: counts.progress.writerTransactions,
          readTransactions: counts.progress.readTransactions,
          sseFrames: frames,
          sseSnapshots: snapshotFrames,
          sseTextDeltas: streamedText,
        },
      }),
    );
  },
);
