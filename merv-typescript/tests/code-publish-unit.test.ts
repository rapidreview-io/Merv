import { CodeService as CoreCodeService } from '@merv/code/service';
import { CodeUnitStore } from '@merv/code/units';
import { CodeService } from '@merv/code-work/service';
import type { CodeCapture } from '@merv/code-work/types';
import { CodeRepositories } from '@merv/code/store/repository';
import { WorkUnitRecords } from '@merv/code-work/unit-store';
import { CodeWriterService } from '@merv/code/writers';
import { createService, MervError } from '@merv/contracts';
import type { WorkflowSnapshot } from '@merv/workflows/models';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CodeBaseService } from '../packages/code-work/src/bases.js';
import { boundProject, codeConfig } from './fixtures/code-binding.js';
import { git, gitSource } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';
import { githubFixture } from './github-fixture.js';
import { assessment } from './fixtures/review-verdict.js';

/**
 * A project Code hosts, with its own repositories and the GitHub App faked at its seam, where
 * ordinary units of work are accepted and one of them publishes its accepted code to main.
 */
async function fixture(t: TestContext, connected = false, human = connected, importFailures = 0) {
  const f = await resolutionFixture(t, { human });
  const remote = connected ? await githubFixture(t, f.state, f.admin) : undefined;
  if (remote) await remote.enable();
  await f.sessions.dispatch.setDispatch(f.admin, { enabled: true });
  const root = join(f.directory, 'code');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'empty-template'));
  const repositories = new CodeRepositories({ root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 });
  await repositories.ensure(f.admin.projectId, 'repository', 'sha1');
  const branches = remote?.branches ?? new Map<string, string>();
  const legacyCore = await createService(
    new CoreCodeService(f.state, f.scope, codeConfig(join(f.directory, 'legacy-code'))),
  );
  const legacy = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, f.reviews, legacyCore),
  );
  await legacy.close();
  await legacyCore.close();
  const source = gitSource(t);
  const bare = repositories.paths(f.admin.projectId).repository;
  const root0 = source.commit({ 'shared.txt': 'root\n', 'own.txt': 'root\n' });
  const feature = source.commit({ 'own.txt': 'feature\n' });
  source.git('checkout', '--detach', root0);
  const moved = source.commit({ 'shared.txt': 'moved\n' });
  source.git('checkout', '--detach', root0);
  const clashing = source.commit({ 'own.txt': 'clashing\n' });
  const publish = (name: string, commit: string) =>
    source.git('push', bare, `${commit}:refs/heads/${name}`);
  for (const [name, commit] of Object.entries({ root0, feature, moved, clashing }))
    publish(name, commit);
  await boundProject(f.state, f.admin.projectId, root0, 'repository');
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: { root, quotaBytes: 10 * 1024 ** 3, reservedFreeBytes: 1 },
    }),
  );
  const code = await createService(
    new CodeService(
      f.state,
      f.scope,
      f.sessions,
      f.workflows,
      f.reviews,
      Object.assign(Object.create(core), { github: remote?.github ?? core.github }),
      {
        config: { settleMs: 60_000 },
        // GitHub's history is the source repository; the first `importFailures` fetches fail.
        remote: {
          read: async (_caller, use) =>
            use({
              url: importFailures-- > 0 ? join(source.directory, 'gone') : source.repository,
              protocol: 'file',
              repository: { id: 1, fullName: 'fixture/private' },
              env: {},
            }),
        },
        // The objects are in the real repository already; only the remote refs are played.
        mirror: {
          target: async () => ({ repository: 'fixture/private' }),
          lsRemote: async (_project: string, ref: string) =>
            branches.get(ref.replace('refs/heads/', '')) ?? null,
          push: async (_project: string, update: { ref: string; oid: string }) => {
            branches.set(update.ref.replace('refs/heads/', ''), update.oid);
            return 'ok' as const;
          },
        },
        mirrorConfig: { mirrorSeconds: 0 },
      },
    ),
  );
  const bases = (code as unknown as { baseStore: CodeBaseService }).baseStore;
  const setMain = async (oid: string) =>
    await f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
        JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: root0 }),
        JSON.stringify({
          oid,
          operationId: 'fixture',
          admittedBy: 'fixture',
          admittedAt: 'now',
          stored: true,
        }),
        f.admin.projectId,
      ),
    );
  await setMain(root0);
  branches.set('main', root0);
  const handle = await f.workflows.register(
    {
      name: 'input',
      version: 1,
      managed: true,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'accept', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'accept',
          tool: 'input.accept',
          instruction: 'Accept.',
          states: ['working'],
          transitions: ['accept'],
          check: () => {},
        },
      ],
    },
  );
  let sequence = 0;
  const id = () => `request-${++sequence}`;
  const producer = {
    projectId: f.admin.projectId,
    actorId: (await f.scope.credentials.issueActor(f.admin, { name: 'Producer', role: 'operator' }))
      .actor.id,
  };
  const captures = new Map<string, CodeCapture>();
  const original = code.capture.bind(code);
  t.mock.method(code, 'capture', async (...args: Parameters<CodeService['capture']>) =>
    args[1].kind === 'code-commit' && captures.has(args[1].commandId!)
      ? captures.get(args[1].commandId!)!
      : original(...args),
  );
  const declare = async (name: string, dependsOn: string[] = []) => {
    const work = await handle.start(f.admin, {
      workflow: 'input',
      dependsOn,
      requestId: id(),
      data: { title: name, goal: `Deliver ${name}` },
    });
    await f.state.transaction((tx) => code.declareUnit(f.admin, work.id, tx));
    return work;
  };
  const publishes = (work: WorkflowSnapshot) =>
    f.state.transaction((tx) => code.publishOnAcceptance(f.admin, { unitId: work.id }, tx));
  const pin = (work: WorkflowSnapshot) =>
    f.state.transaction((tx) =>
      code.pinBase(f.admin, { unitId: work.id, leaseId: `lease-${work.id}`, writer: false }, tx),
    );
  const move = (work: WorkflowSnapshot) =>
    handle.transition(f.admin, {
      instanceId: work.id,
      action: 'accept',
      expectedRevision: work.revision,
      requestId: `accept-${work.id}`,
    });
  const reviewed = async (work: WorkflowSnapshot) => {
    const evidence = await f.artifacts.create(producer, {
      title: 'Evidence',
      content: 'The delivered change was checked against its goal.',
    });
    const request = await f.reviews.request(producer, {
      subjectId: work.id,
      subjectRevision: work.revision,
      producerId: producer.actorId,
      artifactIds: [evidence.id],
      criteria: ['The change works.'],
      requestId: `review-${work.id}`,
    });
    const claim = await f.reviews.start(f.admin, request.id);
    await f.reviews.submit(f.admin, {
      reviewId: request.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Checked the delivered change.',
      ...assessment(claim),
      requestId: `pass-${request.id}`,
    });
    return request.id;
  };
  /**
   * Acceptance as a passing review leaves it: an admitted upload, then the owner's record.
   * `admitted: false` leaves out the upload, as a commit Code never admitted.
   */
  const accept = async (work: WorkflowSnapshot, commit: string, admitted = true) => {
    const commandId = `capture-${work.id}`;
    captures.set(commandId, {
      ref: { kind: 'code-commit', commandId },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: work.id,
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace: {
        repositoryId: 'repository',
        workspaceId: work.id,
        mode: 'persistent',
        branch: null,
        baseOid: root0,
        headOid: commit,
        treeOid: git(bare, ['rev-parse', `${commit}^{tree}`]),
        stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
      },
      observedAt: 'now',
      eventId: null,
    });
    const reviewId = await reviewed(work);
    const done = await move(work);
    if (admitted)
      await f.state.transaction(async (tx) => {
        await tx.run(
          "UPDATE code_workspaces SET generation=1,writer_state='closed',head_oid=? WHERE project_id=? AND unit_id=?",
          commit,
          f.admin.projectId,
          work.id,
        );
        await tx.run(
          "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
          commandId,
          f.admin.projectId,
          commandId,
          JSON.stringify({ head: commit }),
          work.id,
        );
      });
    return await f.state.transaction((tx) =>
      code.acceptUnit(
        f.admin,
        {
          unitId: work.id,
          terminalRevision: done.revision,
          submissionRef: commandId,
          reviewRef: reviewId,
          codeRef: { kind: 'code-commit', commandId },
          reviewSessionId: null,
        },
        tx,
      ),
    );
  };
  const blockers = async (unitId: string) =>
    (await f.workflows.blockers(f.admin, unitId)).filter((item) => item.provider === 'code');
  const sync = async () => {
    await f.state.transaction((tx) => tx.run("UPDATE code_publications SET synced_at=''"));
    return await code.syncPublications(f.admin);
  };
  const canary = () =>
    code.controlPublication(f.admin, {
      action: 'record_canary',
      staleMerged: false,
      reason: 'The release matrix passed with this App and its rules.',
      requestId: 'canary',
    });
  const unbind = f.bindCode(code);
  f.beforeClose.push(async () => {
    unbind();
    await code.close();
    await core.close();
    repositories.git.close();
  });
  return {
    ...f,
    code,
    bases,
    remote,
    branches,
    repositories,
    bare,
    source,
    root0,
    feature,
    moved,
    clashing,
    setMain,
    publishGitRef: publish,
    declare,
    publishes,
    pin,
    move,
    accept,
    blockers,
    sync,
    canary,
    id,
  };
}

