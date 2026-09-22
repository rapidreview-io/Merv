import test from 'node:test';
import assert from 'node:assert/strict';
import { codeRepositoryImportInputSchema } from '@merv/contracts';
import type { Caller, CodeRepositoryPrepareInput, CodeStoreOperation } from '@merv/contracts';
import type { Code } from '../packages/code-research/src/types.js';
import { prepareRepository } from '../packages/code-research/src/repository-setup.js';
import { codeStoreFixture, gitSource } from './fixtures/code-store.js';

const caller: Caller = { actorId: 'admin', projectId: 'project', credentialId: 'admin-key' };
const selection: CodeRepositoryPrepareInput = {
  expectedRevision: 3,
  baseBranch: 'release/science',
  headOid: 'a'.repeat(40),
  requestId: 'prepare-1',
};

/** The helper composes owner APIs; the actual bind/import journals have their own store tests. */
function fixture() {
  const state = {
    revision: 3,
    branchHead: selection.headOid,
    main: undefined as string | undefined,
    stored: false,
    hosted: true,
    operation: 'prepared' as CodeStoreOperation['status'],
    binds: [] as unknown[],
    imports: [] as unknown[],
    movedDuringImport: false,
    reboundDuringImport: false,
    repositoryId: 'github:42',
  };
  const code = {
    github: {
      status: async () => ({
        revision: state.revision,
        baseBranch: selection.baseBranch,
        repository: { id: 42 },
        automation: 'write',
      }),
      branches: async () => [{ name: selection.baseBranch, sha: state.branchHead }],
    },
    status: async () => ({
      project: state.main
        ? { repositoryId: state.repositoryId, main: { oid: state.main, stored: state.stored } }
        : null,
      store: { hosted: state.hosted },
    }),
    bindLocal: async (_caller: Caller, input: { mainOid: string }) => {
      state.binds.push(input);
      state.main = input.mainOid;
      return { main: { oid: input.mainOid } };
    },
    importRepository: async (_caller: Caller, input: unknown) => {
      state.imports.push(input);
      if (state.movedDuringImport) state.revision++;
      if (state.reboundDuringImport) state.repositoryId = 'github:99';
      return { id: 'import-1', status: state.operation };
    },
  } as unknown as Pick<Code, 'github' | 'status' | 'bindLocal' | 'importRepository'>;
  return { state, run: (input = selection) => prepareRepository(code, caller, input) };
}

test('preparation imports the chosen nondefault branch and freezes the same operations on retry', async () => {
  const { state, run } = fixture();
  assert.equal((await run()).state, 'importing');
  state.branchHead = 'b'.repeat(40);
  state.operation = 'completed';
  state.stored = true;
  const ready = await run();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.headOid, selection.headOid);
  assert.deepEqual(
    state.binds,
    Array(2).fill({
      repositoryId: 'github:42',
      mainOid: selection.headOid,
      requestId: 'prepare-1:bind',
    }),
  );
  assert.deepEqual(
    state.imports,
    Array(2).fill({
      source: 'github',
      ref: 'refs/heads/release/science',
      githubBinding: { revision: 3, repositoryId: 42, baseBranch: 'release/science' },
      requestId: 'prepare-1:import',
    }),
  );
});

test('the import journal freezes GitHub authorization across retries and rejects changed selection', async (t) => {
  const source = gitSource(t);
  const head = source.commit({ 'readme.txt': 'research' });
  source.git('branch', 'release/science');
  const f = await codeStoreFixture(t, 'sqlite', {}, head);
  const selected = { revision: 3, repositoryId: 42, baseBranch: 'release/science' };
  const observed: unknown[] = [];
  await f.open({
    remote: {
      read: async (_caller, use, binding) => {
        observed.push(binding);
        assert.deepEqual(binding, selected);
        return await use({
          url: source.repository,
          protocol: 'file',
          repository: { id: 42, fullName: 'research/project' },
          env: {},
        });
      },
    },
  });
  const input = {
    source: 'github',
    ref: 'refs/heads/release/science',
    githubBinding: selected,
    requestId: 'selected-import',
  };
  const result = await f.code.importRepository(f.admin, input);
  assert.equal(result.status, 'completed');
  assert.equal(result.head, head);
  assert.deepEqual(observed, [selected]);
  const replay = await f.code.importRepository(f.admin, input);
  assert.equal(replay.id, result.id);
  await assert.rejects(
    f.code.importRepository(f.admin, { ...input, githubBinding: { ...selected, revision: 4 } }),
    { code: 'request_conflict' },
  );
  assert.equal(observed.length, 1);
});

