import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createService, sha256Hex, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import { nativeMigrations } from '../packages/sandboxes/src/native-schema.js';
import { managedAccountSubject } from '../packages/sandboxes/src/account-billing.js';
import { openState } from './fixtures/state.js';
import { deferred } from './fixtures/deferred.js';

async function fixture(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  await state.migrate('sandboxes-native', nativeMigrations);
  t.after(() => state.close());
  const project = async (subject: string, requestId: string): Promise<Caller> => {
    const principal = await scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const created = await scope.createProject(principal, { name: requestId, requestId });
    return scope.caller(principal, created.id);
  };
  const a = await project('owner-a', 'a');
  const roots = new Map<
    string,
    { connection_id: string; project_ref: string; account_id: string; member_id: string }
  >();
  const subjects: string[] = [];
  const calls: string[] = [];
  const controls = {
    lose: false,
    resources: false,
    racingResource: false,
    busy: new Set<string>(),
    pause: undefined as ReturnType<typeof deferred<void>> | undefined,
    entered: deferred<void>(),
  };
  const fetcher: typeof fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${options?.method ?? 'GET'} ${path}`);
    const headers = new Headers(options?.headers);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/delegations/connections') {
      assert.equal(headers.get('authorization'), 'Bearer sbxt_managed_test_token');
      assert.equal(headers.get('x-sandbox-namespace'), 'managed');
      const subject = headers.get('x-sandbox-subject')!;
      assert.match(subject, /^merv_account_[a-f0-9]{64}$/);
      subjects.push(subject);
      roots.set(
        body.token_hash,
        roots.get(body.token_hash) ?? {
          connection_id: `root_${roots.size}`,
          project_ref: body.project_ref,
          account_id: 'managed_account',
          member_id: subject,
        },
      );
      controls.entered.resolve();
      await controls.pause?.promise;
      if (controls.lose) {
        controls.lose = false;
        throw new Error('lost reply');
      }
      return json(roots.get(body.token_hash), 201);
    }
    if (path.endsWith('/resources'))
      return json({
        workflows: controls.resources || controls.busy.has(path) ? [{ id: 'historical' }] : [],
        jobs: [],
        sandboxes: [],
        next: { workflows: null, jobs: null, sandboxes: null },
      });
    if (options?.method === 'DELETE') {
      if (controls.racingResource) controls.resources = true;
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/delegations/allowance')
      return json({ budgets: [{ scope: 'member', cap: '500' }] });
    if (path === '/v1/delegations/connection') {
      const secret = headers.get('authorization')!.slice('Bearer '.length);
      return json(roots.get(sha256Hex(secret)) ?? {}, roots.has(sha256Hex(secret)) ? 200 : 404);
    }
    return json({}, 404);
  };
  const config = {
    applicationId: 'merv',
    applicationSecretEnv: 'APP',
    encryptionKeyEnv: 'KEY',
    publicOrigin: 'http://127.0.0.1:4317',
    managed: { namespace: 'managed', tokenEnv: 'ML' },
  };
  const reopen = () =>
    new NativeConnections(
      state,
      scope,
      config,
      'http://127.0.0.1:8000',
      {
        APP: 'synthetic_app_secret',
        KEY: Buffer.alloc(32, 8).toString('base64url'),
        ML: 'sbxt_managed_test_token',
      },
      fetcher,
    );
  return { state, scope, a, project, roots, subjects, calls, controls, reopen, service: reopen() };
}

test('managed funding shares creator identity across projects and separates accounts', async (t) => {
  const f = await fixture(t);
  const b = await f.project('owner-a', 'b'),
    c = await f.project('owner-b', 'c');
  const [a, otherProject, otherAccount] = await Promise.all([
    f.service.enableManaged(f.a),
    f.service.enableManaged(b),
    f.service.enableManaged(c),
  ]);
  assert.equal(a.memberId, otherProject.memberId);
  assert.notEqual(a.memberId, otherAccount.memberId);
  assert.notEqual(a.connectionId, otherProject.connectionId);
  assert.equal(a.funding, 'managed');
  assert.deepEqual(a.allowance, { budgets: [{ scope: 'member', cap: '500' }] });
  assert.deepEqual(await f.reopen().enableManaged(f.a), a);
  assert.equal(f.roots.size, 3);
  await assert.rejects(f.service.begin(f.a), { code: 'sandbox_managed_required' });
  await assert.rejects(
    f.state.transaction((tx) => managedAccountSubject(f.scope, 'imported-without-owner', tx)),
    { code: 'compute_account_missing' },
  );
});

test('lost managed issuance reply reuses the durable request and bearer after restart', async (t) => {
  const f = await fixture(t);
  f.controls.lose = true;
  await assert.rejects(f.service.enableManaged(f.a), { code: 'sandbox_unavailable' });
  const result = await f.reopen().enableManaged(f.a);
  assert.equal(result.connected, true);
  assert.equal(f.roots.size, 1);
});

test('disconnect fences managed issuance in flight', async (t) => {
  const f = await fixture(t);
  f.controls.pause = deferred<void>();
  const pending = f.service.enableManaged(f.a);
  await f.controls.entered.promise;
  await f.service.disconnect(f.a);
  f.controls.pause.resolve();
  await assert.rejects(pending, { code: 'sandbox_connection_conflict' });
  assert.equal((await f.service.status(f.a)).connected, false);
  await f.service.reconcileRevocations();
  assert.ok(f.calls.includes('DELETE /v1/delegations/connection'));
});

async function prior(f: Awaited<ReturnType<typeof fixture>>) {
  await f.state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('old',?,'old_root','personal','old_member',?,?)`,
      f.a.projectId,
      f.service.credentials.seal({ bearer: 'sbxt_personal_test_token' }, 'connection:old'),
      new Date().toISOString(),
    );
    await tx.run(
      'INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES(?,?)',
      f.a.projectId,
      'old',
    );
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace)
      VALUES(?,'experiment','pilot','old','old_work','old_ns')`,
      f.a.projectId,
    );
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,closed_at)
      VALUES(?,'task','foundation','old','historical_work','historical_ns',?)`,
      f.a.projectId,
      new Date().toISOString(),
    );
  });
}

