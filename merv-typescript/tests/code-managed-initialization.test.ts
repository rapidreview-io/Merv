import { CodeService } from '@merv/code-work/service';
import { CodeService as CoreCodeService } from '@merv/code/service';
import { createService } from '@merv/contracts';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  declareManagedProject,
  initializeManagedProjects,
  managedRoot,
} from '../packages/code/src/store/managed.js';
import { git } from './fixtures/code-store.js';

import { resolutionFixture } from './fixtures/resolution.js';

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
    new CodeService(f.state, f.scope, f.sessions, f.workflows, f.reviews, core),
  );
  await f.state.transaction((tx) => code.ensureRepository(f.admin, tx));
  await (code as unknown as { store: { maintain(): Promise<void> } }).store.maintain();
  const unbind = f.bindCode(code);
  f.beforeClose.push(async () => {
    unbind();
    await code.close();
    await core.close();
  });
  return { ...f, code };
}

test('recovery after Git succeeded but SQL rolled back keeps exactly one root', async (t) => {
  const f = await fixture(t);
  const store = (
    f.code as unknown as {
      store: {
        repositories: import('@merv/code/store/repository').CodeRepositories;
        maintain(): Promise<void>;
      };
    }
  ).store;
  const { repositories } = store;
  // Stop new timer passes, including a wake already queued by fixture initialization, and
  // drain any current pass before declaring the project whose crash boundary we control.
  const maintain = store.maintain.bind(store);
  t.mock.method(store, 'maintain', async () => {});
  await maintain();
  const principal = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://test.example',
    subject: 'crash',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const project = await f.scope.members.createProject(principal, {
    name: 'Recover',
    requestId: 'recover',
  });
  await f.state.transaction((tx) => declareManagedProject(tx, project.id));
  let crashes = 0;
  await initializeManagedProjects(f.state, repositories, async () => {
    crashes++;
    throw new Error('crash before SQL commit');
  });
  assert.equal(crashes, 1, 'the injected failure must reach the SQL transaction after Git');
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
