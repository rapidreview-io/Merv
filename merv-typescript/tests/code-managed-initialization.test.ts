import { CodeService as CoreCodeService } from '@merv/code/service';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { createService } from '@merv/contracts';
import { PaperService } from '@merv/paper';
import { ExperimentService } from '@merv/experiments';
import { CodeService } from '@merv/code-work/service';
import {
  declareManagedProject,
  initializeManagedProjects,
  managedRoot,
} from '@merv/code/store/managed';
import { resolutionFixture } from './fixtures/resolution.js';
import { git } from './fixtures/code-store.js';

async function fixture(t: Parameters<typeof resolutionFixture>[0]) {
  const f = await resolutionFixture(t);
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: {
        root: join(f.directory, 'code'),
        quotaBytes: 10 * 1024 ** 3,
        reservedFreeBytes: 1,
      },
    }),
  );
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, core),
  );
  await f.state.transaction((tx) => code.ensureRepository(f.admin, tx));
  await (code as unknown as { store: { maintain(): Promise<void> } }).store.maintain();
  const unbind = f.tasks.bindCode(code);
  f.beforeClose.push(async () => {
    unbind();
    await code.close();
    await core.close();
  });
  return { ...f, code };
}

test('a project gets a real durable Git root without GitHub, replay preserves it', async (t) => {
  const f = await fixture(t);
  const before = await f.code.status(f.admin);
  const root = managedRoot(f.admin.projectId);
  assert.equal(before.project?.repositoryId, root.repositoryId);
  assert.equal(before.project?.main.oid, root.oid);
  assert.equal(before.project?.main.stored, true);
  assert.equal(before.store?.source, 'managed');
  const repositories = (
    f.code as unknown as {
      store: { repositories: import('@merv/code/store/repository').CodeRepositories };
    }
  ).store.repositories;
  const path = repositories.paths(f.admin.projectId).repository;
  assert.equal(git(path, ['rev-parse', 'refs/merv/initial']), root.oid);
  assert.equal(git(path, ['ls-tree', '-r', root.oid]), '');
  await f.state.transaction((tx) => declareManagedProject(tx, f.admin.projectId));
  await initializeManagedProjects(f.state, repositories, async () => {});
  assert.equal((await f.code.status(f.admin)).project?.main.oid, root.oid);
  assert.equal(git(path, ['rev-list', '--all', '--count']), '1');
});

test('ordinary new tasks have managed Git and reject scratch and legacy base selection', async (t) => {
  const f = await fixture(t);
  const input = {
    title: 'Write a report',
    goal: 'Retain a report',
    checks: ['Report is readable'],
    requestId: 'task',
  };
  const task = await f.tasks.create(f.admin, input);
  assert.equal(task.workspace, 'git');
  assert.equal((await f.tasks.create(f.admin, input)).id, task.id);
  const unit = await f.code.unit(f.admin, task.id);
  assert.ok(unit.baseStatus);
  await assert.rejects(
    f.tasks.create(f.admin, { ...input, workspace: 'none', requestId: 'scratch' }),
    { code: 'invalid_workspace' },
  );
  await assert.rejects(
    f.tasks.create(f.admin, { ...input, baseTaskId: task.id, requestId: 'legacy' }),
    { code: 'invalid_workspace' },
  );
});

test('missing Code prevents creation instead of silently selecting scratch', async (t) => {
  const f = await resolutionFixture(t);
  await assert.rejects(
    f.tasks.create(f.admin, {
      title: 'Write a report',
      goal: 'Retain a report',
      checks: ['Report is readable'],
      requestId: 'task',
    }),
    { code: 'code_unavailable' },
  );
});

test('experiments always choose the hosted Git policy before planning', async (t) => {
  const f = await fixture(t);
  const paper = await createService(new PaperService(f.state, f.scope, f.artifacts));
  const experiments = await createService(
    new ExperimentService(
      f.state,
      f.scope,
      f.artifacts,
      f.workflows,
      f.reviews,
      f.context,
      f.code,
      paper,
    ),
  );
  f.beforeClose.unshift(async () => {
    experiments.close();
    paper.close();
  });
  const experiment = await experiments.create(f.admin, {
    name: 'managed-git',
    intent: 'Check retained source',
    requestId: 'experiment',
  });
  assert.equal(experiment.workspace, 'git');
  assert.ok(await f.code.unit(f.admin, experiment.id));
  await assert.rejects(
    experiments.create(f.admin, {
      name: 'scratch-run',
      intent: 'No scratch',
      workspace: 'none',
      requestId: 'scratch',
    }),
    { code: 'invalid_workspace' },
  );
});