test('a publishing unit takes its base from main as well as its dependencies', async (t) => {
  const f = await fixture(t);
  const dependency = await f.declare('Dependency');
  await f.accept(dependency, f.feature);

  // Main is still what the dependency was built on, so its commit already contains main
  // and there is nothing to merge: the base is that commit exactly.
  const contained = await f.declare('Contained', [dependency.id]);
  await f.publishes(contained);
  await f.bases.work(f.admin.projectId);
  const containedPin = await f.pin(contained);
  assert.equal(containedPin.reference, f.feature);
  assert.deepEqual(
    containedPin.sources.map((item) => item.unitId),
    [dependency.id],
  );

  // Main moves between the declaration and the first lease, so the pin takes the newer
  // main: derivation is repeated where the base is fixed, never trusted from before.
  const publishing = await f.declare('Publishing', [dependency.id]);
  await f.publishes(publishing);
  await f.bases.work(f.admin.projectId);
  await f.setMain(f.moved);
  await f.code.reconcileAll();
  assert.deepEqual(
    (await f.blockers(publishing.id)).map((item) => item.code),
    ['code_base_wait'],
  );
  await f.bases.work(f.admin.projectId);
  const pin = await f.pin(publishing);
  assert.equal(pin.kind, 'merged');
  assert.deepEqual(
    git(f.bare, ['rev-list', '--parents', '-n', '1', pin.reference]).split(' ').slice(1).sort(),
    [f.feature, f.moved].sort(),
  );
  // Main is not an acceptance, so it is never a source; the lineage records it separately.
  assert.deepEqual(
    pin.sources.map((item) => item.unitId),
    [dependency.id],
  );
  assert.ok(
    await f.state.read((sql) =>
      sql.get(
        'SELECT 1 FROM code_edges WHERE project_id=? AND source_ref=? AND target_ref=?',
        f.admin.projectId,
        `unit:${publishing.id}`,
        `main:${f.moved}`,
      ),
    ),
  );

  // A publishing unit with no dependency at all simply starts from main.
  const alone = await f.declare('Alone');
  await f.publishes(alone);
  const alonePin = await f.pin(alone);
  assert.equal(alonePin.kind, 'main');
  assert.equal(alonePin.reference, f.moved);
});