test('empty issued pilot migrates after revocation while completed work retains its provenance', async (t) => {
  const f = await fixture(t);
  await prior(f);
  const result = await f.service.enableManaged(f.a);
  const pilot = await f.state.read((tx) =>
    tx.get<any>("SELECT * FROM sandbox_native_work WHERE work_id='pilot'"),
  );
  assert.equal(pilot.connection_id, result.connectionId);
  assert.equal(pilot.native_grant_id, null);
  assert.equal(pilot.closed_at, null);
  const closed = await f.state.read((tx) =>
    tx.get<any>("SELECT * FROM sandbox_native_work WHERE work_id='foundation'"),
  );
  assert.equal(closed.connection_id, 'old');
  assert.equal(closed.native_grant_id, 'historical_work');
  assert.deepEqual(
    f.calls.filter((x) => x.includes('/works/')),
    [
      'GET /v1/delegations/works/old_work/resources',
      'DELETE /v1/delegations/works/old_work',
      'GET /v1/delegations/works/old_work/resources',
    ],
  );
});

test('open work on a disconnected connection moves when managed ML is enabled again', async (t) => {
  const f = await fixture(t);
  await prior(f);
  const first = await f.service.enableManaged(f.a);
  await f.state.transaction(async (tx) => {
    await tx.run(
      "UPDATE sandbox_native_work SET native_grant_id='managed_work',namespace='managed_ns' WHERE work_id='pilot'",
    );
    // A session that ran with compute and closed: its assignment waits to be revoked.
    await tx.run(
      `INSERT INTO sandbox_native_assignments
      (lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials,revoke_pending)
      VALUES('lease','session',?,'experiment','pilot','attempt','execute',?,'x',TRUE)`,
      f.a.projectId,
      new Date(Date.now() + 6 * 3600_000).toISOString(),
    );
  });
  await f.service.disconnect(f.a);
  // The disconnected connection's tokens went with it, so its assignment is revoked too.
  const lease = await f.state.read((tx) =>
    tx.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM sandbox_native_assignments WHERE lease_id='lease'",
    ),
  );
  assert.ok(lease?.revoked_at);
  f.calls.length = 0;
  // The disconnected connection's grant went with it: nothing is checked or retired through it.
  const again = await f.service.enableManaged(f.a);
  assert.equal(again.connected, true);
  assert.notEqual(again.connectionId, first.connectionId);
  const pilot = await f.state.read((tx) =>
    tx.get<any>("SELECT * FROM sandbox_native_work WHERE work_id='pilot'"),
  );
  assert.deepEqual(
    [pilot.connection_id, pilot.native_grant_id, pilot.closed_at],
    [again.connectionId, null, null],
  );
  assert.deepEqual(
    f.calls.filter((x) => x.includes('/works/')),
    [],
  );
});

