import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  MervError,
  type Scope,
  type StoredEvent,
  type Transaction,
  type Workflows,
  sha256Hex,
} from '@merv/contracts';
import type { WorkSession } from '@merv/sessions/types';
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
/** The instance columns Sandboxes reads; Workflows owns the real table. */
const WF_INSTANCES = `CREATE TABLE wf_instances (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  workflow TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open',
  revision INTEGER NOT NULL, data_json TEXT NOT NULL)`;
const transitionEvent = (
  workflow: string,
  id: string,
  revision: number,
  terminal = false,
): StoredEvent => ({
  id: 0,
  projectId: 'project',
  actorId: 'system:test',
  type: 'workflow.transition',
  subjectId: id,
  data: { workflow, revision, terminal },
  createdAt: new Date().toISOString(),
});
async function fixture(
  t: TestContext,
  { workflow = 'task', id = 'task_work', pinned = true } = {},
) {
  const state = await openState(':memory:');
  await state.migrate('native-work-test', nativeMigrations);
  t.after(() => state.close());
  await state.transaction(async (tx) => {
    await tx.run(WF_INSTANCES);
    await tx.run(
      'INSERT INTO wf_instances(id,project_id,workflow,revision,data_json) VALUES(?,?,?,1,?)',
      id,
      'project',
      workflow,
      JSON.stringify({ computeEpoch: '1' }),
    );
  });
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
        work_ref: body.work_ref,
        work_kind: body.work_kind,
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
        work_ref: id,
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
  /** Workflows' read of the instance, over the columns above. */
  const workflows = {
    relations: async (projectId: string, instanceId: string, tx: Transaction) => {
      const row = await tx.get<{ workflow: string; revision: number; data_json: string }>(
        'SELECT workflow,revision,data_json FROM wf_instances WHERE id=? AND project_id=?',
        instanceId,
        projectId,
      );
      return row ? { instance: { ...row, data: JSON.parse(row.data_json) } } : null;
    },
  } as unknown as Pick<Workflows, 'relations'>;
  const work = new NativeWorkService(state, connections, workflows);
  /** A move of the instance as Workflows commits it, delivered to the transition consumer. */
  const move = async (change: { attempt?: string; closed?: boolean }, tx: Transaction) => {
    const instance = (await tx.get<{ revision: number; data_json: string }>(
      'SELECT revision,data_json FROM wf_instances WHERE id=?',
      id,
    ))!;
    const data = {
      ...JSON.parse(instance.data_json),
      ...(change.attempt ? { computeEpoch: change.attempt } : {}),
    };
    await tx.run(
      'UPDATE wf_instances SET revision=?,data_json=? WHERE id=?',
      instance.revision + 1,
      JSON.stringify(data),
      id,
    );
    await work.transitioned(
      transitionEvent(workflow, id, instance.revision + 1, !!change.closed),
      tx,
    );
  };
  if (pinned)
    await state.transaction(async (tx) => {
      await work.pin('project', workflow, id, 'task', tx);
      await work.transitioned(transitionEvent(workflow, id, 1), tx);
    });
  /** A lease of any workflow now, its unit declaring the `task` kind unless it says otherwise:
   *  Sandboxes derives profile and epoch from it. */
  const leased = (
    lease = 'lease_one',
    {
      policy = { readOnly: false, workspace: { mode: 'persistent' } } as object,
      references = {} as Record<string, string>,
      revision = 1,
    } = {},
  ): WorkSession =>
    ({
      id: lease,
      projectId: 'project',
      instanceId: id,
      expectedRevision: revision,
      hardDeadline: new Date(Date.now() + 3_600_000).toISOString(),
      lease: { leaseId: lease, instanceId: id, projectId: 'project', workflow },
      execution: { workflow, policy, references: { computeKind: 'task', ...references } },
    }) as unknown as WorkSession;
  const readWork = () =>
    state.read((sql) =>
      sql.get<NativeWorkRow>('SELECT * FROM sandbox_native_work WHERE work_id=?', id),
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
    leased,
    move,
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
    await f.work.pin('project', 'task', 'task_work', 'task', tx);
    assert.equal((await f.readWork())!.connection_id, 'connection');
    assert.equal((await f.readWork())!.desired_attempt, '1');
    await tx.run("UPDATE sandbox_native_work SET namespace='ns_work' WHERE work_id='task_work'");
    await tx.run(
      "INSERT INTO sandbox_native_captures VALUES('connection','ns_work','wf','node','verified'),('connection','other','wf','node','unrelated')",
    );
    assert.deepEqual(await f.work.captures('project', 'task_work', tx), ['verified']);
    assert.deepEqual(await f.work.captures('other', 'task_work', tx), []);
    // An owner may ask for the captures of some attempts only; a row registered before captures
    // recorded their attempt answers for any.
    await tx.run(
      "INSERT INTO sandbox_native_captures VALUES('connection','ns_work','wf2','node','current','2'),('connection','ns_work','wf3','node','earlier','1')",
    );
    assert.deepEqual(await f.work.captures('project', 'task_work', tx, ['2']), [
      'current',
      'verified',
    ]);
  });
  assert.equal(f.calls.length, 0);
});