test('a clash with main is a resolution task like any other conflict', async (t) => {
  const f = await fixture(t);
  const dependency = await f.declare('Dependency');
  await f.accept(dependency, f.feature);
  await f.setMain(f.clashing);
  const publishing = await f.declare('Publishing', [dependency.id]);
  await f.publishes(publishing);
  await f.bases.work(f.admin.projectId);
  const record = await f.state.read((sql) =>
    f.bases.find(sql, f.admin.projectId, [f.feature, f.clashing]),
  );
  assert.equal(record?.state, 'awaiting_resolution', JSON.stringify(record));
  assert.deepEqual(record.conflict?.paths, ['own.txt']);
  await f.code.reconcileAll();
  const blocked = await f.blockers(publishing.id);
  assert.deepEqual(
    blocked.map((item) => item.code),
    ['code_merge_conflict'],
  );
  assert.ok(record.resolutionTaskId);
  assert.ok(blocked[0].related.some((item) => item.id === record.resolutionTaskId));
  await assert.rejects(f.pin(publishing), { code: 'code_merge_conflict' });
});

test('publishing is declared once, before the work stands anywhere, and only on hosted work', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.state.transaction((tx) => f.code.publishOnAcceptance(f.admin, { unitId: 'nothing' }, tx)),
    { code: 'code_unit_not_found' },
  );
  const work = await f.declare('Publishing');
  const first = await f.publishes(work);
  assert.equal(first.unitId, work.id);
  // The declaration is a write-once fact, so asking again changes nothing.
  const marked = await f.state.read((sql) =>
    sql.get<{ publishes_at: string }>(
      'SELECT publishes_at FROM code_units WHERE unit_id=?',
      work.id,
    ),
  );
  await f.publishes(work);
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.get('SELECT publishes_at FROM code_units WHERE unit_id=?', work.id),
    ),
    marked,
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run('UPDATE code_units SET publishes_at=? WHERE unit_id=?', 'rewritten', work.id),
    ),
    { code: 'state_constraint' },
  );

  // A unit already standing on a base cannot gain main, because a pin is immutable.
  const based = await f.declare('Based');
  await f.pin(based);
  await assert.rejects(f.publishes(based), { code: 'code_publish_based' });

  // A fixed input is a base too, and an immutable one: it can never include main.
  const fixed = await f.declare('Fixed');
  await f.state.transaction((tx) => f.code.declareUnit(f.admin, fixed.id, tx, f.feature));
  await assert.rejects(f.publishes(fixed), { code: 'code_publish_based' });

  // Nor can one that has already been accepted: a successor publishes what it left.
  const accepted = await f.declare('Accepted');
  await f.accept(accepted, f.feature);
  await assert.rejects(f.publishes(accepted), { code: 'code_publish_accepted' });

  // The declaration is the operator's or the directing agent's; a leased worker cannot
  // put its own branch on the road to main.
  const worker = await f.declare('Worker');
  await assert.rejects(
    f.state.transaction((tx) =>
      f.code.publishOnAcceptance(
        { ...f.admin, session: { id: 'session_leased' } },
        { unitId: worker.id },
        tx,
      ),
    ),
    { code: 'session_forbidden' },
  );
});

test('acceptedSince names the accepted work main does not hold, and nothing else', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.code.acceptedSince(f.admin)).unitIds, []);
  const dependency = await f.declare('Dependency');
  await f.accept(dependency, f.feature);
  const other = await f.declare('Other');
  await f.accept(other, f.clashing);
  const codeless = await f.declare('No code');
  const done = await f.move(codeless);
  await f.state.transaction(async (tx) => {
    await f.code.acceptUnit(
      f.admin,
      {
        unitId: codeless.id,
        terminalRevision: done.revision,
        submissionRef: 'none',
        reviewRef: 'none',
        codeRef: null,
        reviewSessionId: null,
      },
      tx,
    );
  });
  const quarantined = await f.declare('Quarantined');
  await f.accept(quarantined, f.moved);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_units SET quarantine_base_key=? WHERE project_id=? AND unit_id=?',
      'base_tainted',
      f.admin.projectId,
      quarantined.id,
    ),
  );

  const since = await f.code.acceptedSince(f.admin);
  // A code-less success is nothing main could be missing; a quarantined acceptance is named
  // separately, because nothing may be built on it.
  assert.deepEqual(since.unitIds, [dependency.id, other.id].sort());
  assert.deepEqual(since.quarantined, [quarantined.id]);
  assert.equal(since.main, f.root0);
  assert.equal(since.hash, (await f.code.acceptedSince(f.admin)).hash);

  // Once main holds that commit the unit is no longer unpublished work.
  await f.setMain(f.feature);
  const after = await f.code.acceptedSince(f.admin);
  assert.deepEqual(after.unitIds, [other.id]);
  assert.notEqual(after.hash, since.hash);
});

