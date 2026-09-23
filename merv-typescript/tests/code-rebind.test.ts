import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { digest, type Caller, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';
import type { FaultPoint } from '@merv/code/store/operations';
import { codeStoreFixture, faultAt, git, gitSource } from './fixtures/code-store.js';

const OLD = 'operator-repository';
const NEW = 'operator-repository-two';
const definition: WorkflowDefinition = {
  name: 'build',
  version: 1,
  initial: 'building',
  states: ['building', 'built'],
  terminal: ['built'],
  edges: [{ from: 'building', action: 'finish', to: 'built' }],
};
const policy: WorkflowPolicy = {
  successStates: ['built'],
  actions: [
    {
      name: 'finish',
      tool: 'build.finish',
      states: ['building'],
      transitions: ['finish'],
      instruction: 'Finish the build.',
      check: () => {},
    },
  ],
};

/**
 * A project of its own signed-in administrator, bound and imported, whose repository holds the
 * two commits these tests move main between. The fixture's own project stays out of the way:
 * a rebind is one of the few things only a signed-in human may ask for.
 */
async function hosted(t: TestContext, fault?: (point: FaultPoint) => void) {
  const source = gitSource(t);
  const one = source.commit({ 'a.txt': 'one\n' });
  const two = source.commit({ 'a.txt': 'two\n' });
  const f = await codeStoreFixture(t);
  if (fault) await f.open({ fault });
  // A project of its own: the fixture's is bound to another identity and never imported, which
  // is exactly what the unhosted refusal wants it for.
  const principal = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://issuer.example.test',
    subject: 'rebinder',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await f.scope.createProject(principal, { name: 'Rebind', requestId: 'project' });
  const human = await f.scope.caller(principal, project.id);
  // The identity behind that administrator, for the key that must still be refused.
  await f.workflows.register(definition, policy);
  const paths = f.pathsOf(human.projectId);
  const bind = async (mainOid: string, expectedMainOid?: string) =>
    await f.code.bindLocal(human, {
      repositoryId: OLD,
      mainOid,
      ...(expectedMainOid ? { expectedMainOid } : {}),
      requestId: `bind-${mainOid.slice(0, 8)}`,
    });
  await bind(one);
  const bundle = source.bundle(two);
  const begun = await f.code.importRepository(human, {
    source: 'bundle',
    tip: two,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    requestId: 'import',
  });
  await f.code.v2!.putPart(human, begun.id, 0, bundle.content);
  await f.code.v2!.call(human, `uploads/${begun.id}/complete`, {});
  const write = async (sql: string, ...values: (string | null)[]) =>
    await f.state.transaction((tx) => tx.run(sql, ...(values as string[])));
  return {
    f,
    source,
    human,
    principal,
    one,
    two,
    bind,
    write,
    paths,
    marker: () => JSON.parse(readFileSync(paths.marker, 'utf8')) as Record<string, unknown>,
    binding: async () =>
      (await f.state.read((sql) =>
        sql.get<{ repository_id: string; binding_json: string; main_json: string }>(
          'SELECT repository_id,binding_json,main_json FROM code_projects WHERE project_id=?',
          human.projectId,
        ),
      ))!,
    result: async (id: string) =>
      JSON.parse(
        (await f.state.read((sql) =>
          sql.get<{ result_json: string }>(
            'SELECT result_json FROM code_operations WHERE id=?',
            id,
          ),
        ))!.result_json,
      ) as Record<string, unknown>,
    rebind: async (input: Record<string, unknown> = {}) =>
      await f.code.rebindRepository(human, {
        repositoryId: NEW,
        mainOid: two,
        reason: 'the operator renamed the repository',
        requestId: 'rebind',
        ...input,
      }),
    /** A declared unit of a workflow instance, so a dependent of it derives against it. */
    unit: async (requestId: string, dependsOn: string[] = []) => {
      const started = await f.workflows.start(human, { workflow: 'build', requestId, dependsOn });
      await f.state.transaction((tx) => f.code.declareUnit(human, started.id, tx));
      return started;
    },
    /** Carry an instance to its terminal state, so what depends on it is no longer waiting. */
    finish: async (instanceId: string, expectedRevision: number) =>
      await f.workflows.transition(human, {
        instanceId,
        expectedRevision,
        action: 'finish',
        input: {},
        requestId: `finish-${instanceId}`,
      }),
    /** One unit accepted under `repositoryId`, as its review transaction leaves the row. */
    accept: async (unitId: string, commit: string, repositoryId: string) => {
      const body = {
        formatVersion: 1,
        unitId,
        workflow: 'build',
        version: 1,
        terminalRevision: 2,
        submissionRef: 'submission',
        reviewRef: 'review',
        acceptedBy: human.actorId,
        code: {
          ref: { kind: 'session-final', sessionId: 'session' },
          commit,
          tree: null,
          repositoryId,
          reviewAttached: true,
        },
        storage: 'code',
        receipt: 'cop_receipt',
      };
      await write(
        'UPDATE code_units SET acceptance_json=?,acceptance_hash=?,accepted_at=? WHERE project_id=? AND unit_id=?',
        JSON.stringify(body),
        digest(body),
        new Date().toISOString(),
        human.projectId,
        unitId,
      );
    },
    /** A unit's base pin, as its first producing lease writes it: retained and immutable. */
    pin: async (unitId: string, reference: string) => {
      const body = {
        formatVersion: 1,
        kind: 'main',
        reference,
        repositoryId: OLD,
        dependencies: [],
        sources: [],
        main: { oid: reference, operationId: 'cop_fixture' },
      };
      await write(
        'UPDATE code_units SET base_json=?,base_hash=?,base_lease_id=?,based_at=? WHERE project_id=? AND unit_id=?',
        JSON.stringify(body),
        digest(body),
        'lease',
        new Date().toISOString(),
        human.projectId,
        unitId,
      );
    },
    /** A consolidation@5 round's acceptance: its own immutable table, never the unit row. */
    reviewed: async (unitId: string, reviewId: string, commit: string) =>
      await write(
        'INSERT INTO code_review_acceptances (project_id,unit_id,review_id,acceptance_json,accepted_at) VALUES (?,?,?,?,?)',
        human.projectId,
        unitId,
        reviewId,
        JSON.stringify({
          formatVersion: 1,
          unitId,
          code: { commit, tree: null, repositoryId: OLD, reviewAttached: true },
          storage: 'code',
        }),
        new Date().toISOString(),
      ),
    /**
     * A live session of this project offered by somebody else entirely — an actor credential,
     * an mk_ key, another administrator — which is the ordinary case: a leased worker is never
     * owned by the human who rebinds. `owner_hash` is what `sessions.list` filters on, so it is
     * deliberately a value this administrator's credential could never digest to.
     */
    offered: async (sessionId: string, driver: string | null) => {
      const issued = await f.scope.issueActor(human, { name: sessionId, role: 'producer' });
      await write(
        'INSERT INTO worker_sessions (id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        sessionId,
        human.projectId,
        issued.actor.id,
        sessionId,
        '1',
        'another-source-authority',
        'runner-1',
        sessionId,
        `token-${sessionId}`,
        'fingerprint',
        'active',
        JSON.stringify({
          id: sessionId,
          execution: {
            policy: {
              readOnly: true,
              tools: [],
              ...(driver ? { workspace: { mode: 'read', driver } } : {}),
            },
          },
        }),
      );
    },
    blockers: async (instanceId: string) =>
      (await f.code.status(human)).blockers
        .filter((blocker) => blocker.instanceId === instanceId)
        .map((blocker) => blocker.key),
  };
}

test('a rebind proves Code holds the history, retains what it leaves and keeps the acceptances made under it', async (t) => {
  const h = await hosted(t);
  const dependency = await h.unit('dependency');
  await h.finish(dependency.id, dependency.revision);
  await h.accept(dependency.id, h.two, OLD);
  const waiter = await h.unit('waiter', [dependency.id]);
  assert.deepEqual(
    await h.blockers(waiter.id),
    [],
    'the acceptance is this project’s before the rebind',
  );

  const operation = await h.rebind();
  assert.deepEqual(
    [operation.kind, operation.status, operation.error],
    ['rebind', 'completed', null],
  );
  const bound = await h.binding();
  assert.equal(bound.repository_id, NEW);
  const binding = JSON.parse(bound.binding_json) as {
    boundBy: string;
    proof: string;
    previous: { repositoryId: string; reason: string; reboundBy: string }[];
  };
  assert.deepEqual(
    [binding.previous.length, binding.previous[0].repositoryId, binding.previous[0].reason],
    [1, OLD, 'the operator renamed the repository'],
  );
  assert.equal(binding.previous[0].reboundBy, h.human.actorId);
  const main = JSON.parse(bound.main_json) as Record<string, unknown>;
  assert.deepEqual(
    [main.oid, main.stored, main.admittedBy, main.operationId],
    [h.two, true, h.human.actorId, operation.id],
  );

  const proof = (await h.result(operation.id)) as unknown as {
    repositoryId: string;
    previousRepositoryId: string;
    mainAhead: boolean;
    refs: { kind: string; oid: string }[];
    markerIds: string[];
  };
  assert.deepEqual(
    [proof.repositoryId, proof.previousRepositoryId, proof.mainAhead, proof.markerIds],
    [NEW, OLD, true, [OLD, NEW]],
  );
  assert.equal(binding.proof, digest(proof));
  assert.ok(
    proof.refs.some((ref) => ref.kind === 'main') &&
      proof.refs.some((ref) => ref.kind === 'accepted'),
    'main and the accepted commit are both proved',
  );

  const listed = { format: 2, projectId: h.human.projectId, repositoryIds: [OLD, NEW] };
  assert.deepEqual(h.marker(), listed);
  const status = await h.f.code.status(h.human);
  assert.equal(status.project!.repositoryId, NEW);
  assert.deepEqual(
    status.project!.previous.map((entry) => entry.repositoryId),
    [OLD],
  );
  assert.deepEqual(
    await h.blockers(waiter.id),
    [],
    'an acceptance made under the repository that was left is still this project’s',
  );

  const rebound = (
    await h.f.state.read((sql) =>
      sql.all<{ data_json: string }>(
        "SELECT data_json FROM events WHERE project_id=? AND type='code.repository_rebound'",
        h.human.projectId,
      ),
    )
  ).map((event) => JSON.parse(event.data_json) as { previousRepositoryId: string });
  assert.deepEqual([rebound.length, rebound[0]?.previousRepositoryId], [1, OLD]);

  // The same request replays the stored operation and writes nothing twice.
  assert.deepEqual(await h.rebind(), operation);
  assert.deepEqual(await h.binding(), bound);
  assert.deepEqual(h.marker(), listed);
  await assert.rejects(h.rebind({ reason: 'another reason' }), { code: 'request_conflict' });

  // A second rebind grows the lineage the trigger compares entry for entry, and the marker
  // is rewritten from what the binding row holds rather than from what the file already had.
  const THIRD = 'operator-repository-three';
  assert.equal(
    (await h.rebind({ repositoryId: THIRD, requestId: 'rebind-two' })).status,
    'completed',
  );
  assert.deepEqual(
    (
      JSON.parse((await h.binding()).binding_json) as {
        previous: { repositoryId: string }[];
      }
    ).previous.map((entry) => entry.repositoryId),
    [OLD, NEW],
  );
  assert.deepEqual(h.marker(), {
    format: 2,
    projectId: h.human.projectId,
    repositoryIds: [OLD, NEW, THIRD],
  });
  assert.deepEqual(
    await h.blockers(waiter.id),
    [],
    'an acceptance made two repositories ago is still this project’s',
  );

  // A repository this project was never bound to is still foreign.
  await h.finish(waiter.id, (await h.f.workflows.get(h.human, waiter.id)).revision);
  await h.accept(waiter.id, h.two, 'never-bound');
  const stranger = await h.unit('stranger', [waiter.id]);
  assert.deepEqual(await h.blockers(stranger.id), [`acceptance:${waiter.id}`]);
});

test('a rebind refuses what it cannot prove, what it would not change and the main it would drop', async (t) => {
  const h = await hosted(t);
  const before = await h.binding();

  await assert.rejects(h.rebind({ repositoryId: OLD }), { code: 'code_rebind_unchanged' });
  // An operator key has the project authority and is still refused; a leased session does
  // not even have the authority, so it is refused before that.
  const issued = await h.f.scope.createKey(h.principal, { projectId: h.human.projectId });
  const key = await h.f.scope.caller({
    kind: 'key',
    key: await h.f.scope.authenticateKey(issued.token),
  });
  const asked = (caller: Caller, requestId: string) =>
    h.f.code.rebindRepository(caller, {
      repositoryId: NEW,
      mainOid: h.two,
      reason: 'not a signed-in administrator',
      requestId,
    });
  await assert.rejects(asked(key, 'key'), { code: 'code_human_required', status: 403 });
  await assert.rejects(asked({ ...h.human, session: { id: 'session' } } as Caller, 'session'), {
    status: 403,
  });
  // The fixture's own project is bound but was never imported.
  await assert.rejects(
    h.f.code.rebindRepository(await h.f.human(), {
      repositoryId: NEW,
      mainOid: h.two,
      reason: 'unhosted',
      requestId: 'unhosted',
    }),
    { code: 'code_rebind_unhosted' },
  );

  // A retained commit Code does not hold names itself and stops everything.
  const unit = await h.unit('unit');
  await h.write('UPDATE code_units SET head_oid=? WHERE unit_id=?', 'c'.repeat(40), unit.id);
  await assert.rejects(h.rebind(), (error: Error & { code: string }) => {
    assert.equal(error.code, 'code_rebind_incomplete');
    assert.match(error.message, new RegExp(`work ${unit.id} ${'c'.repeat(40)}`));
    return true;
  });
  assert.deepEqual(await h.binding(), before, 'nothing was written');
  assert.deepEqual(h.marker(), {
    format: 1,
    projectId: h.human.projectId,
    repositoryId: OLD,
  });
  assert.equal(
    (await h.f.state.read((sql) =>
      sql.get<{ status: string }>(
        "SELECT status FROM code_operations WHERE project_id=? AND kind='rebind'",
        h.human.projectId,
      ),
    ))!.status,
    'prepared',
    'the operation stays prepared and re-verifies on the next call',
  );

  // A main Code does not hold is the same refusal, which is why the ancestry question
  // below can always be asked.
  await h.write('UPDATE code_units SET head_oid=NULL WHERE unit_id=?', unit.id);
  await assert.rejects(h.rebind({ mainOid: 'd'.repeat(40), requestId: 'unheld-main' }), {
    code: 'code_rebind_incomplete',
  });

  // A main that is not ahead of the one being left behind must be named exactly.
  await h.bind(h.two, h.one);
  await assert.rejects(
    h.rebind({ mainOid: h.one, requestId: 'back-one' }),
    (error: Error & { code: string }) => {
      assert.equal(error.code, 'code_rebind_main_diverged');
      assert.match(error.message, new RegExp(h.two));
      return true;
    },
  );
  await assert.rejects(
    h.rebind({ mainOid: h.one, acknowledgePreviousMain: h.one, requestId: 'back-two' }),
    { code: 'code_rebind_main_diverged' },
  );
  const done = await h.rebind({
    mainOid: h.one,
    acknowledgePreviousMain: h.two,
    requestId: 'back-three',
  });
  assert.equal(done.status, 'completed');
  const proof = await h.result(done.id);
  assert.deepEqual([proof.mainAhead, proof.acknowledgedPreviousMain], [false, h.two]);

  // An acceptance is immutable, so this one is made last: a commit it names and Code does
  // not hold refuses every rebind of this project from here on.
  await h.finish(unit.id, (await h.f.workflows.get(h.human, unit.id)).revision);
  await h.accept(unit.id, 'e'.repeat(40), NEW);
  await assert.rejects(
    h.rebind({ repositoryId: 'a-third-repository', requestId: 'after-acceptance' }),
    (error: Error & { code: string }) => {
      assert.equal(error.code, 'code_rebind_incomplete');
      assert.match(error.message, new RegExp(`accepted ${unit.id} ${'e'.repeat(40)}`));
      return true;
    },
  );
});

test('the proof covers base pins and the acceptances of reviewed consolidation rounds', async (t) => {
  const h = await hosted(t);
  // A pin is what a workspace starts from when a unit has no writer head, and its
  // reference is main as it stood when the pin was made — which code.local.bind is free to
  // move away from, so no other bucket of the proof holds it.
  const pinned = await h.unit('pinned');
  await h.pin(pinned.id, h.two);
  assert.equal((await h.rebind()).status, 'completed');
  assert.ok(
    ((await h.result((await h.rebind()).id)).refs as { kind: string; id: string }[]).some(
      (ref) => ref.kind === 'base-pin' && ref.id === pinned.id,
    ),
    'the pin is named in the proof the binding hashes',
  );

  // Both of these are immutable once written, so each refuses every rebind from here on.
  const stranded = await h.unit('stranded');
  await h.pin(stranded.id, 'f'.repeat(40));
  // A consolidation@5 acceptance never touches the unit row, and its commit is the one
  // that becomes main.
  await h.reviewed('round', 'review', 'g'.repeat(40));
  await assert.rejects(
    h.rebind({ repositoryId: 'a-third-repository', requestId: 'after-pin' }),
    (error: Error & { code: string }) => {
      assert.equal(error.code, 'code_rebind_incomplete');
      assert.match(error.message, new RegExp(`base-pin ${stranded.id} ${'f'.repeat(40)}`));
      assert.match(error.message, new RegExp(`accepted round:review ${'g'.repeat(40)}`));
      return true;
    },
  );
});

test('work in flight is named and refuses the rebind, and publication is neither fenced nor released', async (t) => {
  const h = await hosted(t);
  const busy = async (what: RegExp) =>
    await assert.rejects(h.rebind(), (error: Error & { code: string }) => {
      assert.equal(error.code, 'code_rebind_busy');
      assert.match(error.message, what);
      return true;
    });
  const unit = await h.unit('unit');
  const base = async (key: string, state: string, result: string | null, check: string) =>
    await h.write(
      'INSERT INTO code_bases (project_id,base_key,members_json,left_key,right_key,engine,state,result_json,check_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      h.human.projectId,
      key,
      '[]',
      'left',
      'right',
      'merge',
      state,
      result,
      check,
      'now',
      'now',
    );
  // Base records are retained, so each case moves one base in and out of flight rather
  // than making and removing rows.
  await base('base-unfinished', 'cancelled', null, 'none');
  await base(
    'base-checking',
    'resolved',
    `{"method":"auto","commit":"${h.two}","tree":null,"engine":"merge"}`,
    'none',
  );
  const move = async (key: string, column: 'state' | 'check_state', value: string) =>
    await h.write(
      `UPDATE code_bases SET ${column}=? WHERE project_id=? AND base_key=?`,
      value,
      h.human.projectId,
      key,
    );
  for (const state of ['queued', 'retry_wait', 'awaiting_resolution']) {
    await move('base-unfinished', 'state', state);
    await busy(/unfinished bases: 1 \(base-unfinished\)/);
    await move('base-unfinished', 'state', 'cancelled');
  }
  // A resolved base whose project check is executing in a rented machine counts too.
  await move('base-checking', 'check_state', 'running');
  await busy(/unfinished bases: 1 \(base-checking\)/);
  await move('base-checking', 'check_state', 'none');

  await h.write("UPDATE code_units SET writer_state='active' WHERE unit_id=?", unit.id);
  await busy(new RegExp(`open writer generations: 1 \\(${unit.id}\\)`));
  await h.write("UPDATE code_units SET writer_state='idle' WHERE unit_id=?", unit.id);

  // A leased worker is owned by whoever offered it, never by the administrator rebinding,
  // and its checkouts are worktrees of the cache the machine would re-key: the refusal is
  // by project or it is nothing. A session with no Code workspace holds none of it.
  await h.offered('session-elsewhere', null);
  await h.offered('session-holding', 'code.v2');
  await busy(/sessions holding a workspace: 1 \(session-holding\)/);
  await h.write("UPDATE worker_sessions SET status='released' WHERE id=?", 'session-holding');

  const operation = (id: string, kind: string, status: string) =>
    h.write(
      'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,error,completed_at,created_at,phase,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      h.human.projectId,
      'server',
      id,
      kind,
      'hash',
      '{}',
      status,
      status === 'failed' ? 'gone' : null,
      status === 'failed' ? 'now' : null,
      'now',
      'queued',
      'now',
    );
  await operation('cop_open', 'upload', 'prepared');
  await busy(/unfinished transfers: 1 \(cop_open\)/);
  await h.write(
    "UPDATE code_operations SET status='failed',error=?,completed_at=? WHERE id=?",
    'gone',
    'now',
    'cop_open',
  );

  // PublicationHost writes main_json with its own lock, so an unsettled publication and a
  // rebind are mutually exclusive and neither silently wins.
  await h.write(
    'INSERT INTO code_publications (proposal_id,project_id,record_json,binding_json,settled) VALUES (?,?,?,?,?)',
    'proposal-open',
    h.human.projectId,
    '{}',
    'null',
    '0',
  );
  await busy(/unsettled publications: 1 \(proposal-open\)/);
  await h.write('UPDATE code_publications SET settled=1 WHERE proposal_id=?', 'proposal-open');

  // A prepared mirror row is not a refusal: publication never gates anything.
  await operation('cop_mirror', 'mirror', 'prepared');
  const mirrors = async () =>
    Number(
      (await h.f.state.read((sql) =>
        sql.get<{ n: number | string }>(
          "SELECT COUNT(*) AS n FROM code_operations WHERE project_id=? AND kind='mirror'",
          h.human.projectId,
        ),
      ))!.n,
    );
  const github = async () =>
    await h.f.state.read((sql) =>
      sql.get<{ revision: number }>(
        'SELECT revision FROM code_github WHERE project_id=?',
        h.human.projectId,
      ),
    );
  const [connection, mirrored] = [await github(), await mirrors()];
  const done = await h.rebind();
  assert.equal(done.status, 'completed');
  assert.deepEqual(await github(), connection, 'a rebind never touches the GitHub connection');
  assert.equal(await mirrors(), mirrored, 'and enqueues nothing to publish');
});

test('an unfinished rebind is superseded rather than standing in the way', async (t) => {
  const h = await hosted(t);
  const unit = await h.unit('unit');
  await h.write('UPDATE code_units SET head_oid=? WHERE unit_id=?', 'c'.repeat(40), unit.id);
  await assert.rejects(h.rebind(), { code: 'code_rebind_incomplete' });
  const stale = (await h.f.state.read((sql) =>
    sql.get<{ id: string }>(
      "SELECT id FROM code_operations WHERE project_id=? AND kind='rebind'",
      h.human.projectId,
    ),
  ))!.id;
  // While it sits there the binding is writable at all, so an operator has to be able to
  // see that the window is open and who opened it: it is read with the transfers.
  const operations = async () =>
    (await h.f.code.status(h.human)).operations.map((operation) => [
      operation.id,
      operation.kind,
      operation.status,
      operation.error,
    ]);
  assert.deepEqual(await operations(), [[stale, 'rebind', 'prepared', null]]);

  await h.write('UPDATE code_units SET head_oid=NULL WHERE unit_id=?', unit.id);
  assert.equal((await h.rebind({ requestId: 'second' })).status, 'completed');
  const superseded = (await h.f.state.read((sql) =>
    sql.get<{ status: string; error: string }>(
      'SELECT status,error FROM code_operations WHERE id=?',
      stale,
    ),
  ))!;
  assert.deepEqual([superseded.status, superseded.error], ['failed', 'code_rebind_superseded']);
  assert.deepEqual(await operations(), [[stale, 'rebind', 'failed', 'code_rebind_superseded']]);
});

test('the marker is appended before the transaction, so a crash between them replays', async (t) => {
  const h = await hosted(t, faultAt('after_rebind_marker'));
  const listed = { format: 2, projectId: h.human.projectId, repositoryIds: [OLD, NEW] };
  await assert.rejects(h.rebind());
  assert.deepEqual(h.marker(), listed);
  assert.equal((await h.binding()).repository_id, OLD, 'the binding was not written');
  // The same request re-verifies and applies exactly once; the marker gains nothing.
  assert.equal((await h.rebind()).status, 'completed');
  assert.equal((await h.binding()).repository_id, NEW);
  assert.deepEqual(h.marker(), listed);
});

test('the binding trigger admits only the write its own prepared operation names', async (t) => {
  const h = await hosted(t);
  const refused = async (repositoryId: string, operationId: string, previous: number) =>
    await assert.rejects(
      h.write(
        'UPDATE code_projects SET repository_id=?,binding_json=? WHERE project_id=?',
        repositoryId,
        JSON.stringify({
          boundBy: 'x',
          boundAt: 'now',
          operationId,
          previous: Array.from({ length: previous }, () => ({ repositoryId: OLD })),
        }),
        h.human.projectId,
      ),
      /immutable|retained|constraint/i,
      `${repositoryId} ${operationId} ${previous}`,
    );
  const journal = async (id: string, projectId: string, status: string, repositoryId: string) =>
    await h.write(
      'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,completed_at,created_at,phase,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      projectId,
      'actor:x',
      id,
      'rebind',
      'hash',
      JSON.stringify({ format: 1, source: 'rebind', actorId: 'x', repositoryId }),
      status,
      status === 'completed' ? '{}' : null,
      status === 'completed' ? 'now' : null,
      'now',
      'verifying',
      'now',
    );
  const other = await h.f.scope.createProject(
    await h.f.scope.acceptVerifiedIdentity({
      issuer: 'https://issuer.example.test',
      subject: 'other',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    { name: 'Other', requestId: 'other' },
  );
  await journal('cop_done', h.human.projectId, 'completed', NEW);
  await journal('cop_foreign', other.id, 'prepared', NEW);
  await journal('cop_ready', h.human.projectId, 'prepared', NEW);
  // No operation, a completed one, and one of another project.
  for (const operationId of ['cop_absent', 'cop_done', 'cop_foreign'])
    await refused(NEW, operationId, 1);
  // A prepared operation of this project, but another value than it was journalled with.
  await refused('third-repository', 'cop_ready', 1);
  // A lineage that does not grow by exactly one.
  for (const previous of [0, 2]) await refused(NEW, 'cop_ready', previous);
  // Identity is refused unconditionally; limits_json carries the check spec and stays open.
  for (const sql of [
    "UPDATE code_projects SET mode='other' WHERE project_id=?",
    "UPDATE code_projects SET project_id='moved' WHERE project_id=?",
  ])
    await assert.rejects(h.write(sql, h.human.projectId), /immutable|retained|constraint/i, sql);
  await h.write(
    'UPDATE code_projects SET limits_json=? WHERE project_id=?',
    '{"format":1,"denyGlobs":[],"secretExemptGlobs":[],"check":null}',
    h.human.projectId,
  );
  // And the one write that operation does name is taken.
  await h.write(
    'UPDATE code_projects SET repository_id=?,binding_json=? WHERE project_id=?',
    NEW,
    JSON.stringify({
      boundBy: 'x',
      boundAt: 'now',
      operationId: 'cop_ready',
      previous: [{ repositoryId: OLD }],
    }),
    h.human.projectId,
  );
  assert.equal((await h.binding()).repository_id, NEW);
});

test('the marker says which identities a directory serves, and a rebind clears the memo', async (t) => {
  const h = await hosted(t);
  // The project was already validated in this process, which the rebind has to undo, or
  // no Git operation of it would ever read the identity it just wrote.
  assert.equal((await h.rebind()).status, 'completed');
  const third = h.source.commit({ 'a.txt': 'three\n' });
  const bundle = h.source.bundle(third, [h.two]);
  const deliver = async (requestId: string) => {
    const begun = await h.f.code.importRepository(h.human, {
      source: 'bundle',
      tip: third,
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
      requestId,
    });
    await h.f.code.v2!.putPart(h.human, begun.id, 0, bundle.content);
    return (
      (await h.f.code.v2!.call(h.human, `uploads/${begun.id}/complete`, {})) as {
        operation: { status: string };
      }
    ).operation;
  };
  assert.equal((await deliver('after-rebind')).status, 'completed');
  assert.equal(git(h.paths.repository, ['cat-file', '-t', third]), 'commit');

  // A marker that does not list the identity asked for, carries an extra key, or belongs
  // to another project, is foreign — and a fresh process is what reads it again.
  const listed = h.marker();
  let attempt = 0;
  for (const written of [
    { format: 2, projectId: h.human.projectId, repositoryIds: [OLD] },
    { format: 2, projectId: h.human.projectId, repositoryIds: [OLD, NEW], extra: 1 },
    { format: 1, projectId: 'another-project', repositoryId: NEW },
  ]) {
    writeFileSync(h.paths.marker, JSON.stringify(written));
    await h.f.open();
    await assert.rejects(deliver(`foreign-${++attempt}`), { code: 'code_repository_foreign' });
  }
  writeFileSync(h.paths.marker, JSON.stringify(listed));
  await h.f.open();
  assert.equal((await deliver('accepted-again')).status, 'completed');
});