test('unknown assignment issuance retries the identical encrypted secret and hash, then handoff revokes only that lease', async (t) => {
  const f = await fixture(t),
    session = f.leased();
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
  const settled = f.calls.length;
  await f.work.reconcile();
  assert.equal(f.calls.length, settled, 'idle open work without a live lease is not polled');
  const next = await f.work.launchConnections(f.leased('lease_two'));
  assert.notEqual(next[0]!.bearer, first[0]!.bearer);
  assert.equal(f.calls.filter((c) => c.path === '/v1/delegations/works').length, 1);
  assert.equal((await f.readWork())!.closed_at, null);
});

test('open work at rest under a live assignment is reconciled every 30 s, not on every pass', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  await f.work.reconcile();
  assert.equal((await f.readWork())!.transition_pending, false);
  const rested = f.calls.length;
  await f.work.reconcile();
  assert.equal(f.calls.length, rested);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE sandbox_native_work SET evidence_checked_at=?',
      new Date(Date.now() - 31_000).toISOString(),
    ),
  );
  await f.work.reconcile();
  assert.ok(f.calls.length > rested);
});

test('lease tombstones fence credentials even before any native issuance row exists', async (t) => {
  const f = await fixture(t);
  await f.state.transaction((tx) => f.work.revokeAssignment('lease_one', tx));
  await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_scope_conflict' });
  assert.equal(f.calls.length, 0);
});

for (const reason of ['release', 'attempt', 'closed'] as const)
  test(`native issuance racing ${reason} is withheld and revoked`, async (t) => {
    const f = await fixture(t);
    f.onIssue(() =>
      f.state.transaction(async (tx) => {
        if (reason === 'release') await f.work.revokeAssignment('lease_one', tx);
        else await f.move(reason === 'closed' ? { closed: true } : { attempt: '2' }, tx);
      }),
    );
    await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_scope_conflict' });
    assert.ok(f.tombstones.has('lease_one'));
    assert.ok((await f.readAssignment())!.revoked_at);
  });

test('attempt reconciliation fences old assignments and cancels only old provenance while retaining warm machines', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  await f.state.transaction((tx) => f.move({ attempt: '2' }, tx));
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

test("a workflow that names no attempt is cancelled once its launching assignment's attempt is old", async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  await f.state.transaction((tx) => f.move({ attempt: '2' }, tx));
  f.resources(() => ({
    namespace: 'ns_work',
    next: { workflows: null, jobs: null, sandboxes: null },
    sandboxes: [],
    jobs: [],
    workflows: [
      {
        id: 'unnamed_old',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'token_lease_one',
        attempt_ref: null,
        admission_profile: 'execute',
        nodes: {},
      },
      {
        id: 'unknown_origin',
        namespace: 'ns_work',
        state: 'running',
        origin_grant_id: 'someone_else',
        attempt_ref: null,
        admission_profile: 'execute',
        nodes: {},
      },
    ],
  }));
  await f.work.reconcile();
  assert.deepEqual(
    f.calls.filter((c) => c.path.endsWith('/actions')).map((c) => c.body),
    [{ kind: 'workflow_cancel', id: 'unnamed_old' }],
  );
});

