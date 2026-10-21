import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller, Reviews, Scope, SessionWorkspace } from '@merv/contracts';
import type { Sessions, SessionWorkspaceObservation } from '@merv/sessions/types';
import {
  CodeSubmissionService,
  type ApprovedSubmission,
  type SubmissionApproval,
} from '@merv/code-work/submissions';
import { CodeGitRemote } from '@merv/code/store/http';
import { CodeRepositories } from '@merv/code/store/repository';
import { CodeWriterService } from '@merv/code/writers';
import { CodeUnitStore } from '@merv/code/units';
import { git } from './fixtures/code-store.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext, changed = true) {
  const state = await openState();
  const directory = mkdtempSync(join(tmpdir(), 'merv-submission-'));
  const source = join(directory, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(source, 'file.txt'), 'before\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'parent']);
  const parent = git(source, ['rev-parse', 'HEAD']);
  if (changed) writeFileSync(join(source, 'file.txt'), 'review exactly this\n');
  git(source, ['add', '.']);
  const tree = git(source, ['write-tree']);
  const scope = {
    require: async (caller: Caller) => {
      assert.equal(caller.projectId, 'project');
    },
  } as unknown as Scope;
  const writers = new CodeWriterService(state, scope, 900);
  const units = new CodeUnitStore(state, scope, writers);
  await units.initialize();
  await state.transaction((tx) =>
    tx.run(
      `INSERT INTO code_workspaces(project_id,unit_id,declared_at,base_json,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at)
    VALUES('project','unit',?, ?,1,'active','producer_session','lease',?)`,
      new Date().toISOString(),
      JSON.stringify({ reference: parent }),
      new Date().toISOString(),
    ),
  );
  const repositories = new CodeRepositories({
    root: join(directory, 'store'),
    quotaBytes: 1024 ** 3,
    reservedFreeBytes: 1,
  });
  await repositories.open();
  await repositories.ensure('project', 'repository', 'sha1');
  const remote = new CodeGitRemote(state, scope, repositories, writers);
  await remote.initialize();
  const repo = repositories.paths('project').repository;
  // Standard Git transfers a tree ref and parent history without manufacturing a commit.
  git(source, [
    'push',
    repo,
    `${parent}:refs/merv/submissions/producer_session/parent`,
    `${tree}:refs/merv/submissions/producer_session/tree`,
  ]);
  const workspace: SessionWorkspace = {
    repositoryId: 'repository',
    workspaceId: 'unit',
    mode: 'persistent',
    branch: 'merv/work/unit',
    baseOid: parent,
    headOid: parent,
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  const observation = (readOnly: boolean): SessionWorkspaceObservation => ({
    provenance: {
      projectId: 'project',
      sessionId: readOnly ? 'review_session' : 'producer_session',
      actorId: readOnly ? 'reviewer' : 'producer',
      source: {
        kind: 'actor',
        actorId: readOnly ? 'review_source' : 'producer_source',
        projectId: 'project',
      },
      instanceId: 'unit',
      revision: 1,
      workflow: {
        name: 'task',
        version: 46,
        state: readOnly ? 'in_review' : 'in_progress',
        policyHash: 'hash',
        registrationId: 'reg',
      },
      runnerId: 'runner',
      hostRef: 'launch',
      readOnly,
    },
    workspaceMode: readOnly ? 'ephemeral' : 'persistent',
    live: true,
    workspace: { attachment: structuredClone(workspace), result: null },
    observedAt: null,
    eventId: null,
  });
  const producerObservation = observation(false),
    reviewerObservation = observation(true);
  let verdict = 'pass';
  const sessions = {
    workspaceObservation: async (_caller: Caller, id: string) =>
      structuredClone(id === 'producer_session' ? producerObservation : reviewerObservation),
    get: async () => ({ runnerId: 'runner', hostRef: 'launch', status: 'active' }),
  } as unknown as Sessions;
  const reviews = {
    get: async () => ({
      id: 'review',
      subjectId: 'unit',
      subjectRevision: 2,
      verdict,
      status: 'submitted',
      reviewerId: 'reviewer',
    }),
  } as unknown as Reviews;
  const completed: ApprovedSubmission[] = [];
  let interrupt = false;
  const service = new CodeSubmissionService(
    state,
    scope,
    sessions,
    writers,
    reviews,
    remote,
    async (_tx, _project, value) => {
      if (interrupt) {
        interrupt = false;
        throw new Error('interrupted acknowledgement');
      }
      completed.push(value);
    },
  );
  await service.initialize();
  t.after(async () => {
    await service.close();
    await repositories.close(1000);
    await state.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const producer = {
    projectId: 'project',
    actorId: 'producer',
    session: { id: 'producer_session' },
  } as Caller;
  const reviewer = {
    projectId: 'project',
    actorId: 'reviewer',
    session: { id: 'review_session' },
  } as Caller;
  const runner: Caller = { projectId: 'project', actorId: 'runner_owner' };
  const receipt = {
    sessionId: 'producer_session',
    runnerId: 'runner',
    hostRef: 'launch',
    generation: 1,
    leaseId: 'lease',
    parentOid: parent,
    treeOid: tree,
    stopped: true,
  };
  const approval: SubmissionApproval = {
    kind: 'task',
    unitId: 'unit',
    terminalRevision: 3,
    submissionRef: 'delivery',
    reviewRef: 'review',
    reviewSessionId: 'review_session',
    codeRef: { kind: 'submission', sessionId: 'producer_session' },
  };
  return {
    state,
    directory,
    source,
    repo,
    repositories,
    remote,
    writers,
    service,
    producer,
    reviewer,
    runner,
    receipt,
    approval,
    completed,
    parent,
    tree,
    reviewerObservation,
    interrupt: () => {
      interrupt = true;
    },
    verdict: (value: string) => {
      verdict = value;
    },
    expect: () => state.transaction((tx) => service.expect(producer, tx)),
    approve: () => state.transaction((tx) => service.approve(reviewer, approval, tx)),
    reviewTree: () => {
      reviewerObservation.workspace!.attachment = {
        ...workspace,
        treeOid: tree,
        submission: { sessionId: receipt.sessionId, parentOid: parent, treeOid: tree },
      };
    },
  };
}

test('uncommitted submission freezes exactly, gates review, commits only after approval and replays a lost acknowledgement', async (t) => {
  const f = await fixture(t);
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '1');
  const pending = await f.expect();
  assert.equal(pending.status, 'pending');
  await assert.rejects(f.approve(), { code: 'code_submission_pending' });
  await assert.rejects(f.service.freeze(f.runner, { ...f.receipt, stopped: false }), {
    code: 'invalid_code_input',
  });
  const frozen = await f.service.freeze(f.runner, f.receipt);
  assert.equal(frozen.workspace!.headOid, f.parent);
  assert.equal(frozen.workspace!.treeOid, f.tree);
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '1', 'freezing creates no commit');
  await assert.rejects(f.service.freeze(f.runner, { ...f.receipt, treeOid: f.parent }), {
    code: 'code_submission_conflict',
  });
  await assert.rejects(f.approve(), { code: 'code_review_unattached' });
  f.reviewTree();
  f.verdict('needs_changes');
  await assert.rejects(f.approve(), { code: 'code_approval_required' });
  await f.service.reconcile();
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '1');
  f.verdict('pass');
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.service.approve(f.reviewer, f.approval, tx);
      throw new Error('rollback approval');
    }),
    /rollback approval/,
  );
  await f.service.reconcile();
  assert.equal(
    git(f.repo, ['rev-list', '--all', '--count']),
    '1',
    'rolled-back approval creates no commit',
  );
  writeFileSync(join(f.source, 'file.txt'), 'later producer edit never reviewed\n');
  await f.approve();
  await f.approve();
  await assert.rejects(
    f.state.transaction((tx) => f.service.requireSettled('project', 'unit', tx)),
    { code: 'code_approval_pending' },
  );
  f.interrupt();
  await f.service.reconcile();
  assert.equal(f.completed.length, 0, 'durable Git alone is not workflow acceptance');
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '2');
  const approved = git(f.repo, ['rev-parse', 'refs/merv/approvals/review']);
  assert.equal(git(f.repo, ['show', `${approved}:file.txt`]), 'review exactly this');
  await f.service.reconcile();
  await f.service.reconcile();
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].commit.head, approved);
  assert.equal(
    git(f.repo, ['rev-list', '--all', '--count']),
    '2',
    'approval retries create no duplicate',
  );
  await f.state.transaction((tx) => f.service.requireSettled('project', 'unit', tx));
  assert.deepEqual(
    await f.service.capture(f.runner, 'producer_session'),
    frozen,
    'approval does not rewrite submitted evidence',
  );
  await assert.rejects(
    f.state.transaction((tx) => tx.run("UPDATE code_submissions SET frozen_hash='changed'")),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    f.state.transaction((tx) => tx.run('DELETE FROM code_approval_milestones')),
    { code: 'state_constraint' },
  );
  assert.deepEqual(await f.service.capture(f.runner, 'producer_session'), frozen);
  assert.equal(
    (await f.state.read((sql) => sql.all('SELECT review_id FROM code_approval_milestones'))).length,
    1,
  );
});

test('an unchanged accepted tree reuses its existing parent commit', async (t) => {
  const f = await fixture(t, false);
  await f.expect();
  await f.service.freeze(f.runner, f.receipt);
  f.reviewTree();
  await f.approve();
  await f.service.reconcile();
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].commit.head, f.parent);
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '1');
});

test('a stale stopped writer cannot close a successor generation or freeze its old candidate', async (t) => {
  const f = await fixture(t);
  await f.expect();
  await f.state.transaction(async (tx) => {
    await f.writers.settle(tx, {
      projectId: 'project',
      unitId: 'unit',
      sessionId: 'producer_session',
      leaseId: 'lease',
      generation: 1,
      expectedHead: f.parent,
      moves: false,
    });
    await tx.run(
      "UPDATE code_workspaces SET generation=2,writer_state='active',writer_session_id='successor',writer_lease_id='lease_2' WHERE unit_id='unit'",
    );
  });
  await assert.rejects(f.service.freeze(f.runner, f.receipt), { code: 'code_generation_stale' });
  assert.equal((await f.service.capture(f.runner, 'producer_session')).status, 'pending');
  assert.equal(git(f.repo, ['rev-list', '--all', '--count']), '1');
});