test('work with retained resources cannot be silently rebound to managed funding', async (t) => {
  const f = await fixture(t);
  await prior(f);
  f.controls.resources = true;
  await assert.rejects(f.service.enableManaged(f.a), { code: 'sandbox_migration_required' });
  assert.equal((await f.service.status(f.a)).connectionId, 'old');
  assert.ok(!f.calls.includes('DELETE /v1/delegations/works/old_work'));
});

test('one busy work keeps every old work grant in place', async (t) => {
  const f = await fixture(t);
  await prior(f);
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace)
      VALUES(?,'experiment','running','old','busy_work','busy_ns')`,
      f.a.projectId,
    ),
  );
  f.controls.busy.add('/v1/delegations/works/busy_work/resources');
  await assert.rejects(f.service.enableManaged(f.a), { code: 'sandbox_migration_required' });
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith('DELETE /v1/delegations/works/')),
    [],
  );
});

test('work that moves to managed funding leaves the old account its expired assignments revoked', async (t) => {
  const f = await fixture(t);
  await prior(f);
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO sandbox_native_assignments
    (lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials)
    VALUES('lease','session',?,'experiment','pilot','attempt','execute',?,'x')`,
      f.a.projectId,
      new Date(Date.now() - 1000).toISOString(),
    ),
  );
  await f.service.enableManaged(f.a);
  // Reconciling the moved work never asks the new grant to revoke a lease it never held.
  const lease = await f.state.read((tx) =>
    tx.get<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM sandbox_native_assignments WHERE lease_id='lease'",
    ),
  );
  assert.ok(lease?.revoked_at);
});

test('active assignments block a funding change before external issuance', async (t) => {
  const f = await fixture(t);
  await prior(f);
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO sandbox_native_assignments
    (lease_id,session_id,project_id,work_kind,work_id,attempt_ref,profile,expires_at,credentials)
    VALUES('lease','session',?,'experiment','pilot','attempt','execute',?,'pending')`,
      f.a.projectId,
      new Date(Date.now() + 3600000).toISOString(),
    ),
  );
  await assert.rejects(f.service.enableManaged(f.a), { code: 'sandbox_migration_required' });
  assert.equal(f.roots.size, 0);
  assert.equal((await f.service.status(f.a)).connectionId, 'old');
});

test('a resource admitted before revocation prevents rebinding and preserves the old record', async (t) => {
  const f = await fixture(t);
  await prior(f);
  f.controls.racingResource = true;
  await assert.rejects(f.service.enableManaged(f.a), { code: 'sandbox_migration_required' });
  assert.ok(f.calls.includes('DELETE /v1/delegations/works/old_work'));
  const pilot = await f.state.read((tx) =>
    tx.get<any>("SELECT * FROM sandbox_native_work WHERE work_id='pilot'"),
  );
  assert.equal(pilot.connection_id, 'old');
  assert.equal(pilot.native_grant_id, 'old_work');
  await assert.rejects(
    f.state.read((tx) => f.service.assertReady(f.a.projectId, tx)),
    { code: 'sandbox_connection_pending' },
  );
});

test('an unreadable expired flow does not stall the flows behind it', async (t) => {
  const f = await fixture(t);
  const expired = (ms: number) => new Date(Date.now() - ms).toISOString();
  await f.state.transaction(async (tx) => {
    const flow = `INSERT INTO sandbox_native_flows(id,project_id,operator_ref,browser_hash,expires_at,payload)
      VALUES(?,?,'operator','hash',?,?)`;
    await tx.run(flow, 'bad', f.a.projectId, expired(2000), 'not-a-sealed-payload');
    await tx.run(
      flow,
      'good',
      f.a.projectId,
      expired(1000),
      f.service.credentials.seal({}, 'flow:good'),
    );
  });
  await f.service.reconcileRevocations();
  const left = await f.state.read((sql) =>
    sql.all<{ id: string }>('SELECT id FROM sandbox_native_flows ORDER BY id'),
  );
  assert.deepEqual(
    left.map(({ id }) => id),
    ['bad'],
  );
});