test('a quarantine never reaches work that has ended, but a publication wait does', async (t) => {
  const f = await fixture(t, true);
  const publishing = await f.declare('Publishing');
  await f.publishes(publishing);
  await f.pin(publishing);
  await f.accept(publishing, f.feature);
  const ended = await f.declare('Ended');
  await f.accept(ended, f.clashing);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_units SET quarantine_base_key=? WHERE project_id=? AND unit_id=?',
      'base_tainted',
      f.admin.projectId,
      ended.id,
    ),
  );
  await f.code.reconcileAll();
  // Ending cleared this unit's rows and nothing runs again to withdraw one, so a
  // quarantine written now would be a blocker nobody could ever satisfy.
  assert.deepEqual(await f.blockers(ended.id), []);
  // A publication wait is different: it names a human who can still end it. This project
  // recorded no canary, so no merge of it could succeed and the wait says so.
  assert.deepEqual(
    (await f.blockers(publishing.id)).map((item) => item.code),
    ['code_publication_setup_required'],
  );
  assert.equal((await f.code.unit(f.admin, publishing.id)).publication?.state, 'setup_required');
});

test('incomplete rules visibility needs setup even with a canary until acknowledged, while failed enforcement is disabled', async (t) => {
  const f = await fixture(t, true);
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  await f.state.transaction(async (tx) => {
    const row = await tx.get<{ record_json: string }>(
      'SELECT record_json FROM code_publication_controls WHERE project_id=?',
      f.admin.projectId,
    );
    const controls = JSON.parse(row!.record_json);
    controls.visibility = { incomplete: true };
    await tx.run(
      'UPDATE code_publication_controls SET record_json=? WHERE project_id=?',
      JSON.stringify(controls),
      f.admin.projectId,
    );
  });
  await f.code.reconcileAll();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'setup_required');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_setup_required');
  // An administrator who checked the rules by hand acknowledges what the App cannot see.
  await f.code.controlPublication(f.admin, {
    action: 'acknowledge_rules',
    reason: 'Main requires pull requests and strict merv/consolidation-approved checks.',
    requestId: 'rules-checked',
  });
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'pending');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_pending');
  await f.code.controlPublication(f.admin, {
    action: 'record_canary',
    staleMerged: true,
    reason: 'The stale merge passed despite the required checks.',
    requestId: 'failed-canary',
  });
  await f.code.reconcileAll();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'disabled');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_disabled');
});

test('an acceptance that cannot be sealed is still recorded, and says so', async (t) => {
  const f = await fixture(t);
  // Never leased, so it never took a base that includes main.
  const unbased = await f.declare('Unbased');
  await f.publishes(unbased);
  const acceptance = await f.accept(unbased, f.feature);
  assert.equal(acceptance.reference, f.feature);
  assert.equal((await f.code.unit(f.admin, unbased.id)).publication?.state, 'unsealed');
  assert.deepEqual(
    (await f.blockers(unbased.id)).map((item) => item.code),
    ['code_publish_unverifiable'],
  );

  // Code that Code's own repository never admitted is not accepted at all.
  const unadmitted = await f.declare('Unadmitted');
  await f.publishes(unadmitted);
  await f.pin(unadmitted);
  await assert.rejects(f.accept(unadmitted, f.clashing, false), {
    code: 'code_acceptance_unverifiable',
  });
  assert.equal((await f.code.unit(f.admin, unadmitted.id)).acceptance, null);
  assert.deepEqual(await f.code.publications(f.admin), []);

  // A writer fenced before its branch moved kept only its base, so that, and nothing else, is
  // accepted without an admitted upload; a writer still open has kept nothing yet.
  const unmoved = async (title: string, state: 'active' | 'closed') => {
    const work = await f.declare(title);
    await f.pin(work);
    await f.state.transaction((tx) =>
      tx.run(
        'UPDATE code_workspaces SET generation=1,writer_state=?,head_oid=NULL WHERE project_id=? AND unit_id=?',
        state,
        f.admin.projectId,
        work.id,
      ),
    );
    return { work, base: (await f.code.unit(f.admin, work.id)).base!.reference };
  };
  const open = await unmoved('Open', 'active');
  await assert.rejects(f.accept(open.work, open.base, false), {
    code: 'code_acceptance_unverifiable',
  });
  const elsewhere = await unmoved('Elsewhere', 'closed');
  await assert.rejects(f.accept(elsewhere.work, f.clashing, false), {
    code: 'code_acceptance_unverifiable',
  });
  const fenced = await unmoved('Fenced', 'closed');
  assert.equal((await f.accept(fenced.work, fenced.base, false)).reference, fenced.base);
});