test('closure pages both streams, preserves finalizers, retries evidence independently, and confirms stopped machines', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  await f.state.transaction((tx) => f.move({ closed: true }, tx));
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
  // Evidence that fails with nothing else in flight is retried as resting work is, not on every
  // pass: one that can never register is not polled for ever.
  assert.equal((await f.readWork())!.last_error, 'Native evidence registration is pending');
  const tried = published.length;
  await f.work.reconcile();
  assert.equal(published.length, tried, 'not retried before it is due');
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE sandbox_native_work SET evidence_checked_at=? WHERE work_id='task_work'",
      new Date(Date.now() - 31_000).toISOString(),
    ),
  );
  failEvidence = false;
  await f.work.reconcile();
  assert.equal((await f.readWork())!.transition_pending, false);
  assert.equal((await f.readWork())!.last_error, null);
  const callCount = f.calls.length;
  await f.work.reconcile();
  assert.equal(f.calls.length, callCount, 'confirmed closed work no longer polls');
});

test('repeated pagination cursors cannot falsely confirm cleanup', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  await f.state.transaction((tx) => f.move({ closed: true }, tx));
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
  await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_scope_conflict' });
  assert.ok(f.tombstones.has('lease_one'));
});

test('a transient database failure after issuance keeps the lease, and a retry reuses it', async (t) => {
  const f = await fixture(t),
    session = f.leased();
  const transaction = f.state.transaction.bind(f.state);
  let fail = false;
  f.state.transaction = ((fn: never) => {
    if (!fail) return transaction(fn);
    fail = false;
    return Promise.reject(new MervError('state_timeout', 'Database operation timed out', 503));
  }) as typeof f.state.transaction;
  f.onIssue(async () => {
    fail = true;
  });
  await assert.rejects(f.work.launchConnections(session), { code: 'state_timeout' });
  assert.ok(!f.tombstones.has('lease_one'));
  assert.equal((await f.readAssignment())!.revoke_pending, false);
  f.onIssue(async () => {});
  const [granted] = await f.work.launchConnections(session);
  assert.equal(
    sha256Hex(granted!.bearer),
    (f.assignments.get('lease_one') as unknown as { token_hash: string }).token_hash,
  );
  assert.equal((await f.readAssignment())!.native_token_id, 'token_lease_one');
});

test('lost issuance followed by release reconciles without ever learning a token ID', async (t) => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_unavailable' });
  assert.equal((await f.readAssignment())!.native_token_id, null);
  await f.state.transaction((tx) => f.work.revokeAssignment('lease_one', tx));
  await f.work.reconcile();
  assert.ok(f.tombstones.has('lease_one'));
  assert.ok((await f.readAssignment())!.revoked_at);
});

test('connection disconnection during issuance withholds the bearer and expired sessions never issue', async (t) => {
  const f = await fixture(t);
  const expired = f.leased();
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
  await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_scope_conflict' });
  assert.ok(f.tombstones.has('lease_one'));
});

