import { createService } from '@merv/contracts';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DurableEvents } from '@merv/domain-events';
import type { EventConsumer } from '@merv/contracts';
import { openState } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Delivery did not converge');
    await sleep(10);
  }
}

test('durable delivery rolls back effects with its cursor, isolates failures, resumes after restart and does not duplicate commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'merv-events-'));
  let state = await openState(dir);
  let events = await createService(new DurableEvents(state));
  try {
    await state.migrate('probe', [
      {
        version: 1,
        sql: 'CREATE TABLE probe (consumer TEXT, event INTEGER, UNIQUE(consumer,event));',
      },
    ]);
    const emit = async () =>
      await state.transaction(
        async (tx) =>
          await state.appendEvent(tx, {
            projectId: 'p',
            actorId: 'a',
            type: 'probe.created',
            subjectId: 's',
            data: {},
          }),
      );
    await assert.rejects(
      async () =>
        await state.transaction(async (tx) => {
          await state.appendEvent(tx, {
            projectId: 'p',
            actorId: 'a',
            type: 'probe.created',
            subjectId: 'rolled-back',
            data: {},
          });
          throw Error('abort');
        }),
    );
    assert.equal(await state.eventHead(), 0);
    let fail = true;
    const handler = (id: string) => ({
      id,
      types: ['probe.created'],
      from: 'beginning' as const,
      async handle(event: any, tx: any) {
        await tx.run('INSERT INTO probe VALUES (?,?)', id, event.id);
        if (id === 'flaky' && fail) throw Error('sensitive failure detail');
      },
    });
    await events.subscribe(handler('flaky'));
    const detach = await events.subscribe(handler('healthy'));
    const first = await emit();
    await events.drain();
    assert.equal((await events.status()).find((x) => x.id === 'flaky')!.cursor, 0);
    assert.equal((await events.status()).find((x) => x.id === 'flaky')!.error, 'handler_failed');
    assert.equal((await events.status()).find((x) => x.id === 'healthy')!.cursor, first.id);
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 1);
    await detach();
    await emit();
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 1);
    await events.close();
    await state.close();
    state = await openState(dir);
    events = await createService(new DurableEvents(state));
    fail = false;
    await events.subscribe(handler('flaky'));
    await events.subscribe(handler('healthy'));
    await until(
      async () =>
        (await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length === 4,
    );
    await events.drain();
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 4);
    assert.ok((await events.status()).every((x) => x.attempts === 0 && x.error === null));
    await assert.rejects(
      async () => await events.subscribe({ ...handler('healthy'), types: ['different'] }),
      /already active/,
    );
    await events.subscribe({ ...handler('new-consumer'), from: 'now' });
    await events.drain();
    assert.equal((await state.read(async (sql) => await sql.all('SELECT * FROM probe'))).length, 4);
  } finally {
    await events.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review recovery survives unloaded consumers and revoked initiators, preserves snapshots, and fences stale claims', async () => {
  const { createApp } = await import('./fixtures/app.js');
  const directory = mkdtempSync(join(tmpdir(), 'merv-recovery-'));
  let app = await createApp({ directory, api: false });
  try {
    const bootstrap = await app.ctx.scope.bootstrap({
      projectName: 'Recovery',
      actorName: 'Operator',
    });
    const operator = { actorId: bootstrap.actor.id, projectId: bootstrap.project.id };
    const issue = async (role: 'producer' | 'reviewer' | 'operator') => ({
      actorId: (await app.ctx.scope.issueActor(operator, { name: role, role })).actor.id,
      projectId: operator.projectId,
    });
    const producer = await issue('producer'),
      reviewer = await issue('reviewer'),
      replacement = await issue('reviewer'),
      otherOperator = await issue('operator');
    const brief = await app.ctx.artifacts.create(producer, {
      title: 'Brief',
      content: 'Goal. Check.',
    });
    const task = await app.ctx.tasks.create(producer, {
      title: 'Task',
      goal: 'Goal.',
      checks: ['Check.'],
      briefId: brief.id,
      requestId: 'create',
    });
    const delivery = await app.ctx.artifacts.create(producer, {
      title: 'Delivery',
      content: 'Check. Verified.',
    });
    const pending = await app.ctx.tasks.submitDelivery(
      producer,
      confirmedDelivery({
        taskId: task.id,
        artifactIds: [delivery.id],
        expectedRevision: 0,
        requestId: 'deliver',
      }),
    );
    const claim = await app.ctx.reviews.start(reviewer, pending.reviewId!);
    await app.setEnabled('domain-events', false);
    assert.equal(app.ctx.get('reviews'), undefined);
    await app.ctx.scope.revokeActor(otherOperator, reviewer.actorId);
    await app.ctx.scope.revokeActor(operator, otherOperator.actorId);
    await app.setEnabled('domain-events', true);
    await until(async () => (await app.ctx.reviews.get(operator, claim.id)).status === 'requested');
    const recovered = await app.ctx.reviews.get(operator, claim.id);
    assert.equal(recovered.snapshotHash, claim.snapshotHash);
    assert.deepEqual(await app.ctx.tasks.get(producer, task.id), pending);
    assert.equal(recovered.recovery!.previousClaimId, claim.claimId);
    const newClaim = await app.ctx.reviews.start(replacement, claim.id);
    assert.notEqual(newClaim.claimId, claim.claimId);
    assert.equal(newClaim.claimGeneration, 2);
    await assert.rejects(
      () =>
        app.ctx.tasks.submitReview(replacement, {
          ...reviewedFindings(claim),
          reviewId: claim.id,
          claimId: claim.claimId!,
          expectedRevision: 1,
          verdict: 'pass',
          notes: 'stale',
          requestId: 'stale',
        }),
      /current review claim/,
    );
    await assert.rejects(
      () =>
        app.ctx.tasks.submitReview(reviewer, {
          ...reviewedFindings(claim),
          reviewId: claim.id,
          claimId: claim.claimId!,
          expectedRevision: 1,
          verdict: 'pass',
          notes: 'revoked',
          requestId: 'revoked',
        }),
      /access this project/,
    );
    const done = await app.ctx.tasks.submitReview(replacement, {
      ...reviewedFindings(newClaim),
      reviewId: claim.id,
      claimId: newClaim.claimId!,
      expectedRevision: 1,
      verdict: 'pass',
      notes: 'Independently checked.',
      requestId: 'accept',
    });
    assert.equal(done.workflow.state, 'done');
    await app.ctx.scope.revokeActor(operator, replacement.actorId);
    await app.ctx.domainEvents.drain();
    assert.equal((await app.ctx.reviews.get(operator, claim.id)).status, 'submitted');
    await app.stop();
    app = await createApp({ directory, api: false });
    await app.ctx.domainEvents.drain();
    assert.equal(
      (await app.ctx.state.events(operator.projectId)).filter(
        (e) => e.type === 'review.claim_released',
      ).length,
      1,
    );
    assert.equal((await app.ctx.tasks.get(operator, task.id)).workflow.state, 'done');
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('async handlers are supported, changed subscriptions require a new ID, and detach stops further admissions', async () => {
  const state = await openState(':memory:'),
    events = await createService(new DurableEvents(state));
  try {
    const detachAsync = await events.subscribe({
      id: 'async',
      types: ['test'],
      from: 'beginning',
      handle: async () => {},
    });
    await detachAsync();
    const cancel = await events.subscribe({
      id: 'stable',
      types: ['test'],
      from: 'beginning',
      handle: () => {},
    });
    await cancel();
    await assert.rejects(
      async () =>
        await events.subscribe({
          id: 'stable',
          types: ['other'],
          from: 'beginning',
          handle: () => {},
        }),
      /new consumer ID/,
    );
    let count = 0;
    const stop = await events.subscribe({
      id: 'once',
      types: ['test'],
      from: 'beginning',
      handle: () => {
        count++;
        stop();
      },
    });
    await state.transaction(async (tx) => {
      for (let i = 0; i < 2; i++)
        await state.appendEvent(tx, {
          projectId: 'p',
          actorId: 'a',
          subjectId: 's',
          type: 'test',
          data: {},
        });
    });
    await events.drain();
    assert.equal(count, 1);
    await events.close();
    await assert.rejects(
      async () =>
        await events.subscribe({
          id: 'closed',
          types: ['test'],
          from: 'beginning',
          handle: () => {},
        }),
      /closed/,
    );
  } finally {
    await events.close();
    await state.close();
  }
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function emitProbe(state: PostgresState) {
  return state.transaction((tx) =>
    state.appendEvent(tx, {
      projectId: 'p',
      actorId: 'a',
      subjectId: 's',
      type: 'probe.created',
      data: {},
    }),
  );
}

test('a failed delivery cannot put another worker’s successful delivery back into retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-events-stale-failure-'));
  const state = await openState(directory);
  const other = await openState(directory);
  const events = await createService(new DurableEvents(state));
  const successor = await createService(new DurableEvents(other));
  const failed = signal(),
    released = signal();
  const failure = new Error('handler failed');
  const transaction = state.transaction.bind(state);
  state.transaction = async (fn) => {
    try {
      return await transaction(fn);
    } catch (error) {
      if (error === failure) {
        failed.resolve();
        await released.promise;
      }
      throw error;
    }
  };
  try {
    await events.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle() {
        throw failure;
      },
    });
    const first = await emitProbe(state);
    const draining = events.drain();
    await failed.promise;
    const handled: number[] = [];
    await successor.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle(event) {
        handled.push(event.id);
      },
    });
    await successor.drain();
    const successful = [
      { id: 'worker', cursor: first.id, active: true, attempts: 0, error: null, retryAt: 0 },
    ];
    assert.deepEqual(await successor.status(), successful);
    released.resolve();
    await draining;
    await events.close();
    assert.deepEqual(await successor.status(), successful);
    const second = await emitProbe(other);
    await successor.drain();
    assert.deepEqual(handled, [first.id, second.id]);
  } finally {
    released.resolve();
    state.transaction = transaction;
    await Promise.all([events.close(), successor.close()]);
    await Promise.all([state.close(), other.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('drain joins async handlers and close waits for their atomic commit without admitting the next event', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-events-drain-'));
  const state = await openState(directory);
  const observer = await openState(directory);
  const events = await createService(new DurableEvents(state));
  const entered = signal(),
    released = signal();
  try {
    await state.migrate('probe', [
      { version: 1, sql: 'CREATE TABLE probe (event INTEGER PRIMARY KEY);' },
    ]);
    // Both events exist before the consumer does: a handler held open inside its delivery
    // transaction holds the writer lock, so an emit after subscribing could wait on it.
    const first = await emitProbe(state);
    await emitProbe(state);
    await events.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle(event, tx) {
        await tx.run('INSERT INTO probe VALUES (?)', event.id);
        entered.resolve();
        await released.promise;
      },
    });
    const draining = events.drain();
    await entered.promise;
    assert.equal(events.drain(), draining);
    let closed = false;
    const closing = events.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.deepEqual(await observer.read((sql) => sql.all('SELECT * FROM probe')), []);
    assert.equal(
      (await observer.read((sql) =>
        sql.get<{ cursor: number }>('SELECT cursor FROM event_consumers WHERE id=?', 'worker'),
      ))!.cursor,
      0,
    );
    released.resolve();
    await Promise.all([draining, closing]);
    assert.equal(closed, true);
    assert.deepEqual(
      (await observer.read((sql) => sql.all<{ event: number }>('SELECT * FROM probe'))).map(
        (row) => row.event,
      ),
      [first.id],
    );
    assert.equal((await events.status())[0]!.cursor, first.id);
    assert.equal((await events.status())[0]!.active, false);
  } finally {
    released.resolve();
    await events.close();
    await observer.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('consumer disposer withdraws future admissions and waits for an admitted async transaction', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  const entered = signal(),
    released = signal();
  let calls = 0;
  try {
    // Emit first: the blocked handler below holds the writer lock until it is released.
    await emitProbe(state);
    await emitProbe(state);
    const detach = await events.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle() {
        calls++;
        entered.resolve();
        await released.promise;
      },
    });
    const draining = events.drain();
    await entered.promise;
    let detached = false;
    const detaching = Promise.resolve(detach()).then(() => {
      detached = true;
    });
    await Promise.resolve();
    assert.equal(detached, false);
    released.resolve();
    await Promise.all([draining, detaching]);
    await events.drain();
    assert.equal(detached, true);
    assert.equal(calls, 1);
  } finally {
    released.resolve();
    await events.close();
    await state.close();
  }
});

