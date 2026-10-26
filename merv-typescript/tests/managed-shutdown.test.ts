import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { shutdownReceiptSchema } from '@merv/sessions/managed-shutdown';
import { twoStepWorkflow, secret } from './fixtures/session-workflow.js';

test('shutdown control revokes new work, permits exact-session cleanup, and requires an immutable retained receipt', async (t) => {
  const f = await twoStepWorkflow(t, 'shutdown');
  for (const path of [
    '/code/v2/uploads',
    '/code/v2/finalize',
    '/code/v2/downloads',
    '/code/v2/uploads/old/complete',
    '/code/commands/next',
    '/code/commands/complete',
  ])
    assert.equal((await f.http('POST', path, f.token, {})).status, 404, `${path} is retired`);
  assert.equal((await f.http('PUT', '/code/v2/uploads/old/parts/0', f.token, {})).status, 404);
  const unit = await f.start();
  const platform = { name: 'test', harness: 'codex' as const, enabled: true, parallelism: 1 };
  const capabilities = ['workflow.workhost.1'];
  let current = true;
  f.sessions.managed.registerValidator({
    current: async () => current,
    admits: async () => current,
    serves: () => false,
    retired: async () => false,
    assignmentSources: async (binding) => [binding.source],
  });
  const allocationId = 'allocation_shutdown';
  const source = await f.app.ctx.scope.delegationSource(f.owner);
  const { enrollmentToken } = await f.sessions.managed.ensure({
    allocationId,
    epoch: 1,
    source,
    runtimeProfileId: 'test',
    platform,
    capabilities,
    workInstanceId: unit.id,
    stepSeconds: 600,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const { controlToken } = await f.sessions.managed.enroll(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const runner = await f.sessions.managed.authenticate(controlToken);
  await f.sessions.dispatch.heartbeatRunner(runner, {
    runnerId: 'shutdown-runner',
    machine: { hostname: 'test', system: 'test', architecture: 'test' },
    platforms: [platform],
    capabilities,
    capacity: 1,
  });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const lease = {
    runnerId: 'shutdown-runner',
    platform: { name: 'test', harness: 'codex' as const },
    requestId: 'shutdown-lease',
    secret: secret(),
  };
  const { session } = await f.sessions.dispatch.lease(runner, lease);
  assert.ok(session);
  await f.ok('POST', `/sessions/${session.id}/attach`, controlToken, {
    runnerId: 'shutdown-runner',
    hostRef: 'shutdown-host',
  });
  assert.deepEqual(await f.ok('POST', '/sessions/runners/shutdown', controlToken, {}), {
    requested: false,
    acknowledged: false,
  });
  assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), false);
  current = false; // Fleet stop intent no longer grants ordinary allocation authority.
  const cleanup = await f.sessions.managed.authenticate(controlToken);
  assert.equal(cleanup.managed?.cleanup, true);
  assert.equal((await f.http('POST', '/sessions/runners/heartbeat', controlToken, {})).status, 403);
  assert.equal((await f.http('POST', '/sessions/lease', controlToken, lease)).status, 403);
  assert.equal(
    (
      await f.http('POST', '/code/v2/git-credential', controlToken, {
        sessionId: session.id,
        runnerId: 'shutdown-runner',
        hostRef: 'shutdown-host',
      })
    ).status,
    403,
  );
  const premature = await f.http('POST', '/sessions/runners/shutdown', controlToken, {
    receipt: { captures: [], empty: true },
  });
  assert.equal(premature.status, 409, premature.text);
  await f.ok('POST', `/sessions/${session.id}/release`, controlToken, {
    runnerId: 'shutdown-runner',
  });
  const capture = {
    sessionId: session.id,
    unitId: unit.id,
    headOid: '1'.repeat(40),
    treeOid: '2'.repeat(40),
    operationId: 'cop_shutdown',
  };
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      `INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_session_id,writer_lease_id,head_oid)
    VALUES(?,?,?,1,'closed',?,?,?)`,
      f.owner.projectId,
      unit.id,
      new Date().toISOString(),
      session.id,
      session.id,
      capture.headOid,
    ),
  );
  assert.equal(
    (
      await f.http('POST', '/sessions/runners/shutdown', controlToken, {
        receipt: { captures: [], empty: true },
      })
    ).status,
    409,
  );
  const receipt = { captures: [capture], empty: false };
  assert.equal(
    (await f.http('POST', '/sessions/runners/shutdown', controlToken, { receipt })).status,
    409,
    'a claimed object without its durable final operation is insufficient',
  );
  await f.app.ctx.state.transaction((tx) =>
    tx.run(
      `INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id,generation)
    VALUES(?,?,?,?,'upload','test',?,'completed',?,?,?,?,1)`,
      capture.operationId,
      f.owner.projectId,
      `session:${session.id}`,
      `final:${session.id}`,
      JSON.stringify({ kind: 'final', sessionId: session.id }),
      JSON.stringify({ head: capture.headOid, tree: capture.treeOid }),
      new Date().toISOString(),
      new Date().toISOString(),
      unit.id,
    ),
  );
  assert.equal(
    (
      await f.http('POST', '/sessions/runners/shutdown', controlToken, {
        receipt: { ...receipt, captures: [{ ...capture, treeOid: '3'.repeat(40) }] },
      })
    ).status,
    409,
  );

  assert.deepEqual(await f.ok('POST', '/sessions/runners/shutdown', controlToken, { receipt }), {
    requested: true,
    acknowledged: true,
  });
  assert.deepEqual(await f.ok('POST', '/sessions/runners/shutdown', controlToken, { receipt }), {
    requested: true,
    acknowledged: true,
  });
  assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), true);
  assert.equal(
    (
      await f.http('POST', `/sessions/${session.id}/release`, controlToken, {
        runnerId: 'shutdown-runner',
      })
    ).status,
    403,
  );
  await assert.rejects(
    f.app.ctx.state.transaction((tx) =>
      tx.run('DELETE FROM session_managed_shutdowns WHERE allocation_id=?', allocationId),
    ),
  );
});