test('a transition during resource enumeration cannot cancel the newly admitted attempt', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased());
  f.onResources(() => f.state.transaction((tx) => f.move({ attempt: '2' }, tx)));
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
  await assert.rejects(f.work.launchConnections(f.leased()), { code: 'sandbox_unavailable' });
  assert.equal((await f.readWork())!.native_grant_id, null);
  await f.state.transaction((tx) => f.move({ closed: true }, tx));
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
  await f.work.launchConnections(f.leased());
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
  await f.work.launchConnections(f.leased());
  await f.state.transaction(async (tx) => {
    await tx.run(`INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at,revoked_at)
      SELECT 'revoked_connection',project_id,'revoked_root',account_id,member_id,credentials,connected_at,connected_at FROM sandbox_native_connections WHERE id='connection'`);
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,closed_at,transition_pending)
      VALUES('project','task','revoked_work','revoked_connection','old_grant','old_namespace',?,TRUE)`,
      new Date().toISOString(),
    );
    await f.move({ closed: true }, tx);
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
  await f.work.launchConnections(f.leased());
  await f.state.transaction(async (tx) => {
    for (let i = 0; i < 20; i++)
      await tx.run(
        `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,desired_attempt)
        VALUES('project','task',?,'connection',?,'ns_work','1')`,
        `ordinary_${i}`,
        `ordinary_grant_${i}`,
      );
    await f.move({ closed: true }, tx);
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

test('work that fails on every pass takes its turn by age, and never starves the rest', async (t) => {
  const f = await fixture(t);
  // The resting work: a live assignment, reconciled once, then due again 31 s later.
  await f.work.launchConnections(f.leased());
  await f.work.reconcile();
  assert.equal((await f.readWork())!.transition_pending, false);
  // Twenty works whose every pass fails: the native service answers them with another work's
  // assignments.
  await f.state.transaction(async (tx) => {
    for (let i = 0; i < 20; i++)
      await tx.run(
        `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,native_grant_id,namespace,desired_attempt,transition_pending)
        VALUES('project','task',?,'connection',?,'ns_work','1',TRUE)`,
        `big_${i}`,
        `big_grant_${i}`,
      );
  });
  await f.work.reconcile();
  const failing = await f.state.read((sql) =>
    sql.all<NativeWorkRow>("SELECT * FROM sandbox_native_work WHERE work_id LIKE 'big_%'"),
  );
  assert.ok(failing.every((row) => row.transition_pending && row.last_error));
  // The resting work comes due: it has waited longer than any failing work, so it has its turn.
  const due = new Date(Date.now() - 31_000).toISOString();
  await f.state.transaction((tx) =>
    tx.run("UPDATE sandbox_native_work SET evidence_checked_at=? WHERE work_id='task_work'", due),
  );
  await f.work.reconcile();
  assert.ok(Date.parse((await f.readWork())!.evidence_checked_at!) > Date.parse(due));
});

test('any workflow gets compute: a reflection-like lease is pinned on first launch, checks, and is sent as the kind it declares', async (t) => {
  const f = await fixture(t, { workflow: 'reflection.lens', id: 'lens_work', pinned: false });
  assert.equal(await f.readWork(), undefined);
  const [connection] = await f.work.launchConnections(
    f.leased('lease_one', { policy: { readOnly: false, tools: [] } }),
  );
  assert.equal(connection!.name, 'sandboxes');
  const work = (await f.readWork())!;
  assert.equal(work.work_kind, 'reflection.lens');
  assert.equal(work.native_kind, 'task');
  assert.equal(work.connection_id, 'connection');
  assert.equal(work.desired_attempt, '1');
  assert.equal(work.epoch_revision, 1);
  const created = f.calls.find((c) => c.path === '/v1/delegations/works')!;
  assert.deepEqual(created.body, { work_ref: 'lens_work', work_kind: 'task' });
  const issued = f.calls.find((c) => c.path.endsWith('/assignments') && c.method === 'POST')!;
  assert.equal(issued.body!.profile, 'check');
  assert.equal(issued.body!.attempt_ref, '1');
  assert.equal((await f.readAssignment())!.work_kind, 'reflection.lens');
  // A second lease reuses the pinned work and its grant.
  await f.work.launchConnections(f.leased('lease_two'));
  assert.equal(f.calls.filter((c) => c.path === '/v1/delegations/works').length, 1);
  assert.equal((await f.readAssignment('lease_two'))!.profile, 'execute');
});

test('a unit can withhold compute, an unfunded project gets none, and a stale lease is refused', async (t) => {
  const f = await fixture(t, { workflow: 'task', id: 'service_task', pinned: false });
  assert.deepEqual(
    await f.work.launchConnections(
      f.leased('lease_one', { references: { computeProfile: 'none' } }),
    ),
    [],
  );
  assert.equal(await f.readWork(), undefined);
  // A unit binds compute only by declaring its native kind.
  const undeclared = f.leased('lease_undeclared');
  delete (undeclared.execution.references as Record<string, unknown>).computeKind;
  assert.deepEqual(await f.work.launchConnections(undeclared), []);
  assert.equal(await f.readWork(), undefined);
  await assert.rejects(
    f.work.launchConnections(f.leased('lease_bad', { references: { computeKind: 'not a kind' } })),
    { code: 'sandbox_scope_conflict' },
  );
  assert.equal(await f.readWork(), undefined);
  await assert.rejects(f.work.launchConnections(f.leased('lease_two', { revision: 2 })), {
    code: 'sandbox_scope_conflict',
  });
  assert.equal(await f.readWork(), undefined);
  await f.state.transaction((tx) =>
    tx.run("UPDATE sandbox_native_projects SET connection_id=NULL WHERE project_id='project'"),
  );
  assert.deepEqual(await f.work.launchConnections(f.leased('lease_three')), []);
  assert.equal(await f.readWork(), undefined);
  assert.equal(f.calls.length, 0);
});

test('a session offered before units declared a kind keeps the compute its pinned work has', async (t) => {
  const f = await fixture(t, { workflow: 'experiment', id: 'old_work' });
  await f.state.transaction((tx) =>
    tx.run("UPDATE sandbox_native_work SET native_kind='experiment' WHERE work_id='old_work'"),
  );
  const old = f.leased();
  delete (old.execution.references as Record<string, unknown>).computeKind;
  const [connection] = await f.work.launchConnections(old);
  assert.equal(connection!.name, 'sandboxes');
  const created = f.calls.find((c) => c.path === '/v1/delegations/works')!;
  assert.deepEqual(created.body, { work_ref: 'old_work', work_kind: 'experiment' });
  assert.equal((await f.readAssignment())!.work_kind, 'experiment');
});

test('the compute epoch follows computeEpoch: a retry keeps access, a new epoch fences it, a replay never rolls it back', async (t) => {
  const f = await fixture(t);
  await f.work.launchConnections(f.leased('lease_one'));
  await f.state.transaction((tx) =>
    tx.run('UPDATE sandbox_native_work SET transition_pending=FALSE'),
  );
  // retry_running: a new revision with the same epoch.
  await f.state.transaction((tx) => f.move({ attempt: '1' }, tx));
  let work = (await f.readWork())!;
  assert.equal(work.desired_attempt, '1');
  assert.equal(work.epoch_revision, 2);
  assert.equal(work.transition_pending, false);
  await f.work.reconcile();
  assert.equal((await f.readAssignment())!.revoked_at, null);
  await f.state.transaction((tx) => f.move({ attempt: '2:running' }, tx));
  work = (await f.readWork())!;
  assert.equal(work.desired_attempt, '2:running');
  assert.equal(work.transition_pending, true);
  await f.work.reconcile();
  assert.ok((await f.readAssignment())!.revoked_at);
  // Replaying every event from the beginning leaves the work where the instance stands.
  for (const revision of [1, 2, 3])
    await f.state.transaction((tx) =>
      f.work.transitioned(
        {
          id: revision,
          projectId: 'project',
          actorId: 'system:test',
          type: 'workflow.transition',
          subjectId: 'task_work',
          data: { workflow: 'task', revision, terminal: false },
          createdAt: new Date().toISOString(),
        },
        tx,
      ),
    );
  assert.equal((await f.readWork())!.desired_attempt, '2:running');
  // Without computeEpoch the epoch is the revision.
  await f.state.transaction((tx) =>
    tx.run("UPDATE wf_instances SET data_json='{}' WHERE id='task_work'"),
  );
  await f.state.transaction((tx) => f.move({}, tx));
  assert.equal((await f.readWork())!.desired_attempt, '4');
});

test('the transition consumer closes work only on the terminal move that stands, or when the instance is gone', async (t) => {
  const f = await fixture(t);
  const event = (revision: number, terminal: boolean, subjectId = 'task_work'): StoredEvent => ({
    id: revision,
    projectId: 'project',
    actorId: 'system:test',
    type: 'workflow.transition',
    subjectId,
    data: { workflow: 'task', revision, terminal },
    createdAt: new Date().toISOString(),
  });
  await f.state.transaction((tx) => f.move({ attempt: '2' }, tx));
  await f.state.transaction((tx) => f.work.transitioned(event(1, true), tx));
  assert.equal((await f.readWork())!.closed_at, null);
  // Unpinned instances and other workflows are not Sandboxes' to touch.
  await f.state.transaction((tx) => f.work.transitioned(event(1, true, 'unpinned'), tx));
  assert.equal(
    await f.state.read((sql) =>
      sql.get('SELECT 1 FROM sandbox_native_work WHERE work_id=?', 'unpinned'),
    ),
    undefined,
  );
  await f.state.transaction((tx) => f.move({ closed: true }, tx));
  const closed = (await f.readWork())!;
  assert.ok(closed.closed_at);
  assert.equal(closed.transition_pending, true);
  await f.state.transaction((tx) => f.work.transitioned(event(3, true), tx));
  assert.equal((await f.readWork())!.closed_at, closed.closed_at);

  const g = await fixture(t);
  await g.state.transaction(async (tx) => {
    await tx.run("DELETE FROM wf_instances WHERE id='task_work'");
    await g.work.transitioned(event(2, false), tx);
  });
  assert.ok((await g.readWork())!.closed_at);
});

test('the session.closed consumer revokes that lease, fences one still issuing, and skips old history', async (t) => {
  const f = await fixture(t);
  const closed = (lease: string, at = new Date()): StoredEvent => ({
    id: 1,
    projectId: 'project',
    actorId: 'system:sessions',
    type: 'session.closed',
    subjectId: lease,
    data: { sessionId: lease },
    createdAt: at.toISOString(),
  });
  await f.work.launchConnections(f.leased('lease_one'));
  await f.state.transaction((tx) => f.work.sessionClosed(closed('lease_one'), tx));
  assert.equal((await f.readAssignment())!.revoke_pending, true);
  await f.work.reconcile();
  assert.ok(f.tombstones.has('lease_one'));
  assert.ok((await f.readAssignment())!.revoked_at);
  // A lease that closed before its issuance committed can never be issued.
  await f.state.transaction((tx) => f.work.sessionClosed(closed('lease_two'), tx));
  await assert.rejects(f.work.launchConnections(f.leased('lease_two')), {
    code: 'sandbox_scope_conflict',
  });
  // Replayed history older than any lease adds no tombstone, and revokes what it did issue.
  const old = new Date(Date.now() - 30 * 24 * 3_600_000);
  await f.state.transaction(async (tx) => {
    await f.work.sessionClosed(closed('lease_ancient', old), tx);
    await f.work.sessionClosed(closed('lease_one', old), tx);
  });
  const tombstones = await f.state.read((sql) =>
    sql.all<{ lease_id: string }>('SELECT lease_id FROM sandbox_native_revoked_leases ORDER BY 1'),
  );
  assert.deepEqual(
    tombstones.map((row) => row.lease_id),
    ['lease_one', 'lease_two'],
  );
});

test('a lease still naming its scope in references is issued from its instance like any other', async (t) => {
  const f = await fixture(t);
  // The scope references leases carried before 2026-10-04 are no longer read: the profile,
  // connection and attempt come from the policy and the pinned work.
  const references = {
    sandboxConnectionId: 'another',
    sandboxWorkKind: 'experiment',
    sandboxWorkId: 'elsewhere',
    sandboxAttempt: '9',
    sandboxProfile: 'check',
  };
  const [issued] = await f.work.launchConnections(f.leased('lease_old', { references }));
  assert.ok(issued);
  const assignment = (await f.readAssignment('lease_old'))!;
  assert.equal(assignment.attempt_ref, '1');
  assert.equal(assignment.profile, 'execute');
  assert.equal(assignment.work_kind, 'task');
});

test('the declared kind is stored with the work, and the background reconcile sends it without a session', async (t) => {
  const f = await fixture(t, { workflow: 'experiment', id: 'exp_work', pinned: false });
  // The first launch pins the work but its work-creation reply is lost.
  f.loseWorkReply();
  await assert.rejects(
    f.work.launchConnections(f.leased('lease_one', { references: { computeKind: 'experiment' } })),
  );
  assert.equal((await f.readWork())!.native_kind, 'experiment');
  await f.work.reconcile();
  const created = f.calls.filter((c) => c.path === '/v1/delegations/works');
  assert.equal(created.length, 2);
  for (const call of created)
    assert.deepEqual(call.body, { work_ref: 'exp_work', work_kind: 'experiment' });
  assert.equal((await f.readWork())!.native_grant_id, 'grant_work');
});

test('migration 5 gives existing work the kind it was sent until then', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  await state.transaction(async (tx) => tx.run(WF_INSTANCES));
  await state.migrate('native-work-migration', nativeMigrations.slice(0, 4));
  await state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('connection','project','root','account','member','sealed','2026-10-01')`,
    );
    for (const [kind, id] of [
      ['task', 'a'],
      ['experiment', 'b'],
      ['reflection.lens', 'c'],
    ])
      await tx.run(
        'INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id) VALUES(?,?,?,?)',
        'project',
        kind,
        id,
        'connection',
      );
  });
  await state.migrate('native-work-migration', nativeMigrations);
  const rows = await state.read((sql) =>
    sql.all<NativeWorkRow>('SELECT * FROM sandbox_native_work ORDER BY work_id'),
  );
  assert.deepEqual(
    rows.map((row) => row.native_kind),
    ['task', 'experiment', 'task'],
  );
});

