import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import type { Caller, Transaction } from '@merv/contracts';
import { ClaimService } from '../packages/claims/src/index.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-claims-'));
  const path = join(directory, 'state.sqlite');
  let state: SqliteState, scope: ProjectScope, claims: ClaimService;
  const open = async () => {
    state = new SqliteState(path);
    scope = await createService(new ProjectScope(state));
    claims = await createService(new ClaimService(state, scope));
  };
  const close = async () => {
    claims.close();
    await state.close();
  };
  await open();
  const boot = await scope!.bootstrap({ projectName: 'Claims project', actorName: 'Operator' });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await scope.issueActor(operator, { name: role, role });
    return {
      actorId: issued.actor.id,
      projectId: operator.projectId,
      credentialId: issued.credential.id,
    };
  };
  const producer = await issue('producer'),
    reader = await issue('reader'),
    reviewer = await issue('reviewer');
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    operator,
    producer,
    reader,
    reviewer,
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    get claims() {
      return claims;
    },
    async restart() {
      await close();
      await open();
    },
    events: async () =>
      (await state.events(operator.projectId)).filter((e) => e.type.startsWith('claim.')),
  };
}
const seed = (requestId = 'create') => ({
  statement: '  The treatment improves held-out accuracy. \n',
  scope: '\t Dataset A and the fixed training budget.  ',
  requestId,
});

test('Claims normalize creation, retain identity and list every lifecycle state in stable order', async (t) => {
  const f = await fixture(t);
  const initial = await f.claims.create(f.producer, seed());
  assert.equal(initial.statement, 'The treatment improves held-out accuracy.');
  assert.equal(initial.scope, 'Dataset A and the fixed training budget.');
  assert.equal(initial.status, 'active');
  assert.equal(initial.confidence, 'medium');
  assert.equal(initial.revision, 0);
  assert.equal(initial.projectId, f.operator.projectId);
  assert.equal(initial.createdBy, f.producer.actorId);
  assert.equal(initial.updatedBy, f.producer.actorId);
  assert.ok(Number.isFinite(Date.parse(initial.createdAt)));
  assert.equal(initial.updatedAt, initial.createdAt);
  const changed = await f.claims.update(f.operator, {
    claimId: initial.id,
    status: 'supported',
    confidence: 'high',
    expectedRevision: 0,
    requestId: 'support',
  });
  assert.equal(changed.revision, 1);
  assert.equal(changed.status, 'supported');
  assert.equal(changed.confidence, 'high');
  assert.equal(changed.statement, initial.statement);
  assert.equal(changed.scope, initial.scope);
  assert.equal(changed.createdBy, initial.createdBy);
  assert.equal(changed.createdAt, initial.createdAt);
  assert.equal(changed.updatedBy, f.operator.actorId);
  const same = await f.claims.update(f.producer, {
    claimId: initial.id,
    status: 'supported',
    confidence: 'high',
    expectedRevision: 1,
    requestId: 'same-values',
  });
  assert.equal(same.revision, 2);
  assert.equal(same.updatedBy, f.producer.actorId);
  for (const status of [
    'draft',
    'active',
    'supported',
    'weakened',
    'contradicted',
    'abandoned',
  ] as const) {
    const claim = await f.claims.create(f.producer, { statement: status, requestId: status });
    await f.claims.update(f.producer, {
      claimId: claim.id,
      status,
      expectedRevision: 0,
      requestId: `status-${status}`,
    });
  }
  const listed = await f.claims.list(f.reader);
  assert.equal(listed.length, 7);
  assert.deepEqual(
    [...new Set(listed.map((c) => c.status))].sort(),
    ['active', 'draft', 'supported', 'weakened', 'contradicted', 'abandoned'].sort(),
  );
  assert.deepEqual(
    listed.map((c) => [c.createdAt, c.id]),
    listed
      .map((c) => [c.createdAt, c.id])
      .sort(([a, b], [c, d]) => (a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0)),
  );
  listed[0].statement = 'mutated';
  assert.notEqual((await f.claims.get(f.reader, listed[0].id)).statement, 'mutated');
  assert.equal((await f.events()).filter((e) => e.type === 'claim.updated').length, 8);
});