test('an accepted publishing unit waits on one pull request and then carries main', async (t) => {
  const f = await fixture(t, true);
  const publicationEvents = async () =>
    (await f.state.events(f.admin.projectId)).filter(
      (event) => event.type === 'code.publication_verified',
    );
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);

  const sealed = await f.code.unit(f.admin, work.id);
  assert.equal(sealed.publication?.state, 'pending');
  assert.equal(sealed.acceptance?.reference, f.feature);
  const [publication] = await f.code.publications(f.admin);
  assert.equal(publication.approval?.source, 'unit');
  assert.equal(publication.baseOid, f.root0);
  assert.equal(publication.approval?.integrationBase, f.root0);
  assert.equal(publication.approval?.certificateHash, null);
  assert.equal(publication.approval?.acceptanceHash, sealed.acceptance?.hash);
  assert.equal(publication.headOid, f.feature);
  // Done work waits visibly, and the wait names the human who ends it.
  const [waiting] = await f.blockers(work.id);
  assert.equal(waiting.code, 'code_publication_pending');
  assert.match(waiting.message, /waiting on publication/);
  assert.ok(
    (await f.sessions.dispatch.stuck(f.admin)).items.some(
      (item) => item.instanceId === work.id && item.kind === 'work_blocked',
    ),
  );

  const [opened] = await f.sync();
  assert.deepEqual(await publicationEvents(), [], 'opening a reviewed PR is not publication');
  assert.equal(opened.lastError, null);
  assert.equal(opened.pull?.draft, false);
  assert.ok(f.remote!.statuses.has(f.feature), 'the approval status names the exact head');
  assert.equal(git(f.bare, ['rev-parse', `refs/merv/proposals/${opened.proposalId}`]), f.feature);
  assert.equal(
    (await f.code.unit(f.admin, work.id)).publication?.pull?.number,
    opened.pull!.number,
  );

  const merge = f.source.git(
    'commit-tree',
    f.source.git('rev-parse', `${f.feature}^{tree}`),
    '-p',
    f.root0,
    '-p',
    f.feature,
    '-m',
    'Publish reviewed work',
  );
  f.publishGitRef('published', merge);
  f.remote!.control.mergeSha = merge;
  const merged = await f.code.mergePublication(f.admin, {
    proposalId: opened.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'publish',
  });
  assert.equal(merged.verified, true);
  const remoteCalls = f.remote!.calls.length;
  assert.deepEqual(
    await f.code.mergePublication(f.admin, {
      proposalId: opened.proposalId,
      expectedHead: f.feature,
      expectedBase: f.root0,
      requestId: 'publish',
    }),
    merged,
  );
  assert.equal(
    f.remote!.calls.length,
    remoteCalls,
    'verified replay does not merge or verify remotely again',
  );
  const published = await f.code.unit(f.admin, work.id);
  assert.equal(published.publication?.state, 'published');
  assert.equal(published.publication?.mergeCommit, merge);
  assert.deepEqual(await f.blockers(work.id), []);
  // Main now carries it, so it is no longer work main is missing.
  assert.deepEqual((await f.code.acceptedSince(f.admin)).unitIds, []);
  assert.equal((await f.code.acceptedSince(f.admin)).main, merge);
  const events = await publicationEvents();
  assert.equal(events.length, 1, 'verification emits once, including after a receipt replay');
  assert.equal(events[0].subjectId, opened.proposalId);
  assert.equal(events[0].data.commitSha, merge);
  assert.equal(events[0].data.unitId, work.id);
});

test('main moving under an approved head is a stale wait, not a failure', async (t) => {
  const f = await fixture(t, true);
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  const [opened] = await f.sync();
  f.branches.set('main', f.moved);
  const stale = await f.code.mergePublication(f.admin, {
    proposalId: opened.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'stale',
  });
  assert.equal(stale.stale, true);
  const unit = await f.code.unit(f.admin, work.id);
  assert.equal(unit.publication?.state, 'stale');
  assert.equal(unit.acceptance?.reference, f.feature);
  const [blocker] = await f.blockers(work.id);
  assert.equal(blocker.code, 'code_publication_stale');
  assert.match(blocker.message, /a successor task integrates it/);
  // Nothing is retried on the accepted unit: a successor takes the newer main. The pull
  // request must not stay open and mergeable against main, because nothing would ever
  // verify a merge of it again.
  assert.equal(f.remote!.pulls[0].state, 'closed');
  assert.equal(f.remote!.pulls[0].merged, false);
  assert.equal(unit.publication?.pull?.number, f.remote!.pulls[0].number);
  assert.deepEqual(
    (await f.sync()).map((item) => item.stale),
    [true],
  );
  assert.deepEqual((await f.code.acceptedSince(f.admin)).unitIds, [work.id]);
  // A consumer waiting on this publication is woken once.
  const wakes = (await f.state.events(f.admin.projectId)).filter(
    (event) => event.type === 'code.publication_stale',
  );
  assert.deepEqual(
    wakes.map((event) => [event.subjectId, event.data.unitId]),
    [[opened.proposalId, work.id]],
  );
});