test('shutdown receipts support both native Git object formats', () => {
  for (const length of [40, 64])
    assert.equal(
      shutdownReceiptSchema.parse({
        captures: [
          {
            sessionId: 'session',
            unitId: 'unit',
            operationId: 'operation',
            headOid: 'a'.repeat(length),
            treeOid: 'b'.repeat(length),
          },
        ],
        empty: false,
      }).captures[0]!.headOid.length,
      length,
    );
});

for (const previousAttachment of [false, true])
  test(`shutdown after failed preparation ${previousAttachment ? 'retains a prior attached writer obligation' : 'accepts an empty receipt for a never-attached writer'}`, async (t) => {
    const f = await twoStepWorkflow(t, 'unattachedshutdown');
    const unit = await f.start();
    const platform = { name: 'test', harness: 'codex' as const, enabled: true, parallelism: 1 };
    const capabilities = ['workflow.workhost.1'];
    f.sessions.managed.registerValidator({
      current: async () => true,
      admits: async () => true,
      serves: () => false,
      retired: async () => false,
      assignmentSources: async (binding) => [binding.source],
    });
    const allocationId = 'allocation_unattached';
    const source = await f.app.ctx.scope.delegationSource(f.owner);
    const { enrollmentToken } = await f.sessions.managed.ensure({
      allocationId,
      epoch: 1,
      source,
      runtimeProfileId: 'test',
      platform,
      capabilities,
      workInstanceId: unit.id,
      stepSeconds: 600,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const { controlToken } = await f.sessions.managed.enroll(enrollmentToken, {
      workerNonce: randomBytes(32).toString('hex'),
    });
    const runner = await f.sessions.managed.authenticate(controlToken);
    const runnerId = 'unattached-runner';
    await f.sessions.dispatch.heartbeatRunner(runner, {
      runnerId,
      machine: { hostname: 'test', system: 'test', architecture: 'test' },
      platforms: [platform],
      capabilities,
      capacity: 1,
    });
    await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
    let lastSessionId = '';
    for (let i = 0; i < (previousAttachment ? 2 : 1); i++) {
      const { session } = await f.sessions.dispatch.lease(runner, {
        runnerId,
        platform: { name: 'test', harness: 'codex' as const },
        requestId: `unattached-${i}`,
        secret: secret(),
      });
      assert.ok(session, 'the work host receives its next visit');
      lastSessionId = session.id;
      await f.ok('POST', `/sessions/${session.id}/attach`, controlToken, {
        runnerId,
        hostRef: `unattached-host-${i}`,
      });
      if (previousAttachment && i === 0)
        await f.app.ctx.state.transaction((tx) =>
          tx.run(
            'INSERT INTO session_workspaces(session_id,attachment_json,result_json) VALUES(?,?,?)',
            session.id,
            '{}',
            '{}',
          ),
        );
      await f.ok('POST', `/sessions/${session.id}/release`, controlToken, { runnerId });
    }
    await f.app.ctx.state.transaction((tx) =>
      tx.run(
        `INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_session_id,writer_lease_id)
       VALUES(?,?,?,2,'closed',?,?)`,
        f.owner.projectId,
        unit.id,
        new Date().toISOString(),
        lastSessionId,
        lastSessionId,
      ),
    );
    assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), false);
    const reply = await f.http('POST', '/sessions/runners/shutdown', controlToken, {
      receipt: { captures: [], empty: true },
    });
    assert.equal(reply.status, previousAttachment ? 409 : 200, reply.text);
    assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), !previousAttachment);
  });