test('Claims replay normalized input and historical results after later updates and restart', async (t) => {
  const f = await fixture(t),
    input = seed();
  const created = await f.claims.create(f.producer, input);
  assert.deepEqual(
    await f.claims.create(f.producer, {
      ...input,
      statement: created.statement,
      scope: created.scope,
      confidence: 'medium',
    }),
    created,
  );
  const update = {
    claimId: created.id,
    status: 'weakened' as const,
    expectedRevision: 0,
    requestId: 'update',
  };
  const one = await f.claims.update(f.producer, update);
  const two = await f.claims.update(f.operator, {
    claimId: created.id,
    confidence: 'low',
    expectedRevision: 1,
    requestId: 'next',
  });
  assert.deepEqual(await f.claims.create(f.producer, input), created);
  assert.deepEqual(await f.claims.update(f.producer, update), one);
  assert.equal((await f.claims.get(f.producer, created.id)).revision, 2);
  await assert.rejects(
    async () => await f.claims.create(f.producer, { ...input, statement: 'Different claim.' }),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () => await f.claims.update(f.producer, { ...update, confidence: 'high' }),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () => await f.claims.update(f.producer, { ...update, expectedRevision: 1 }),
    {
      code: 'request_conflict',
    },
  );
  await f.restart();
  assert.deepEqual(await f.claims.create(f.producer, input), created);
  assert.deepEqual(await f.claims.update(f.producer, update), one);
  assert.deepEqual(await f.claims.get(f.reader, created.id), two);
  assert.equal((await f.events()).length, 3);
});

test('Claims scope reads and writes, deny stale authority before replay, and enforce revision CAS', async (t) => {
  const f = await fixture(t),
    input = seed(),
    created = await f.claims.create(f.producer, input);
  for (const caller of [f.reader, f.reviewer]) {
    assert.deepEqual(await f.claims.get(caller, created.id), created);
    await assert.rejects(async () => await f.claims.create(caller, seed('reader')), {
      code: 'forbidden',
    });
    await assert.rejects(
      async () =>
        await f.claims.update(caller, {
          claimId: created.id,
          status: 'supported',
          expectedRevision: 0,
          requestId: 'reader',
        }),
      { code: 'forbidden' },
    );
  }
  const otherBoot = await f.scope.bootstrap({ projectName: 'Other tenant', actorName: 'Other' });
  const other = { actorId: otherBoot.actor.id, projectId: otherBoot.project.id };
  assert.deepEqual(await f.claims.list(other), []);
  await assert.rejects(async () => await f.claims.get(other, created.id), { status: 404 });
  await assert.rejects(
    async () =>
      await f.claims.update(other, {
        claimId: created.id,
        status: 'supported',
        expectedRevision: 0,
        requestId: 'cross-project',
      }),
    { status: 404 },
  );
  await assert.rejects(
    async () => await f.claims.list({ ...f.producer, projectId: other.projectId }),
    {
      code: 'forbidden',
    },
  );
  await f.claims.update(f.producer, {
    claimId: created.id,
    confidence: 'high',
    expectedRevision: 0,
    requestId: 'winner',
  });
  await assert.rejects(
    async () =>
      await f.claims.update(f.operator, {
        claimId: created.id,
        confidence: 'low',
        expectedRevision: 0,
        requestId: 'loser',
      }),
    { code: 'claim_revision_conflict' },
  );
  assert.equal((await f.claims.get(f.reader, created.id)).confidence, 'high');
  await f.scope.revokeCredential(f.operator, f.producer.credentialId!);
  await assert.rejects(async () => await f.claims.create(f.producer, input), { code: 'forbidden' });
  await assert.rejects(
    async () =>
      await f.claims.update(f.producer, {
        claimId: created.id,
        confidence: 'high',
        expectedRevision: 0,
        requestId: 'winner',
      }),
    { code: 'forbidden' },
  );
  await assert.rejects(async () => await f.claims.list(f.producer), { code: 'forbidden' });
  assert.equal((await f.events()).length, 2);
});