test('async self-detachment does not wait for its own transaction', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  let calls = 0;
  try {
    const detach = await events.subscribe({
      id: 'self',
      types: ['probe.created'],
      from: 'beginning',
      async handle() {
        calls++;
        await detach();
      },
    });
    await emitProbe(state);
    await emitProbe(state);
    await events.drain();
    assert.equal(calls, 1);
  } finally {
    await events.close();
    await state.close();
  }
});

test('close joins pending subscriptions and duplicate registration cannot race activation', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  const entered = signal(),
    released = signal();
  const consumer: EventConsumer = {
    id: 'pending',
    types: ['probe.created'],
    from: 'beginning',
    handle() {},
  };
  try {
    const busy = state.transaction(async () => {
      entered.resolve();
      await released.promise;
    });
    await entered.promise;
    const pending = events.subscribe(consumer);
    const refused = assert.rejects(pending, /closed/);
    await assert.rejects(events.subscribe(consumer), /already active/);
    let closed = false;
    const closing = events.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    released.resolve();
    await Promise.all([busy, refused, closing]);
    assert.equal((await events.status())[0]!.active, false);
  } finally {
    released.resolve();
    await events.close();
    await state.close();
  }
});

test('background drain contains transient storage rejections and retries durable work', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  const transaction = state.transaction.bind(state);
  let calls = 0;
  try {
    await events.subscribe({
      id: 'worker',
      types: ['probe.created'],
      from: 'beginning',
      async handle() {
        calls++;
      },
    });
    // Inject the failures while no delivery is in flight, then commit the event past them. A
    // delivery transaction requested before the injection could otherwise deliver first and
    // leave the failures to a later drain that the explicit drain below would join.
    await events.drain();
    let failures = 2;
    state.transaction = async (fn) => {
      if (failures-- > 0) throw new Error('temporary storage failure');
      return transaction(fn);
    };
    await transaction((tx) =>
      state.appendEvent(tx, {
        projectId: 'p',
        actorId: 'a',
        subjectId: 's',
        type: 'probe.created',
        data: {},
      }),
    );
    await until(() => calls === 1);
    assert.ok(failures < 0, 'both injected failures reached the background drain first');
    await events.drain();
    assert.equal((await events.status())[0]!.cursor, 1);
  } finally {
    state.transaction = transaction;
    await events.close();
    await state.close();
  }
});

