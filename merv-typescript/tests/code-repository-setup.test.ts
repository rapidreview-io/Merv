import test from 'node:test';
import assert from 'node:assert/strict';
import { codeRepositoryImportInputSchema } from '@merv/code/store/protocol';
import { codeStoreFixture, gitSource } from './fixtures/code-store.js';

test('the import journal freezes GitHub authorization across retries and rejects changed selection', async (t) => {
  const source = gitSource(t);
  const head = source.commit({ 'readme.txt': 'research' });
  source.git('branch', 'release/science');
  const f = await codeStoreFixture(t, {}, head);
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

test('relinking before the atomic bind leaves the project baseline unchanged', async (t) => {
  const f = await codeStoreFixture(t);
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
  const f = await codeStoreFixture(t);
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