test('a failed initialization stays blocked and retries the same deterministic root', async (t) => {
  const f = await fixture(t);
  const repositories = (
    f.code as unknown as {
      store: { repositories: import('@merv/code/store/repository').CodeRepositories };
    }
  ).store.repositories;
  const principal = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://test.example',
    subject: 'second',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await f.scope.createProject(principal, {
    name: 'Second project',
    requestId: 'second',
  });
  const caller = await f.scope.caller(principal, project.id);
  const ensure = repositories.ensure.bind(repositories);
  t.mock.method(repositories, 'ensure', async () => {
    throw new Error('temporary disk failure');
  });
  await f.state.transaction((tx) => f.code.ensureRepository(caller, tx));
  assert.equal((await f.code.status(caller)).project?.durability, 'code');
  assert.equal((await f.code.status(caller)).project?.main.stored, false);
  await initializeManagedProjects(f.state, repositories, async () => {});
  assert.equal((await f.code.status(caller)).operations?.[0]?.error, 'code_initialization_failed');
  const task = await f.tasks.create(caller, {
    title: 'Wait for storage',
    goal: 'Retain work',
    checks: ['Retained'],
    requestId: 'pending',
  });
  assert.match(task.guidance.instruction, /initializing/);
  const pendingUnit = await f.code.unit(caller, task.id);
  assert.match(JSON.stringify(pendingUnit.baseStatus), /retries automatically/);
  t.mock.method(repositories, 'ensure', ensure);
  await initializeManagedProjects(f.state, repositories, async () => {});
  assert.equal((await f.code.status(caller)).project?.main.oid, managedRoot(project.id).oid);
  assert.equal((await f.code.status(caller)).project?.main.stored, true);
});

test('recovery after Git succeeded but SQL rolled back keeps exactly one root', async (t) => {
  const f = await fixture(t);
  const repositories = (
    f.code as unknown as {
      store: { repositories: import('@merv/code/store/repository').CodeRepositories };
    }
  ).store.repositories;
  const principal = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://test.example',
    subject: 'crash',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await f.scope.createProject(principal, { name: 'Recover', requestId: 'recover' });
  // Declare directly to keep the timer out of this controlled crash boundary.
  await f.state.transaction((tx) => declareManagedProject(tx, project.id));
  await initializeManagedProjects(f.state, repositories, async () => {
    throw new Error('crash before SQL commit');
  });
  const caller = await f.scope.caller(principal, project.id);
  assert.equal((await f.code.status(caller)).project?.main.stored, false);
  const path = repositories.paths(project.id).repository;
  assert.equal(git(path, ['rev-parse', 'refs/merv/initial']), managedRoot(project.id).oid);
  await Promise.all([
    initializeManagedProjects(f.state, repositories, async () => {}),
    initializeManagedProjects(f.state, repositories, async () => {}),
  ]);
  assert.equal((await f.code.status(caller)).project?.main.stored, true);
  assert.equal(git(path, ['rev-list', '--all', '--count']), '1');
});

test('a wake during a slow creation transaction initializes promptly after commit', async (t) => {
  const f = await resolutionFixture(t);
  const core = await createService(
    new CoreCodeService(f.state, f.scope, {
      repositories: {
        root: join(f.directory, 'slow-code'),
        quotaBytes: 10 * 1024 ** 3,
        reservedFreeBytes: 1,
      },
    }),
  );
  const code = await createService(
    new CodeService(f.state, f.scope, f.sessions, f.workflows, core, {
      config: { sweepSeconds: 3600 },
    }),
  );
  f.beforeClose.push(async () => {
    await code.close();
    await core.close();
  });
  await f.state.transaction(async (tx) => {
    await code.ensureRepository(f.admin, tx);
    // More than one 200ms wake interval; the journal is invisible to other readers.
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  const deadline = Date.now() + 3000;
  while (!(await code.status(f.admin)).project?.main.stored) {
    assert.ok(Date.now() < deadline, 'the creation wake must survive its uncommitted transaction');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});