test('a disabled project and a published tree mismatch both show on the unit', async (t) => {
  const f = await fixture(t, true);
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  const [opened] = await f.sync();
  await f.code.controlPublication(f.admin, {
    action: 'record_canary',
    staleMerged: true,
    reason: 'The disposable stale pull request merged under a bypass.',
    requestId: 'failed-canary',
  });
  const writers = new CodeWriterService(f.state, f.scope, 900);
  // Records read through a policy that adds nothing: a publication as it says of itself.
  const core = new WorkUnitRecords(
    f.state,
    f.scope,
    writers,
    new CodeUnitStore(f.state, f.scope, writers),
    {
      publication: async (_sql, _projectId, stored) => stored,
      baseStatus: async () => null,
    },
  );
  assert.equal((await core.unit(f.admin, work.id)).publication?.state, 'pending');
  core.close();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'disabled');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_disabled');
  await assert.rejects(
    f.code.mergePublication(f.admin, {
      proposalId: opened.proposalId,
      expectedHead: f.feature,
      expectedBase: f.root0,
      requestId: 'while-disabled',
    }),
    { code: 'code_publication_disabled' },
  );
  await f.code.controlPublication(f.admin, {
    action: 'record_canary',
    staleMerged: false,
    reason: 'Enforcement was repaired and the matrix passed again.',
    requestId: 'repaired',
  });
  await f.code.controlPublication(f.admin, {
    action: 'clear',
    reason: 'Verified the repaired rules.',
    requestId: 'clear',
  });

  // A merge commit that does not carry the reviewed tree is an incident on the unit.
  const wrong = f.source.git(
    'commit-tree',
    f.source.git('rev-parse', `${f.moved}^{tree}`),
    '-p',
    f.root0,
    '-p',
    f.feature,
    '-m',
    'Wrong tree',
  );
  f.publishGitRef('wrong', wrong);
  f.remote!.control.mergeSha = wrong;
  await assert.rejects(
    f.code.mergePublication(f.admin, {
      proposalId: opened.proposalId,
      expectedHead: f.feature,
      expectedBase: f.root0,
      requestId: 'wrong-tree',
    }),
    { code: 'code_publication_incident' },
  );
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'incident');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_incident');
  assert.ok(
    !(await f.state.events(f.admin.projectId)).some(
      (event) => event.type === 'code.publication_verified',
    ),
    'a rejected merge tree must never wake research as a verified publication',
  );
});

test('with Code unloaded nothing about publication can be asked or declared', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Publishing');
  await f.code.close();
  await assert.rejects(f.code.acceptedSince(f.admin), { code: 'code_unavailable' });
  await assert.rejects(f.publishes(work), { code: 'code_unavailable' });
});

test('reviewed local work reaches main without GitHub and keeps the exact reviewed commit', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Local integration');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  const before = await f.code.unit(f.admin, work.id);
  assert.equal(before.publication?.state, 'pending');
  await f.sync();
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.feature);
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'published');
  assert.deepEqual(await f.blockers(work.id), []);
  await f.sync();
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.feature);
  const wakes = (await f.state.events(f.admin.projectId)).filter(
    (event) => event.type === 'code.publication_verified',
  );
  assert.equal(wakes.length, 1, 'local completion wakes automatic research once');
  assert.equal(wakes[0].data.destination, 'local');
});

type Pass = { syncDue(stopped?: () => boolean): Promise<void> };
const passOf = (code: unknown) => (code as { publicationStore: Pass }).publicationStore;

test('Code carries accepted local work to main by itself, every due publication in one pass', async (t) => {
  const f = await fixture(t, false, true);
  const first = await f.declare('First');
  const second = await f.declare('Second');
  for (const work of [first, second]) {
    await f.publishes(work);
    await f.pin(work);
  }
  await f.accept(first, f.feature);
  await f.accept(second, f.root0);
  // Nobody syncs: the pass Code runs on its own acts as the project's owner.
  await passOf(f.code).syncDue();
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.feature);
  assert.equal((await f.code.unit(f.admin, first.id)).publication?.state, 'published');
  // Whichever went second, the same pass settled it: integrated, or stale behind main.
  assert.notEqual((await f.code.unit(f.admin, second.id)).publication?.state, 'pending');
});

test('an open pull request is read rarely, and a closed one names the move that works', async (t) => {
  const f = await fixture(t, true);
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  const tried = (ago: number) =>
    f.state.transaction((tx) =>
      tx.run('UPDATE code_publications SET synced_at=?', new Date(Date.now() - ago).toISOString()),
    );
  await passOf(f.code).syncDue();
  assert.equal(f.remote!.pulls.length, 1);
  const calls = f.remote!.calls.length;
  // Waiting on a person is not GitHub work: a minute later nothing is read again.
  await tried(60_000);
  await passOf(f.code).syncDue();
  assert.equal(f.remote!.calls.length, calls);
  // Ten minutes later it is, so a pull request closed on GitHub still reaches the unit.
  f.remote!.pulls[0].state = 'closed';
  await tried(601_000);
  await passOf(f.code).syncDue();
  assert.ok(f.remote!.calls.length > calls);
  const [blocker] = await f.blockers(work.id);
  assert.equal(blocker.code, 'code_publication_closed');
  // A closed publication is settled and never read again, so reopening it is no way out.
  assert.doesNotMatch(blocker.next ?? '', /reopen/);
});

test('a sync that keeps failing before its pull request opens waits on an operator', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Local integration');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  // Reviews cannot answer, so every check of the reviewed facts fails.
  const { reviews } = (
    f.code as unknown as { publicationHost: { reviews: { get(): Promise<unknown> } } }
  ).publicationHost;
  const unavailable = t.mock.method(reviews, 'get', async () => {
    throw new MervError('reviews_unavailable', 'Publication requires Reviews', 503);
  });
  await f.sync();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'setup_required');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_setup_required');
  unavailable.mock.restore();
  await f.sync();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'published');
  assert.deepEqual(await f.blockers(work.id), []);
});

test('a pass stops between publications once Code is closing', async (t) => {
  const f = await fixture(t, false, true);
  for (const name of ['First', 'Second']) {
    const work = await f.declare(name);
    await f.publishes(work);
    await f.pin(work);
    await f.accept(work, f.feature);
  }
  let tries = 0;
  await passOf(f.code).syncDue(() => tries++ > 0);
  assert.deepEqual((await f.code.publications(f.admin)).map((item) => item.verified).sort(), [
    false,
    true,
  ]);
});