test('joining drain includes a commit made after an earlier consumer exhausted its backlog', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  const transaction = state.transaction.bind(state);
  const entered = signal(),
    released = signal();
  const delivered: number[] = [];
  try {
    await events.subscribe({
      id: 'first',
      types: ['probe.created'],
      from: 'beginning',
      async handle(event) {
        delivered.push(event.id);
      },
    });
    await events.subscribe({
      id: 'second',
      types: ['probe.created'],
      from: 'beginning',
      handle() {},
    });
    const first = await emitProbe(state);
    let pause = true;
    state.transaction = async (fn) => {
      const result = await transaction(fn);
      // Pause after the first consumer's empty poll has committed. This leaves
      // the database free for a new event before this drain visits other consumers.
      if (pause && result === false) {
        pause = false;
        entered.resolve();
        await released.promise;
      }
      return result;
    };
    const draining = events.drain();
    await entered.promise;
    const next = await emitProbe(state);
    const joined = events.drain();
    released.resolve();
    await Promise.all([draining, joined]);
    assert.deepEqual(delivered, [first.id, next.id]);
    assert.equal((await events.status()).find((row) => row.id === 'first')!.cursor, next.id);
  } finally {
    released.resolve();
    state.transaction = transaction;
    await events.close();
    await state.close();
  }
});

