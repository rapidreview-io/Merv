import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { type Scope, type Transaction, sha256Hex } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { NativeConnections } from '../packages/sandboxes/src/native-connections.js';
import { NativeWorkService, type NativeResources } from '../packages/sandboxes/src/native-work.js';
import {
  nativeMigrations,
  type NativeAssignmentRow,
  type NativeWorkRow,
} from '../packages/sandboxes/src/native-schema.js';
import { openState } from './fixtures/state.js';

type Assignment = {
  token_id: string;
  namespace: string;
  account_id: string;
  member_id: string;
  project_ref: string;
  work_ref: string;
  lease_ref: string;
  attempt_ref: string;
  profile: string;
  expires_at: string;
  revoked_at: string | null;
};
async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  await state.migrate('native-work-test', nativeMigrations);
  t.after(() => state.close());
  const calls: {
    path: string;
    body?: Record<string, any>;
    query: URLSearchParams;
    method: string;
  }[] = [];
  const assignments = new Map<string, Assignment>();
  const tombstones = new Set<string>();
  let closed = false,
    loseIssueReply = false;
  let onIssue: (() => Promise<void>) | undefined;
  let onResources: (() => Promise<void>) | undefined;
  let loseWorkReply = false;
  let resourcePage = (_query: URLSearchParams): NativeResources => ({
    namespace: 'ns_work',
    workflows: [],
    jobs: [],
    sandboxes: [],
    next: { workflows: null, jobs: null, sandboxes: null },
  });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(state.ambient, undefined, 'native I/O must not hold a state transaction');
    const url = new URL(String(input));
    const path = url.pathname,
      method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, query: url.searchParams });
    let reply: unknown;
    if (path === '/v1/delegations/works')
      reply = {
        work_grant_id: 'grant_work',
        namespace: 'ns_work',
        member_id: 'member',
        work_ref: 'task_work',
        work_kind: 'task',
        revoked_at: closed ? new Date().toISOString() : null,
      };
    else if (path.endsWith('/assignments') && method === 'POST') {
      if (closed || tombstones.has(body.lease_ref))
        return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
      reply = assignments.get(body.lease_ref) ?? {
        ...body,
        token_id: `token_${body.lease_ref}`,
        namespace: 'ns_work',
        account_id: 'account',
        member_id: 'member',
        project_ref: 'project',
        work_ref: 'task_work',
        revoked_at: null,
      };
      assignments.set(body.lease_ref, reply as Assignment);
      await onIssue?.();
      if (loseIssueReply) {
        loseIssueReply = false;
        throw new Error('lost response with sensitive upstream details');
      }
    } else if (path.endsWith('/assignments')) reply = { assignments: [...assignments.values()] };
    else if (path.includes('/assignments/') && method === 'DELETE') {
      const lease = path.split('/').at(-1)!;
      tombstones.add(lease);
      const row = assignments.get(lease);
      if (row) row.revoked_at = new Date().toISOString();
      return new Response(null, { status: 204 });
    } else if (path.endsWith('/resources')) {
      await onResources?.();
      reply = resourcePage(url.searchParams);
    } else if (path.endsWith('/actions')) reply = {};
    else if (path === '/v1/delegations/works/grant_work' && method === 'DELETE') {
      closed = true;
      return new Response(null, { status: 204 });
    } else throw new Error(`Unexpected test route ${path}`);
    if (path === '/v1/delegations/works' && loseWorkReply) {
      loseWorkReply = false;
      throw Error('lost work receipt');
    }
    return Response.json(reply);
  }) as typeof fetch;
  const connections = new NativeConnections(
    state,
    {} as Scope,
    {
      applicationId: 'app',
      applicationSecretEnv: 'APP',
      encryptionKeyEnv: 'KEY',
      publicOrigin: 'https://merv.example',
    },
    'https://sandboxes.example',
    { KEY: randomBytes(32).toString('base64url') },
    fetcher,
  );
  await state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('connection','project','root','account','member',?,?)`,
      connections.credentials.seal({ bearer: `sbxt_${'r'.repeat(43)}` }, 'connection:connection'),
      new Date().toISOString(),
    );
    await tx.run(
      "INSERT INTO sandbox_native_projects(project_id,connection_id) VALUES('project','connection')",
    );
  });
  const work = new NativeWorkService(state, connections);
  await state.transaction(async (tx) => {
    await work.pin('project', 'task', 'task_work', tx);
    await work.transition('project', 'task', 'task_work', { attempt: '1' }, tx);
  });
  const session = (id = 'lease_one'): Session =>
    ({
      id,
      projectId: 'project',
      instanceId: 'task_work',
      hardDeadline: new Date(Date.now() + 3_600_000).toISOString(),
      lease: { leaseId: id, instanceId: 'task_work', projectId: 'project', workflow: 'task' },
      execution: {
        workflow: 'task',
        policy: { readOnly: false },
        references: {
          sandboxConnectionId: 'connection',
          sandboxWorkKind: 'task',
          sandboxWorkId: 'task_work',
          sandboxAttempt: '1',
          sandboxProfile: 'execute',
        },
      },
    }) as unknown as Session;
  const readWork = () =>
    state.read((sql) =>
      sql.get<NativeWorkRow>("SELECT * FROM sandbox_native_work WHERE work_id='task_work'"),
    );
  const readAssignment = (lease = 'lease_one') =>
    state.read((sql) =>
      sql.get<NativeAssignmentRow>(
        'SELECT * FROM sandbox_native_assignments WHERE lease_id=?',
        lease,
      ),
    );
  return {
    state,
    connections,
    work,
    calls,
    assignments,
    tombstones,
    session,
    readWork,
    readAssignment,
    onResources: (fn: () => Promise<void>) => {
      onResources = fn;
    },
    loseWorkReply: () => {
      loseWorkReply = true;
    },
    loseReply: () => {
      loseIssueReply = true;
    },
    onIssue: (fn: () => Promise<void>) => {
      onIssue = fn;
    },
    resources: (fn: typeof resourcePage) => {
      resourcePage = fn;
    },
  };
}

test('native work pins one payer and returns only verified capture IDs from the fixed namespace', async (t) => {
  const f = await fixture(t);
  await f.state.transaction(async (tx) => {
    assert.equal(await f.work.connected('project', tx), true);
    await f.work.pin('project', 'task', 'task_work', tx);
    assert.equal(
      (await f.work.references('project', 'task', 'task_work', '1', 'execute', tx))
        .sandboxConnectionId,
      'connection',
    );
    await assert.rejects(f.work.references('project', 'task', 'task_work', 'other', 'check', tx), {
      code: 'sandbox_scope_conflict',
    });
    await tx.run("UPDATE sandbox_native_work SET namespace='ns_work' WHERE work_id='task_work'");
    await tx.run(
      "INSERT INTO sandbox_native_captures VALUES('connection','ns_work','wf','node','verified'),('connection','other','wf','node','unrelated')",
    );
    assert.deepEqual(await f.work.artifactIds('project', 'task', 'task_work', tx), ['verified']);
    assert.deepEqual(await f.work.artifactIds('other', 'task', 'task_work', tx), []);
  });
  assert.equal(f.calls.length, 0);
});

test('unknown assignment issuance retries the identical encrypted secret and hash, then handoff revokes only that lease', async (t) => {
  const f = await fixture(t),
    session = f.session();
  f.loseReply();
  await assert.rejects(f.work.launchConnections(session), { code: 'sandbox_unavailable' });
  const stored = await f.readAssignment();
  assert.ok(stored?.credentials);
  assert.equal(stored.native_token_id, null);
  const first = await f.work.launchConnections(session);
  const issue = f.calls.filter((c) => c.path.endsWith('/assignments') && c.method === 'POST');
  assert.equal(issue[0]!.body!.token_hash, issue[1]!.body!.token_hash);
  assert.equal(issue[0]!.body!.token_hash, sha256Hex(first[0]!.bearer));
  assert.ok(!JSON.stringify(f.calls).includes(first[0]!.bearer));
  assert.ok(!stored.credentials.includes(first[0]!.bearer));
  await f.state.transaction((tx) =>
    tx.run('UPDATE sandbox_native_work SET transition_pending=FALSE'),
  );
  await f.state.transaction((tx) => f.work.revokeAssignment(session.lease.leaseId, tx));
  assert.equal((await f.readWork())!.transition_pending, true);
  await f.work.reconcile();
  assert.ok(f.tombstones.has(session.id));
  const next = await f.work.launchConnections(f.session('lease_two'));
  assert.notEqual(next[0]!.bearer, first[0]!.bearer);
  assert.equal(f.calls.filter((c) => c.path === '/v1/delegations/works').length, 1);
  assert.equal((await f.readWork())!.closed_at, null);
});

test('lease tombstones fence credentials even before any native issuance row exists', async (t) => {
  const f = await fixture(t);
  await f.state.transaction((tx) => f.work.revokeAssignment('lease_one', tx));
  await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_scope_conflict' });
  assert.equal(f.calls.length, 0);
});

for (const reason of ['release', 'attempt', 'closed'] as const)
  test(`native issuance racing ${reason} is withheld and revoked`, async (t) => {
    const f = await fixture(t);
    f.onIssue(() =>
      f.state.transaction(async (tx) => {
        if (reason === 'release') await f.work.revokeAssignment('lease_one', tx);
        else
          await f.work.transition(
            'project',
            'task',
            'task_work',
            reason === 'closed' ? { closed: true } : { attempt: '2' },
            tx,
          );
      }),
    );
    await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_scope_conflict' });
    assert.ok(f.tombstones.has('lease_one'));
    assert.ok((await f.readAssignment())!.revoked_at);
  });

test('attempt reconciliation fences old assignments and cancels only old provenance while retaining warm machines', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  await f.state.transaction((tx) =>
    f.work.transition('project', 'task', 'task_work', { attempt: '2' }, tx),
  );
  f.resources(() => ({
    namespace: 'ns_work',
    next: { workflows: null, jobs: null, sandboxes: null },
    sandboxes: [{ id: 'warm', namespace: 'ns_work', state: 'ready' }],
    workflows: [
      {
        id: 'old',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'old_token',
        attempt_ref: '1',
        admission_profile: 'execute',
        nodes: {},
      },
      {
        id: 'new',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'new_token',
        attempt_ref: '2',
        admission_profile: 'execute',
        nodes: {},
      },
    ],
    jobs: [
      {
        id: 'direct_old',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'old_token',
        attempt_ref: '1',
        workflow_id: null,
      },
      {
        id: 'child_finalizer',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'old_token',
        attempt_ref: '1',
        workflow_id: 'old',
      },
    ],
  }));
  await f.work.reconcile();
  const actions = f.calls.filter((c) => c.path.endsWith('/actions')).map((c) => c.body);
  assert.deepEqual(actions, [
    { kind: 'workflow_cancel', id: 'old' },
    { kind: 'job_cancel', id: 'direct_old' },
  ]);
  assert.ok(
    f.calls.findIndex((c) => c.method === 'DELETE' && c.path.includes('/assignments/')) <
      f.calls.findIndex((c) => c.path.endsWith('/actions')),
  );
  assert.equal((await f.readWork())!.transition_pending, true);
});

test('closure pages both streams, preserves finalizers, retries evidence independently, and confirms stopped machines', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  await f.state.transaction((tx) =>
    f.work.transition('project', 'task', 'task_work', { closed: true }, tx),
  );
  let terminal = false,
    stopped = false,
    failEvidence = true;
  const published: string[] = [];
  f.work.setEvidencePublisher(async (work, connection, workflow) => {
    assert.ok(work.closed_at);
    assert.equal(connection.id, 'connection');
    published.push(workflow.id);
    if (failEvidence) throw Error('capture registration temporarily unavailable');
  });
  f.resources((query) => ({
    namespace: 'ns_work',
    next: {
      workflows: query.get('workflows_after') ? null : 'wf_cursor',
      jobs: null,
      sandboxes: null,
    },
    workflows: [
      {
        id: query.get('workflows_after') ? 'finalizer' : 'done',
        namespace: 'ns_work',
        state: query.get('workflows_after') && !terminal ? 'cleaning_up' : 'completed',
        origin_grant_id: 'token',
        attempt_ref: '1',
        admission_profile: 'execute',
        nodes: { capture: {} },
      },
    ],
    jobs: [
      {
        id: 'direct',
        namespace: 'ns_work',
        state: terminal ? 'cancelled' : 'running',
        origin_grant_id: 'token',
        attempt_ref: '1',
        workflow_id: null,
      },
    ],
    sandboxes: [
      { id: 'borrowed', namespace: 'ns_work', state: stopped ? 'stopped' : 'provisioning' },
    ],
  }));
  await f.work.reconcile();
  assert.deepEqual(published, ['done', 'finalizer']);
  assert.equal(f.calls.filter((c) => c.body?.kind === 'sandbox_delete').length, 0);
  assert.ok(f.calls.some((c) => c.body?.kind === 'job_cancel'));
  terminal = true;
  await f.work.reconcile();
  assert.equal(f.calls.filter((c) => c.body?.kind === 'sandbox_delete').length, 1);
  assert.equal((await f.readWork())!.transition_pending, true);
  stopped = true;
  await f.work.reconcile();
  assert.equal(
    (await f.readWork())!.transition_pending,
    true,
    'evidence failures retain reconciliation intent',
  );
  failEvidence = false;
  await f.work.reconcile();
  assert.equal((await f.readWork())!.transition_pending, false);
  const callCount = f.calls.length;
  await f.work.reconcile();
  assert.equal(f.calls.length, callCount, 'confirmed closed work no longer polls');
});

test('repeated pagination cursors cannot falsely confirm cleanup', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  await f.state.transaction((tx) =>
    f.work.transition('project', 'task', 'task_work', { closed: true }, tx),
  );
  f.resources(() => ({
    namespace: 'ns_work',
    workflows: [],
    jobs: [],
    sandboxes: [],
    next: { workflows: 'repeat', jobs: null, sandboxes: null },
  }));
  await f.work.reconcile();
  assert.equal((await f.readWork())!.transition_pending, true);
  assert.equal((await f.readWork())!.last_error, 'Native reconciliation is pending');
});

test('a receipt with another scope is never returned and its lease is fenced', async (t) => {
  const f = await fixture(t);
  f.onIssue(async () => {
    f.assignments.get('lease_one')!.account_id = 'other_account';
  });
  await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_scope_conflict' });
  assert.ok(f.tombstones.has('lease_one'));
});

test('lost issuance followed by release reconciles without ever learning a token ID', async (t) => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_unavailable' });
  assert.equal((await f.readAssignment())!.native_token_id, null);
  await f.state.transaction((tx) => f.work.revokeAssignment('lease_one', tx));
  await f.work.reconcile();
  assert.ok(f.tombstones.has('lease_one'));
  assert.ok((await f.readAssignment())!.revoked_at);
});

test('connection disconnection during issuance withholds the bearer and expired sessions never issue', async (t) => {
  const f = await fixture(t);
  const expired = f.session();
  expired.hardDeadline = new Date(Date.now() - 1_000).toISOString();
  await assert.rejects(f.work.launchConnections(expired), { code: 'sandbox_scope_conflict' });
  assert.equal(f.calls.length, 0);
  f.onIssue(() =>
    f.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE sandbox_native_connections SET revoked_at=? WHERE id='connection'",
        new Date().toISOString(),
      );
    }),
  );
  await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_scope_conflict' });
  assert.ok(f.tombstones.has('lease_one'));
});

test('a transition during resource enumeration cannot cancel the newly admitted attempt', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  f.onResources(() =>
    f.state.transaction((tx) =>
      f.work.transition('project', 'task', 'task_work', { attempt: '2' }, tx),
    ),
  );
  f.resources(() => ({
    namespace: 'ns_work',
    next: { workflows: null, jobs: null, sandboxes: null },
    sandboxes: [],
    jobs: [],
    workflows: [
      {
        id: 'new_attempt',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'new_token',
        attempt_ref: '2',
        admission_profile: 'execute',
        nodes: {},
      },
    ],
  }));
  await f.work.reconcile();
  assert.equal(f.calls.filter((c) => c.path.endsWith('/actions')).length, 0);
  assert.equal((await f.readWork())!.desired_attempt, '2');
  assert.equal((await f.readWork())!.transition_pending, true);
});

test('closing after an unknown work-creation reply recovers its stable grant before cleanup', async (t) => {
  const f = await fixture(t);
  f.loseWorkReply();
  await assert.rejects(f.work.launchConnections(f.session()), { code: 'sandbox_unavailable' });
  assert.equal((await f.readWork())!.native_grant_id, null);
  await f.state.transaction((tx) =>
    f.work.transition('project', 'task', 'task_work', { closed: true }, tx),
  );
  await f.work.reconcile();
  assert.equal(f.calls.filter((c) => c.path === '/v1/delegations/works').length, 2);
  assert.ok(
    f.calls.some((c) => c.path === '/v1/delegations/works/grant_work' && c.method === 'DELETE'),
  );
  assert.equal((await f.readWork())!.native_grant_id, 'grant_work');
  assert.equal((await f.readWork())!.transition_pending, false);
});

test('resource enumeration advances all three independent bounded cursors', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  f.resources((query) => {
    assert.equal(query.get('limit'), '100');
    const index = Number(query.get('sandboxes_after') ?? 0);
    return {
      namespace: 'ns_work',
      workflows: [],
      jobs: [],
      sandboxes: [{ id: `machine_${index}`, namespace: 'ns_work', state: 'stopped' }],
      next: { workflows: null, jobs: null, sandboxes: index < 2 ? String(index + 1) : null },
    };
  });
  const resources = await f.work.resources(
    (await f.readWork())!,
    await f.connections.get('connection'),
  );
  assert.deepEqual(
    resources.sandboxes.map((s) => s.id),
    ['machine_0', 'machine_1', 'machine_2'],
  );
});

test('reconciliation excludes revoked roots without retiring pending cleanup on authorized work', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  await f.state.transaction(async (tx) => {
    await tx.run(`INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at,revoked_at)
      SELECT 'revoked_connection',project_id,'revoked_root',account_id,member_id,credentials,connected_at,connected_at FROM sandbox_native_connections WHERE id='connection'`);
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,closed_at,transition_pending)
      VALUES('project','task','revoked_work','revoked_connection','old_grant','old_namespace',?,TRUE)`,
      new Date().toISOString(),
    );
    await f.work.transition('project', 'task', 'task_work', { closed: true }, tx);
  });
  const before = f.calls.length;
  await f.work.reconcile();
  assert.ok(
    f.calls.slice(before).some((c) => c.method === 'DELETE' && c.path.endsWith('/grant_work')),
  );
  assert.ok(f.calls.slice(before).every((c) => !c.path.includes('old_grant')));
  assert.equal((await f.readWork())!.transition_pending, false);
  const old = await f.state.read((sql) =>
    sql.get<NativeWorkRow>("SELECT * FROM sandbox_native_work WHERE work_id='revoked_work'"),
  );
  assert.equal(old!.evidence_checked_at, null);
  assert.equal(
    old!.transition_pending,
    true,
    'revoked work intent is preserved, not falsely completed',
  );
});

test('pending cleanup takes a bounded reconciliation slot ahead of ordinary evidence polls', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.session());
  await f.state.transaction(async (tx) => {
    for (let i = 0; i < 20; i++)
      await tx.run(
        `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,desired_attempt)
        VALUES('project','task',?,'connection',?,'ns_work','1')`,
        `ordinary_${i}`,
        `ordinary_grant_${i}`,
      );
    await f.work.transition('project', 'task', 'task_work', { closed: true }, tx);
    await tx.run(
      "UPDATE sandbox_native_work SET evidence_checked_at='2099-01-01' WHERE work_id='task_work'",
    );
  });
  await f.work.reconcile();
  assert.ok(
    f.calls.some(
      (call) => call.method === 'DELETE' && call.path === '/v1/delegations/works/grant_work',
    ),
  );
  assert.equal((await f.readWork())!.transition_pending, false);
});