test('Claims data, events and replay receipts roll back with their caller transaction and event failures', async (t) => {
  const f = await fixture(t);
  let rolledBack!: Awaited<ReturnType<ClaimService['create']>>;
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        rolledBack = await f.claims.create(f.producer, seed(), tx);
        assert.equal((await f.claims.get(f.reader, rolledBack.id, tx)).revision, 0);
        throw new Error('Domain failure');
      }),
    /Domain failure/,
  );
  assert.deepEqual(await f.claims.list(f.reader), []);
  assert.equal((await f.events()).length, 0);
  const created = await f.claims.create(f.producer, seed());
  assert.notEqual(created.id, rolledBack.id);
  const update = {
    claimId: created.id,
    status: 'contradicted' as const,
    expectedRevision: 0,
    requestId: 'atomic-update',
  };
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        await f.claims.update(f.producer, update, tx);
        throw new Error('Outer failed');
      }),
    /Outer failed/,
  );
  assert.deepEqual(await f.claims.get(f.reader, created.id), created);
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    if (event.type.startsWith('claim.')) throw new Error('Event failed');
    return await append(tx, event);
  };
  await assert.rejects(
    async () => await f.claims.create(f.producer, seed('event-failed')),
    /Event failed/,
  );
  await assert.rejects(async () => await f.claims.update(f.producer, update), /Event failed/);
  f.state.appendEvent = append;
  assert.equal((await f.claims.list(f.reader)).length, 1);
  assert.equal((await f.events()).length, 1);
  assert.equal((await f.claims.update(f.producer, update)).revision, 1);
  let stale!: Transaction;
  await f.state.transaction(async (tx) => {
    stale = tx;
  });
  await assert.rejects(async () => await f.claims.create(f.producer, seed('stale-tx'), stale));
  await assert.rejects(async () => await f.claims.get(f.reader, created.id, stale));
});

test('Claims refuse malformed flat input without invoking accessors or serializers', async (t) => {
  const f = await fixture(t);
  let sideEffects = 0;
  const getter = {
    requestId: 'getter',
    get statement() {
      sideEffects++;
      return 'A claim';
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        sideEffects++;
        return [];
      },
      getPrototypeOf() {
        sideEffects++;
        return Object.prototype;
      },
    },
  );
  const malformed = [
    getter,
    proxy,
    {
      statement: 'A claim',
      requestId: 'serializer',
      toJSON() {
        sideEffects++;
        return {};
      },
    },
    {},
    null,
    [],
    { statement: ' \t\n', requestId: 'blank' },
    { statement: 'x'.repeat(16001), requestId: 'long' },
    { statement: 'Valid', scope: 'x'.repeat(16001), requestId: 'longscope' },
    { statement: 'Valid', confidence: 'certain', requestId: 'bad' },
    { statement: 'Valid', status: 'supported', requestId: 'unexpected' },
    { statement: 'Valid', scope: null, requestId: 'null' },
    { statement: 'Valid', requestId: 'x', extra: true },
  ];
  for (const input of malformed)
    await assert.rejects(
      async () => await f.claims.create(f.producer, input as Parameters<ClaimService['create']>[1]),
    );
  assert.equal(sideEffects, 0);
  assert.deepEqual(await f.claims.list(f.reader), []);
  assert.equal((await f.events()).length, 0);
  const maximum = await f.claims.create(f.producer, {
    statement: 'x'.repeat(16000),
    scope: 'x'.repeat(16000),
    requestId: 'maximum',
  });
  assert.equal(maximum.statement.length, 16000);
  assert.equal(maximum.scope.length, 16000);
  for (const patch of [
    {},
    { status: 'invalid' },
    { confidence: 'invalid' },
    { status: null },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { statement: 'edit statement' },
    { scope: 'edit scope' },
  ])
    await assert.rejects(
      async () =>
        await f.claims.update(f.producer, {
          claimId: maximum.id,
          expectedRevision: 0,
          requestId: 'bad-update',
          ...patch,
        } as Parameters<ClaimService['update']>[1]),
    );
  assert.equal((await f.claims.get(f.reader, maximum.id)).revision, 0);
});