for (const cursor of [0, Number.MAX_SAFE_INTEGER]) {
  test(`handler event edits cannot move the durable cursor to ${cursor}`, async () => {
    const state = await openState(':memory:');
    const events = await createService(new DurableEvents(state));
    try {
      await state.migrate('cursor_probe', [
        {
          version: 1,
          sql: 'CREATE TABLE cursor_probe(seq BIGINT GENERATED ALWAYS AS IDENTITY, event BIGINT);',
        },
      ]);
      let changed = false;
      await events.subscribe({
        id: 'cursor-owner',
        types: ['probe.created'],
        from: 'beginning',
        async handle(event, tx) {
          await tx.run('INSERT INTO cursor_probe(event) VALUES (?)', event.id);
          if (!changed) {
            changed = true;
            event.id = cursor;
          }
        },
      });
      const first = await emitProbe(state),
        second = await emitProbe(state);
      await events.drain();
      assert.deepEqual(
        (
          await state.read((sql) =>
            sql.all<{ event: number }>('SELECT event FROM cursor_probe ORDER BY seq'),
          )
        ).map((row) => row.event),
        [first.id, second.id],
      );
      assert.equal((await events.status())[0].cursor, second.id);
      const third = await emitProbe(state);
      await events.drain();
      assert.equal((await events.status())[0].cursor, third.id);
    } finally {
      await events.close();
      await state.close();
    }
  });
}