test('migration 3 accepts any workflow name and derives existing epochs from their instances', async (t) => {
  const state = await openState(':memory:');
  t.after(() => state.close());
  await state.transaction(async (tx) => tx.run(WF_INSTANCES));
  await state.migrate('native-work-migration', nativeMigrations.slice(0, 2));
  await state.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO sandbox_native_connections(id,project_id,root_id,account_id,member_id,credentials,connected_at)
      VALUES('connection','project','root','account','member','sealed','2026-10-01')`,
    );
    await tx.run(
      `INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id,desired_attempt)
      VALUES('project','experiment','exp','connection','1:running')`,
    );
    await tx.run(
      "INSERT INTO wf_instances(id,project_id,workflow,revision,data_json) VALUES('exp','project','experiment',7,'{}')",
    );
  });
  await state.migrate('native-work-migration', nativeMigrations);
  const row = await state.read((sql) =>
    sql.get<NativeWorkRow>("SELECT * FROM sandbox_native_work WHERE work_id='exp'"),
  );
  // The in-flight attempt is kept until the instance next moves.
  assert.equal(row!.desired_attempt, '1:running');
  assert.equal(row!.epoch_revision, 7);
  await state.transaction((tx) =>
    tx.run(
      "INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id) VALUES('project','reflection.lens','lens','connection')",
    ),
  );
  await assert.rejects(
    state.transaction((tx) =>
      tx.run(
        "INSERT INTO sandbox_native_work(project_id,work_kind,work_id,connection_id) VALUES('project','not a workflow','bad','connection')",
      ),
    ),
  );
});