test('local integration refuses a main that moved after review', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Local integration');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  await f.setMain(f.moved);
  await f.sync();
  await f.sync();
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.moved);
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'stale');
  const wakes = (await f.state.events(f.admin.projectId)).filter(
    (event) => event.type === 'code.publication_stale',
  );
  assert.deepEqual(
    wakes.map((event) => event.data.unitId),
    [work.id],
    'a consumer waiting on this publication is woken once',
  );
});

test('a reviewed delivery with unchanged source can integrate the existing commit', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Evidence-only delivery');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.root0);
  await f.sync();
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.root0);
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'published');
  const [publication] = await f.code.publications(f.admin);
  assert.equal(publication.destination, 'local');
  assert.equal(publication.verified, true);
  assert.equal(
    git(f.bare, ['rev-parse', `refs/merv/proposals/${publication.proposalId}`]),
    f.root0,
  );
});

for (const movedMain of [false, true]) {
  test(`local consolidation uses pinned main, not its derived dependency base (diverged=${movedMain})`, async (t) => {
    const f = await fixture(t);
    const dependency = await f.declare('Accepted implementation');
    await f.accept(dependency, f.feature);
    const main = movedMain ? f.moved : f.root0;
    await f.setMain(main);
    const work = await f.declare('Consolidate implementation', [dependency.id]);
    await f.publishes(work);
    await f.bases.work(f.admin.projectId);
    const base = await f.pin(work);
    assert.notEqual(base.reference, main);
    await f.accept(work, base.reference);
    const [sealed] = await f.code.publications(f.admin);
    assert.equal(sealed.baseOid, base.reference);
    assert.equal(sealed.approval?.integrationBase, main);
    const [integrated] = await f.sync();
    assert.equal(integrated.verified, true);
    assert.equal(integrated.merge?.expectedBase, main);
    assert.equal((await f.code.status(f.admin)).project!.main.oid, base.reference);
    assert.deepEqual(await f.blockers(work.id), []);
  });
}

/** An accepted unit whose pull request is open and waits on a person. */
async function opened(f: Awaited<ReturnType<typeof fixture>>) {
  await f.canary();
  const work = await f.declare('Publishing');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, f.feature);
  const [publication] = await f.sync();
  return { work, publication };
}
const staleWakes = async (f: Awaited<ReturnType<typeof fixture>>) =>
  (await f.state.events(f.admin.projectId))
    .filter((event) => event.type === 'code.publication_stale')
    .map((event) => event.data.reason);

test('a pull request whose head changed settles stale on sync, so unreviewed commits never merge', async (t) => {
  const f = await fixture(t, true);
  const { work, publication } = await opened(f);
  // A person clicks "Update branch": GitHub pushes a commit nobody reviewed to the head branch,
  // which moves the branch and the pull request's head together.
  f.remote!.pulls[0].head.sha = 'e'.repeat(40);
  f.branches.set(publication.branch, 'e'.repeat(40));
  const [after] = await f.sync();
  assert.equal(after.stale, true);
  assert.equal(after.lastError, 'github_head_changed');
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'stale');
  assert.equal((await f.blockers(work.id))[0].code, 'code_publication_stale');
  assert.equal(f.remote!.pulls[0].state, 'closed');
  assert.deepEqual(await staleWakes(f), ['github_head_changed']);
  await assert.rejects(
    f.code.mergePublication(f.admin, {
      proposalId: publication.proposalId,
      expectedHead: f.feature,
      expectedBase: f.root0,
      requestId: 'after-stale',
    }),
    { code: 'code_publication_stale' },
  );
});

test('a merge that finds the head changed settles stale instead of refusing forever', async (t) => {
  const f = await fixture(t, true);
  const { work, publication } = await opened(f);
  f.remote!.pulls[0].head.sha = 'e'.repeat(40);
  const stale = await f.code.mergePublication(f.admin, {
    proposalId: publication.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'head-changed',
  });
  assert.equal(stale.stale, true);
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'stale');
  assert.equal(f.remote!.pulls[0].merged, false);
  assert.deepEqual(await staleWakes(f), ['github_head_changed']);
});

test('a stale merge commits the stale row before closing its pull request', async (t) => {
  const f = await fixture(t, true);
  const { work, publication } = await opened(f);
  f.branches.set('main', f.moved);
  // Anything that refuses the stale transaction must leave the pull request as it was.
  const disabled = (value: boolean) =>
    f.state.transaction((tx) =>
      tx.run(
        `UPDATE code_publication_controls SET record_json=jsonb_set(record_json::jsonb,'{disabled}','${value}')::text`,
      ),
    );
  await disabled(true);
  const merge = () =>
    f.code.mergePublication(f.admin, {
      proposalId: publication.proposalId,
      expectedHead: f.feature,
      expectedBase: f.root0,
      requestId: 'stale',
    });
  await assert.rejects(merge(), { code: 'code_publication_disabled' });
  assert.equal(f.remote!.pulls[0].state, 'open');
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'disabled');
  await disabled(false);
  assert.equal((await merge()).stale, true);
  assert.equal(f.remote!.pulls[0].state, 'closed');
  assert.deepEqual(await staleWakes(f), ['code_main_changed']);
});

