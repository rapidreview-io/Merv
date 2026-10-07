import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createService, type Caller, type Transaction } from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import {
  WorkUnitRecords,
  type AcceptanceBody,
  type BaseBody,
  type UnitReadPolicy,
} from '@merv/code-work/unit-store';
import { CodeWriterService } from '@merv/code/writers';
import { CodeUnitStore } from '@merv/code/units';
import { CodeStore } from '@merv/code/store/operations';
import { gitSource, openRepositories } from './fixtures/code-store.js';
import { openState } from './fixtures/state.js';

/** Research records retain validated owner facts over the technical Code store. */
class OwnerStore extends WorkUnitRecords {
  declare(caller: Caller, unitId: string, tx: Transaction) {
    return this.retainDeclaration(caller, { unitId, workflow: 'external-owner', version: 9 }, tx);
  }
  pinFacts(caller: Caller, unitId: string, body: BaseBody, tx: Transaction) {
    return this.retainBase(
      caller,
      { unitId, workflow: 'external-owner', version: 9, leaseId: 'lease', body },
      tx,
    );
  }
  acceptFacts(caller: Caller, body: AcceptanceBody, tx: Transaction) {
    return this.retainUnitAcceptance(caller, body, tx);
  }
}

/** Records read as stored: a publication as it says of itself, a base only once pinned. */
const asStored: UnitReadPolicy = {
  publication: async (_sql, _projectId, stored) => stored,
  baseStatus: async (_tx, _row, base) => (base ? { status: 'pinned', pin: base } : null),
};

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'merv-unit-store-'));
  const state = await openState(root);
  const scope = await createService(new ProjectScope(state));
  const writers = new CodeWriterService(state, scope, 900);
  const units = await createService(new CodeUnitStore(state, scope, writers));
  let store = await createService(new OwnerStore(state, scope, writers, units, asStored));
  t.after(async () => {
    store.close();
    writers.close();
    await state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const principal = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await scope.members.createProject(principal, {
    name: 'Storage only',
    requestId: 'project',
  });
  const caller = await scope.caller(principal, project.id);
  const body = (unitId: string): AcceptanceBody => ({
    formatVersion: 1,
    unitId,
    workflow: 'external-owner',
    version: 9,
    terminalRevision: 2,
    submissionRef: 'submission',
    reviewRef: 'review',
    acceptedBy: caller.actorId,
    code: null,
    storage: 'none',
  });
  return {
    root,
    scope,
    state,
    units,
    caller,
    body,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = await createService(new OwnerStore(state, scope, writers, units, asStored));
    },
  };
}

test('research records roll facts back with their owner', async (t) => {
  const f = await fixture(t);
  const tables = await f.state.read((sql) =>
    sql.all<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'",
    ),
  );
  assert.ok(tables.some(({ name }) => name === 'code_units'));
  assert.equal(
    tables.some(({ name }) => /^(workflow_instances|sessions|reviews)$/.test(name)),
    false,
  );
  const base: BaseBody = {
    formatVersion: 1,
    kind: 'accepted',
    reference: 'a'.repeat(40),
    repositoryId: 'repo',
    dependencies: [],
    sources: [],
    main: null,
  };
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.store.declare(f.caller, 'rolled-back', tx);
      await f.store.pinFacts(f.caller, 'rolled-back', base, tx);
      await f.store.acceptFacts(f.caller, f.body('rolled-back'), tx);
      throw new Error('owner rejected');
    }),
    /owner rejected/,
  );
  await assert.rejects(f.store.unit(f.caller, 'rolled-back'), { code: 'code_unit_not_found' });

  await f.state.transaction(async (tx) => {
    await f.store.declare(f.caller, 'kept', tx);
    await f.store.pinFacts(f.caller, 'kept', base, tx);
    await f.store.acceptFacts(f.caller, f.body('kept'), tx);
  });
  const before = await f.store.unit(f.caller, 'kept');
  await f.reopen();
  await f.state.transaction((tx) => f.store.acceptFacts(f.caller, f.body('kept'), tx));
  assert.deepEqual(await f.store.unit(f.caller, 'kept'), before);
  await assert.rejects(
    f.state.transaction((tx) =>
      f.store.acceptFacts(f.caller, { ...f.body('kept'), submissionRef: 'different' }, tx),
    ),
    { code: 'code_acceptance_conflict' },
  );
  assert.deepEqual((await f.store.status(f.caller)).blockers, []);
});

test('Code storage imports and rebinds while research retains unfinished bases and their commits', async (t) => {
  const f = await fixture(t);
  const source = gitSource(t);
  const head = source.commit({ 'research.txt': 'retained baseline' });
  const repositories = await openRepositories(join(f.root, 'repositories'));
  const store = await createService(
    new CodeStore(
      f.state,
      f.scope,
      {
        root: join(f.root, 'repositories'),
        reservedFreeBytes: 1,
        settleMs: 60_000,
      },
      {
        imported: async () => {},
        workspaces: async () => [],
        fenced: async () => {},
        advanced: async () => {},
        quarantined: async () => {},
      },
      repositories,
      {
        read: async (_caller, use) =>
          use({
            url: source.repository,
            protocol: 'file',
            repository: { id: 1, fullName: 'owner/repository' },
            env: {},
          }),
      },
    ),
  );
  try {
    await f.units.bindLocal(f.caller, {
      repositoryId: 'original',
      mainOid: head,
      requestId: 'bind',
    });
    const imported = await store.importRepository(f.caller, {
      source: 'github',
      ref: 'refs/heads/main',
      requestId: 'import',
    });
    assert.equal(imported.status, 'completed');
    const rebind = () =>
      store.rebindRepository(f.caller, {
        repositoryId: 'renamed',
        mainOid: head,
        reason: 'Keep the retained history',
        requestId: 'rebind',
      });
    const at = new Date().toISOString();
    await f.state.transaction((tx) =>
      tx.run(
        'INSERT INTO code_bases(project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        f.caller.projectId,
        'base',
        '[]',
        head,
        head,
        'git',
        'queued',
        at,
        at,
      ),
    );
    // Repository protection remains durable after the research record service closes.
    f.store.close();
    await assert.rejects(rebind(), { code: 'code_rebind_busy' });
    await f.state.transaction((tx) =>
      tx.run(
        "UPDATE code_bases SET state='suspended',check_state='running' WHERE project_id=?",
        f.caller.projectId,
      ),
    );
    await assert.rejects(rebind(), { code: 'code_rebind_busy' });
    await f.state.transaction((tx) =>
      tx.run(
        "UPDATE code_bases SET state='resolved',check_state='none',result_json=? WHERE project_id=?",
        JSON.stringify({ commit: head }),
        f.caller.projectId,
      ),
    );
    assert.equal((await rebind()).status, 'completed');
    await f.reopen();
    assert.equal((await f.store.status(f.caller)).project?.repositoryId, 'renamed');
    const tables = await f.state.read((sql) =>
      sql.all<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'",
      ),
    );
    assert.ok(tables.some(({ name }) => name === 'code_units'));
    assert.equal(
      tables.some(({ name }) => /^(wf_|reviews$|sessions$|research_)/.test(name)),
      false,
    );
  } finally {
    await store.close();
    await repositories.close(0);
  }
});