test('preparing a Unicode research branch imports its actual Git history and retains the selected commit', async (t) => {
  const source = gitSource(t);
  const head = source.commit({ 'research.txt': 'Unicode branch baseline' });
  const baseBranch = '研究/évaluation';
  source.git('branch', baseBranch);
  const f = await codeStoreFixture(t, 'sqlite', {}, head);
  const principal = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://issuer.example.test',
    subject: 'unicode-owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await f.scope.createProject(principal, {
    name: 'Unicode repository',
    requestId: 'unicode-project',
  });
  const human = await f.scope.caller(principal, project.id);
  await f.open({
    remote: {
      read: async (_caller, use, binding) => {
        assert.equal(binding?.baseBranch, baseBranch);
        return await use({
          url: source.repository,
          protocol: 'file',
          repository: { id: 42, fullName: 'research/project' },
          env: {},
        });
      },
    },
  });
  t.mock.method(f.code.github, 'status', async () => ({
    revision: 3,
    baseBranch,
    automation: 'write',
    repository: { id: 42 },
  }));
  t.mock.method(f.code.github, 'assertBinding', async () => {});
  t.mock.method(f.code.github, 'branches', async () => [{ name: baseBranch, sha: head }]);
  const result = await f.code.prepareRepository(human, {
    expectedRevision: 3,
    baseBranch,
    headOid: head,
    requestId: 'unicode-prepare',
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.headOid, head);
  assert.equal(result.operation.head, head);
  assert.equal((await f.code.status(human)).project?.main.stored, true);
});

test('relinking before the atomic bind leaves the project baseline unchanged', async (t) => {
  const f = await codeStoreFixture(t, 'sqlite');
  const human = await f.human();
  const before = (await f.code.status(human)).project;
  t.mock.method(f.code.github, 'assertBinding', async () => {
    throw Object.assign(new Error('Connection replaced'), { code: 'github_conflict' });
  });
  await assert.rejects(
    f.code.bindLocal(
      human,
      {
        repositoryId: before!.repositoryId,
        mainOid: 'b'.repeat(40),
        expectedMainOid: before!.main.oid,
        requestId: 'stale-preparation',
      },
      { revision: 3, baseBranch: 'release/science', repository: { id: 42 } as never },
    ),
    { code: 'github_conflict' },
  );
  assert.deepEqual((await f.code.status(human)).project, before);
});

test('relinking before import authorization never fetches the replacement repository', async (t) => {
  const f = await codeStoreFixture(t, 'sqlite');
  let tokens = 0;
  t.mock.method(
    f.code.github,
    'automation',
    async (...args: Parameters<typeof f.code.github.automation>) =>
      args[3](
        {
          installationToken: async () => {
            tokens++;
            throw new Error('Must not issue token');
          },
        } as never,
        '',
        {
          revision: 4,
          repository: { id: 99, fullName: 'other/repository' },
          baseBranch: 'main',
        } as never,
      ),
  );
  await assert.rejects(
    f.code.importRepository(f.admin, {
      source: 'github',
      ref: 'refs/heads/release/science',
      requestId: 'pinned-import',
      githubBinding: { revision: 3, repositoryId: 42, baseBranch: 'release/science' },
    }),
    { code: 'github_conflict' },
  );
  assert.equal(tokens, 0);
  assert.equal((await f.code.status(f.admin)).project?.main.stored, false);
});

test('preparation rejects stale settings and a branch that moved before binding', async () => {
  const { state, run } = fixture();
  state.revision++;
  await assert.rejects(run(), { code: 'github_conflict' });
  state.revision--;
  state.branchHead = 'b'.repeat(40);
  await assert.rejects(run(), { code: 'code_branch_changed' });
  assert.equal(state.binds.length, 0);
  assert.equal(state.imports.length, 0);
});

test('completed import is not ready until the selected commit is retained in hosted storage', async () => {
  const { state, run } = fixture();
  state.operation = 'completed';
  assert.equal((await run()).state, 'failed');
  state.stored = true;
  state.hosted = false;
  assert.equal((await run()).state, 'failed');
});

test('failed import remains actionable and a replacement selection carries explicit main comparison', async () => {
  const { state, run } = fixture();
  state.main = 'c'.repeat(40);
  state.operation = 'failed';
  assert.equal((await run({ ...selection, expectedMainOid: state.main })).state, 'failed');
  assert.deepEqual(state.binds[0], {
    repositoryId: 'github:42',
    mainOid: selection.headOid,
    expectedMainOid: 'c'.repeat(40),
    requestId: 'prepare-1:bind',
  });
});

test('a connection replaced during import cannot receive a ready result', async () => {
  const { state, run } = fixture();
  state.operation = 'completed';
  state.stored = true;
  state.movedDuringImport = true;
  await assert.rejects(run(), { code: 'github_conflict' });
});

test('a repository rebound during import cannot report ready even when its main is unchanged', async () => {
  const { state, run } = fixture();
  state.operation = 'completed';
  state.stored = true;
  state.reboundDuringImport = true;
  await assert.rejects(run(), { code: 'code_rebind_required' });
  assert.equal(state.main, selection.headOid);
});

test('repository imports accept Unicode branches while rejecting unsafe Git ref syntax', () => {
  for (const ref of [
    'refs/heads/研究/évaluation',
    'refs/tags/версия-1',
    `refs/heads/${'a'.repeat(244)}`,
  ]) {
    assert.equal(
      codeRepositoryImportInputSchema.safeParse({ source: 'github', ref, requestId: 'ref' })
        .success,
      true,
      ref,
    );
  }
  for (const ref of [
    'refs/heads/../main',
    'refs/heads/a.lock',
    'refs/heads/a@{b}',
    'refs/heads/a:b',
    'refs/heads/a b',
    'refs/heads/.hidden',
    'refs/heads/a//b',
    'refs/heads/a\\b',
    'refs/merv/main',
  ]) {
    assert.equal(
      codeRepositoryImportInputSchema.safeParse({ source: 'github', ref, requestId: 'ref' })
        .success,
      false,
      ref,
    );
  }
});