test('Claims record the verified user-key source while preserving the original creator', async (t) => {
  const f = await fixture(t);
  const human = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://claims.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await f.scope.createProject(human, {
    name: 'Owned research',
    requestId: 'project',
  });
  const key = await f.scope.createKey(human, { projectId: project.id });
  const caller = await f.scope.caller({
    kind: 'key',
    key: await f.scope.authenticateKey(key.token),
  });
  const claim = await f.claims.create(caller, seed());
  const changed = await f.claims.update(caller, {
    claimId: claim.id,
    status: 'weakened',
    expectedRevision: 0,
    requestId: 'update',
  });
  assert.equal(changed.createdBy, caller.actorId);
  assert.equal(changed.updatedBy, caller.actorId);
  const events = (await f.state.events(project.id)).filter((e) => e.type.startsWith('claim.'));
  assert.equal(events.length, 2);
  for (const event of events)
    assert.deepEqual(event.data.source, {
      kind: 'user-key',
      keyId: key.key.id,
      membershipId: caller.key!.membershipId,
    });
  await f.scope.revokeKey(human, key.key.id);
  await assert.rejects(async () => await f.claims.create(caller, seed()));
  assert.equal((await f.claims.get(await f.scope.caller(human, project.id), claim.id)).revision, 1);
});