for (const shape of ['getter', 'proxy', 'revoked proxy'] as const) {
  test(`a handler's thrown ${shape} cannot prevent failure isolation`, async () => {
    const state = await openState(':memory:');
    const events = await createService(new DurableEvents(state));
    let effects = 0,
      healthyCalls = 0;
    const trap = () => {
      effects++;
      throw new Error('error inspection must not execute this');
    };
    let failure: unknown;
    if (shape === 'getter') failure = Object.defineProperty({}, 'code', { get: trap });
    else if (shape === 'proxy')
      failure = new Proxy({}, { has: trap, get: trap, getOwnPropertyDescriptor: trap });
    else {
      const proxy = Proxy.revocable({}, {});
      proxy.revoke();
      failure = proxy.proxy;
    }
    try {
      await events.subscribe({
        id: 'failing',
        types: ['probe.created'],
        from: 'beginning',
        handle() {
          throw failure;
        },
      });
      await events.subscribe({
        id: 'healthy',
        types: ['probe.created'],
        from: 'beginning',
        handle() {
          healthyCalls++;
        },
      });
      const event = await emitProbe(state);
      await events.drain();
      const status = await events.status();
      assert.equal(effects, 0);
      assert.equal(healthyCalls, 1);
      assert.equal(status.find((consumer) => consumer.id === 'healthy')!.cursor, event.id);
      const failed = status.find((consumer) => consumer.id === 'failing')!;
      assert.equal(failed.cursor, 0);
      assert.equal(failed.attempts, 1);
      assert.equal(failed.error, 'handler_failed');
      assert.ok(failed.retryAt > 0);
    } finally {
      await events.close();
      await state.close();
    }
  });
}

for (const operation of ['drain', 'close'] as const) {
  test(`a handler cannot ${operation} its own dispatcher and strand other consumers`, async () => {
    const state = await openState(':memory:');
    const events = await createService(new DurableEvents(state));
    let outcome: unknown;
    let healthy = 0;
    try {
      await events.subscribe({
        id: 'self',
        types: ['probe.created'],
        from: 'beginning',
        async handle() {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            outcome = await Promise.race([
              Promise.resolve()
                .then(() => events[operation]())
                .then(
                  () => 'unexpected success',
                  (error: unknown) => error,
                ),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve('self-wait deadlock'), 100);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
      });
      await events.subscribe({
        id: 'healthy',
        types: ['probe.created'],
        from: 'beginning',
        handle() {
          healthy++;
        },
      });
      const first = await emitProbe(state);
      await events.drain();
      assert.equal((outcome as { code?: string })?.code, 'events_handler_active', String(outcome));
      assert.equal(healthy, 1);
      assert.ok(
        (await events.status()).every(
          (consumer) => consumer.cursor === first.id && consumer.active,
        ),
      );
      await emitProbe(state);
      await events.drain();
      assert.equal(healthy, 2);
    } finally {
      await events.close();
      await state.close();
    }
  });
}

test('a continuation inherited from a completed handler can close normally', async () => {
  const state = await openState(':memory:');
  const events = await createService(new DurableEvents(state));
  const released = signal();
  let continuation: Promise<void> | undefined;
  let calls = 0;
  try {
    await events.subscribe({
      id: 'continuation',
      types: ['probe.created'],
      from: 'beginning',
      handle() {
        calls++;
        continuation ??= released.promise.then(() => events.close());
      },
    });
    await emitProbe(state);
    await events.drain();
    released.resolve();
    await continuation;
    assert.equal(calls, 1);
    assert.equal((await events.status())[0]!.active, false);
  } finally {
    released.resolve();
    await continuation;
    await events.close();
    await state.close();
  }
});