test('historical allocation shutdown requires its own archive receipt after another generation takes ownership', async (t) => {
  const f = await twoStepWorkflow(t, 'shutdown');
  for (const path of [
    '/code/v2/uploads',
    '/code/v2/finalize',
    '/code/v2/downloads',
    '/code/v2/uploads/old/complete',
    '/code/commands/next',
    '/code/commands/complete',
  ])
    assert.equal((await f.http('POST', path, f.token, {})).status, 404, `${path} is retired`);
  assert.equal((await f.http('PUT', '/code/v2/uploads/old/parts/0', f.token, {})).status, 404);
  const unit = await f.start();
  const platform = { name: 'test', harness: 'codex' as const, enabled: true, parallelism: 1 };
  const capabilities = ['workflow.workhost.1'];
  let current = true;
  f.sessions.managed.registerValidator({
    current: async () => current,
    admits: async () => current,
    serves: () => false,
    retired: async () => false,
    assignmentSources: async (binding) => [binding.source],
  });
  const allocationId = 'allocation_shutdown';
  const source = await f.app.ctx.scope.delegationSource(f.owner);
  const { enrollmentToken } = await f.sessions.managed.ensure({
    allocationId,
    epoch: 1,
    source,
    runtimeProfileId: 'test',
    platform,
    capabilities,
    workInstanceId: unit.id,
    stepSeconds: 600,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const { controlToken } = await f.sessions.managed.enroll(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const runner = await f.sessions.managed.authenticate(controlToken);
  await f.sessions.dispatch.heartbeatRunner(runner, {
    runnerId: 'shutdown-runner',
    machine: { hostname: 'test', system: 'test', architecture: 'test' },
    platforms: [platform],
    capabilities,
    capacity: 1,
  });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const lease = {
    runnerId: 'shutdown-runner',
    platform: { name: 'test', harness: 'codex' as const },
    requestId: 'shutdown-lease',
    secret: secret(),
  };
  const { session } = await f.sessions.dispatch.lease(runner, lease);
  assert.ok(session);
  await f.ok('POST', `/sessions/${session.id}/attach`, controlToken, {
    runnerId: 'shutdown-runner',
    hostRef: 'shutdown-host',
  });
  assert.deepEqual(await f.ok('POST', '/sessions/runners/shutdown', controlToken, {}), {
    requested: false,
    acknowledged: false,
  });
  assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), false);
  current = false; // Fleet stop intent no longer grants ordinary allocation authority.
  const cleanup = await f.sessions.managed.authenticate(controlToken);
  assert.equal(cleanup.managed?.cleanup, true);
  assert.equal((await f.http('POST', '/sessions/runners/heartbeat', controlToken, {})).status, 403);
  assert.equal((await f.http('POST', '/sessions/lease', controlToken, lease)).status, 403);
  assert.equal(
    (
      await f.http('POST', '/code/v2/git-credential', controlToken, {
        sessionId: session.id,
        runnerId: 'shutdown-runner',
        hostRef: 'shutdown-host',
      })
    ).status,
    403,
  );
  const premature = await f.http('POST', '/sessions/runners/shutdown', controlToken, {
    receipt: { captures: [], empty: true },
  });
  assert.equal(premature.status, 409, premature.text);
  await f.ok('POST', `/sessions/${session.id}/release`, controlToken, {
    runnerId: 'shutdown-runner',
  });

  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO session_workspaces(session_id,attachment_json) VALUES(?,?)',
      session.id,
      JSON.stringify({ headOid: '0'.repeat(40) }),
    );
    await tx.run(
      `INSERT INTO code_workspaces(project_id,unit_id,declared_at,generation,writer_state,writer_session_id,writer_lease_id,head_oid)
      VALUES(?,?,?,3,'active','replacement','replacement',?)`,
      f.owner.projectId,
      unit.id,
      new Date().toISOString(),
      '9'.repeat(40),
    );
  });
  const readWriter = () =>
    f.app.ctx.state.read((sql) =>
      sql.get(
        'SELECT * FROM code_workspaces WHERE project_id=? AND unit_id=?',
        f.owner.projectId,
        unit.id,
      ),
    );
  const before = await readWriter();
  const capture = {
    sessionId: session.id,
    unitId: unit.id,
    headOid: '1'.repeat(40),
    treeOid: '2'.repeat(40),
    operationId: 'archive_valid',
  };
  const submit = (captures = [capture]) =>
    f.http('POST', '/sessions/runners/shutdown', controlToken, {
      receipt: { captures, empty: captures.length === 0 },
    });
  assert.equal(
    (await submit([])).status,
    409,
    'new allocation must not erase the historical obligation',
  );
  const archive = {
    allocationId,
    epoch: 1,
    ref: `refs/merv/shutdown/${allocationId}/${session.id}`,
    baseHead: '0'.repeat(40),
  };
  const addReceipt = async (id: string, altered: Record<string, unknown>) =>
    f.app.ctx.state.transaction((tx) =>
      tx.run(
        `INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id,generation)
      VALUES(?,?,?,?,'upload','test',?,'completed',?,?,?,?,1)`,
        id,
        f.owner.projectId,
        `session:${session.id}`,
        id,
        JSON.stringify({
          kind: 'final',
          sessionId: session.id,
          unitId: unit.id,
          proposedHead: capture.headOid,
          treeOid: capture.treeOid,
          archiveRef: archive.ref,
          expectedHead: archive.baseHead,
          archive,
          ...altered,
        }),
        JSON.stringify({ head: capture.headOid, tree: capture.treeOid }),
        new Date().toISOString(),
        new Date().toISOString(),
        unit.id,
      ),
    );
  for (const [id, altered] of Object.entries({
    wrong_allocation: { archive: { ...archive, allocationId: 'another' } },
    wrong_epoch: { archive: { ...archive, epoch: 2 } },
    wrong_session: { sessionId: 'another' },
    missing_archive: { archive: undefined },
  })) {
    await addReceipt(id, altered);
    assert.equal((await submit([{ ...capture, operationId: id }])).status, 409, id);
  }
  await addReceipt(capture.operationId, {});
  assert.equal((await submit()).status, 200);
  assert.equal((await submit()).status, 200);
  assert.equal(await f.sessions.managed.requestShutdown(allocationId, 1), true);
  assert.deepEqual(
    await readWriter(),
    before,
    'historical acknowledgment cannot mutate the replacement writer',
  );
});