test(
  'two independent SQLite writers overlap and exactly one claim revision update commits',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      claim = await f.claims.create(f.producer, seed());
    const barrier = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
      control = new Int32Array(barrier);
    const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {register}=await import(workerData.loader);register();
      const [{SqliteState},{ProjectScope},{ClaimService}]=await Promise.all([import(workerData.stateModule),import(workerData.scopeModule),import(workerData.claimModule)]);
      const state=new SqliteState(workerData.path),scope=new ProjectScope(state),claims=new ClaimService(state,scope),control=new Int32Array(workerData.barrier);
      await scope.initialize();await claims.initialize();
      const append=state.appendEvent.bind(state);
      state.appendEvent=async(tx,event)=>{ const value=await append(tx,event); if(workerData.first&&event.type==='claim.updated'){
        Atomics.store(control,0,1);parentPort.postMessage({type:'held'});
        if(Atomics.wait(control,1,0,5000)==='timed-out')throw new Error('Parent did not release transaction');Atomics.store(control,0,0);
      }return value;};
      const transaction=state.transaction.bind(state);
      state.transaction=fn=>transaction(tx=>{if(!workerData.first)Atomics.store(control,2,1);return fn(tx)});
      parentPort.once('message',async()=>{
        parentPort.postMessage({type:'attempt'});
        try { const claim=await claims.update(workerData.caller,{claimId:workerData.claimId,status:workerData.first?'supported':'contradicted',expectedRevision:0,requestId:workerData.first?'writer-one':'writer-two'});parentPort.postMessage({type:'result',ok:true,claim}); }
        catch(error){parentPort.postMessage({type:'result',ok:false,code:error.code})}
        finally {claims.close();await state.close();parentPort.close();}
      });parentPort.postMessage({type:'ready'});
    })().catch(error=>{throw error});
  `;
    const spawn = (caller: Caller, first: boolean) =>
      new Worker(source, {
        eval: true,
        execArgv: [],
        workerData: {
          caller,
          first,
          path: f.path,
          claimId: claim.id,
          barrier,
          loader: import.meta.resolve('tsx/esm/api'),
          stateModule: new URL('../packages/state/src/index.ts', import.meta.url).href,
          scopeModule: new URL('../packages/scope/src/index.ts', import.meta.url).href,
          claimModule: new URL('../packages/claims/src/index.ts', import.meta.url).href,
        },
      });
    const first = spawn(f.producer, true),
      second = spawn(f.operator, false);
    const message = (worker: Worker, type: string) =>
      new Promise<any>((resolve, reject) => {
        const cleanup = () => {
          worker.off('message', receive);
          worker.off('error', fail);
          worker.off('exit', exit);
        };
        const receive = (value: any) => {
          if (value.type === type) {
            cleanup();
            resolve(value);
          }
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exit = (code: number) =>
          fail(new Error('Worker exited before ' + type + ': ' + code));
        worker.on('message', receive);
        worker.once('error', fail);
        worker.once('exit', exit);
      });
    try {
      await Promise.all([message(first, 'ready'), message(second, 'ready')]);
      const held = message(first, 'held');
      first.postMessage('go');
      await held;
      const attempted = message(second, 'attempt');
      second.postMessage('go');
      await attempted;
      await delay(100);
      assert.equal(Atomics.load(control, 0), 1, 'First writer still holds transaction');
      assert.equal(Atomics.load(control, 2), 0, 'Second writer cannot enter its transaction yet');
      const results = Promise.all([message(first, 'result'), message(second, 'result')]);
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      const [one, two] = await results;
      assert.equal(one.ok, true);
      assert.equal(one.claim.revision, 1);
      assert.deepEqual(two, { type: 'result', ok: false, code: 'claim_revision_conflict' });
      const current = await f.claims.get(f.reader, claim.id);
      assert.equal(current.status, 'supported');
      assert.equal(current.revision, 1);
      assert.equal(current.updatedBy, f.producer.actorId);
      assert.equal((await f.events()).filter((e) => e.type === 'claim.updated').length, 1);
    } finally {
      Atomics.store(control, 1, 1);
      Atomics.notify(control, 1);
      await Promise.all([first.terminate(), second.terminate()]);
    }
  },
);

test('Claims creation identity and command receipts are immutable; request IDs are scoped by actor', async (t) => {
  const f = await fixture(t),
    input = seed();
  const one = await f.claims.create(f.producer, input),
    two = await f.claims.create(f.operator, input);
  assert.notEqual(one.id, two.id);
  assert.equal(two.createdBy, f.operator.actorId);
  await assert.rejects(
    async () =>
      await f.claims.update(f.producer, {
        claimId: one.id,
        status: 'supported',
        expectedRevision: 0,
        requestId: input.requestId,
      }),
    { code: 'request_conflict' },
  );
  for (const column of ['id', 'project_id', 'created_by', 'created_at'])
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await tx.run(`UPDATE claims SET ${column}=? WHERE id=?`, 'changed', one.id),
        ),
      /immutable/,
    );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM claims WHERE id=?', one.id),
      ),
    /retained/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "UPDATE claim_commands SET result_json='{}' WHERE actor_id=?",
            f.producer.actorId,
          ),
      ),
    /immutable/,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await tx.run('DELETE FROM claim_commands WHERE actor_id=?', f.producer.actorId),
      ),
    /retained/,
  );
  assert.deepEqual(await f.claims.create(f.producer, input), one);
});

test('Claims authority loss during event publication rolls back data, source revocation and replay receipt', async (t) => {
  const f = await fixture(t),
    append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    const value = await append(tx, event);
    if (event.type === 'claim.created')
      await tx.run(
        'UPDATE actor_credentials SET revoked_at=? WHERE id=?',
        new Date().toISOString(),
        f.producer.credentialId!,
      );
    return value;
  };
  await assert.rejects(async () => await f.claims.create(f.producer, seed()), {
    code: 'forbidden',
  });
  f.state.appendEvent = append;
  assert.deepEqual(await f.claims.list(f.reader), []);
  assert.equal((await f.events()).length, 0);
  assert.equal((await f.claims.create(f.producer, seed())).revision, 0);
  const events = await f.events();
  assert.deepEqual(events[0].data, {
    before: null,
    statement: 'The treatment improves held-out accuracy.',
    scope: 'Dataset A and the fixed training budget.',
    status: 'active',
    confidence: 'medium',
    revision: 0,
  });
  const claim = (await f.claims.list(f.reader))[0];
  await f.claims.update(f.operator, {
    claimId: claim.id,
    status: 'supported',
    confidence: 'high',
    expectedRevision: 0,
    requestId: 'update',
  });
  assert.deepEqual((await f.events())[1].data.before, {
    status: 'active',
    confidence: 'medium',
    revision: 0,
  });
  assert.equal((await f.events())[1].data.revision, 1);
});

test('Claim get rejects nonstring IDs without calling then or serialization getters', async (t) => {
  const f = await fixture(t);
  let called = 0;
  const id = {
    get then() {
      called++;
      return () => {};
    },
    get toJSON() {
      called++;
      return () => 'claim';
    },
  };
  await assert.rejects(async () => await f.claims.get(f.reader, id as unknown as string), {
    code: 'invalid_claim_input',
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        called++;
        return undefined;
      },
    },
  );
  await assert.rejects(async () => await f.claims.get(f.reader, proxy as unknown as string), {
    code: 'invalid_claim_input',
  });
  assert.equal(called, 0);
});