test("a stale merge moves Merv's main only forward to GitHub's", async (t) => {
  const f = await fixture(t, true);
  const { publication } = await opened(f);
  // GitHub's main was rewritten to a commit that does not hold Merv's main.
  await f.setMain(f.moved);
  f.branches.set('main', f.clashing);
  const stale = await f.code.mergePublication(f.admin, {
    proposalId: publication.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'rewritten',
  });
  assert.equal(stale.stale, true);
  assert.equal((await f.code.status(f.admin)).project?.main.oid, f.moved);
});

test('a pull request closed unmerged wakes whoever waits on its publication', async (t) => {
  const f = await fixture(t, true);
  const { work } = await opened(f);
  f.remote!.pulls[0].state = 'closed';
  await f.sync();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'closed');
  assert.deepEqual(
    (await f.code.unit(f.admin, work.id)).publication?.blockers.map((blocker) => blocker.code),
    ['code_publication_closed'],
  );
  assert.deepEqual(await staleWakes(f), ['closed']);
  await f.sync();
  assert.deepEqual(await staleWakes(f), ['closed'], 'a settled publication wakes nobody again');
});

test('a pull request closed unmerged rejects its unit and the units it integrated', async (t) => {
  const f = await fixture(t, true);
  await f.canary();
  const dependency = await f.declare('Dependency');
  await f.accept(dependency, f.feature);
  const other = await f.declare('Other');
  await f.accept(other, f.clashing);
  const work = await f.declare('Consolidation', [dependency.id]);
  await f.publishes(work);
  await f.bases.work(f.admin.projectId);
  await f.pin(work);
  await f.accept(work, f.feature);
  await f.sync();
  assert.deepEqual(
    (await f.code.acceptedSince(f.admin)).unitIds,
    [dependency.id, other.id, work.id].sort(),
  );
  f.remote!.pulls[0].state = 'closed';
  await f.sync();
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'closed');
  // A rejection is durable: no later consolidation is offered the rejected code again.
  assert.deepEqual((await f.code.acceptedSince(f.admin)).unitIds, [other.id]);
});

test('verification retries a failed merge-commit import with a fresh attempt, a bounded number of times', async (t) => {
  const f = await fixture(t, true, true, 1);
  const { work, publication } = await opened(f);
  // GitHub's main holds the merge commit; Code's repository does not have it yet.
  const merge = f.source.git(
    'commit-tree',
    f.source.git('rev-parse', `${f.feature}^{tree}`),
    '-p',
    f.root0,
    '-p',
    f.feature,
    '-m',
    'Publish reviewed work',
  );
  f.source.git('update-ref', 'refs/heads/main', merge);
  f.remote!.control.mergeSha = merge;
  const input = {
    proposalId: publication.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'publish',
  };
  // One fetch fails: the import of that commit has failed for good under its request id.
  await assert.rejects(f.code.mergePublication(f.admin, input), {
    code: 'code_publication_import_pending',
  });
  const merged = await f.code.mergePublication(f.admin, input);
  assert.equal(merged.verified, true);
  assert.equal((await f.code.unit(f.admin, work.id)).publication?.state, 'published');
});

test('verification stops importing a merge commit after its bounded attempts', async (t) => {
  const f = await fixture(t, true, true, 99);
  const { publication } = await opened(f);
  const merge = f.source.git(
    'commit-tree',
    f.source.git('rev-parse', `${f.feature}^{tree}`),
    '-p',
    f.root0,
    '-p',
    f.feature,
    '-m',
    'Publish reviewed work',
  );
  f.source.git('update-ref', 'refs/heads/main', merge);
  f.remote!.control.mergeSha = merge;
  const input = {
    proposalId: publication.proposalId,
    expectedHead: f.feature,
    expectedBase: f.root0,
    requestId: 'publish',
  };
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(f.code.mergePublication(f.admin, input), {
      code: 'code_publication_import_pending',
    });
  await assert.rejects(f.code.mergePublication(f.admin, input), {
    code: 'code_publication_import_failed',
  });
  const imports = await f.state.read((sql) =>
    sql.all(
      "SELECT id FROM code_operations WHERE kind='import' AND project_id=?",
      f.admin.projectId,
    ),
  );
  assert.equal(imports.length, 3);
});

test('local integration onto a main the reviewed head already holds is not stale', async (t) => {
  const f = await fixture(t);
  f.source.git('checkout', '--detach', f.feature);
  const later = f.source.commit({ 'later.txt': 'later\n' });
  f.publishGitRef('later', later);
  const work = await f.declare('Local integration');
  await f.publishes(work);
  await f.pin(work);
  await f.accept(work, later);
  // Main moved under the reviewed head, to a commit that head already holds.
  await f.setMain(f.feature);
  const [integrated] = await f.sync();
  assert.equal(integrated.stale, false);
  assert.equal(integrated.verified, true);
  assert.equal(integrated.merge?.mainParent, f.feature);
  assert.equal((await f.code.status(f.admin)).project?.main.oid, later);
});

test('publications list newest first', async (t) => {
  const f = await fixture(t);
  const units = [];
  for (const name of ['First', 'Second', 'Third', 'Fourth']) {
    const work = await f.declare(name);
    await f.publishes(work);
    await f.pin(work);
    await f.accept(work, f.feature);
    units.push(work.id);
  }
  // A publication id is random, so only its age orders them.
  assert.deepEqual(
    (await f.code.publications(f.admin)).map((item) => item.instanceId),
    [...units].reverse(),
  );
});
