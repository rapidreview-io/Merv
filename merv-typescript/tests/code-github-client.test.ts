import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../packages/code/src/github-client.js';
const sha = 'a'.repeat(40),
  base = 'b'.repeat(40),
  merged = 'c'.repeat(40);
const pull = {
  id: 9,
  number: 3,
  node_id: 'PR_example',
  html_url: 'https://github.com/example/research/pull/3',
  title: 'Reviewed consolidation',
  body: 'Pinned evidence',
  state: 'open',
  draft: true,
  head: { ref: 'merv/proposals/proposal_1', sha, repo: { id: 7 } },
  base: { ref: 'main', sha: base, repo: { id: 7 } },
  merged: false,
  merge_commit_sha: null,
  mergeable: true,
  mergeable_state: 'clean',
  updated_at: '2026-09-16T00:00:00Z',
};
const commit = {
  sha,
  html_url: `https://github.com/example/research/commit/${sha}`,
  commit: { message: 'Checkpoint', tree: { sha: base } },
  parents: [{ sha: base }],
};
function client(handler: (url: URL, init: RequestInit) => unknown | Promise<unknown>) {
  const instance = new GitHubClient(
    {
      origin: 'https://merv.example',
      appSlug: 'merv',
      clientId: 'client',
      clientSecret: 'secret',
      encryptionKey: 'aa'.repeat(32),
    },
    async (url, init) => {
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-token');
      assert.equal(new URL(String(url)).origin, 'https://api.github.com');
      assert.ok(init?.signal);
      const result = await handler(new URL(String(url)), init!);
      return result instanceof Response ? result : Response.json(result);
    },
  );
  return instance;
}

test('GitHub PR writes use fixed routes, no force updates, and an exact-head merge', async (t) => {
  const calls: { path: string; method?: string; body: any }[] = [];
  const api = client((url, init) => {
    calls.push({ path: url.pathname, method: init.method, body: JSON.parse(String(init.body)) });
    return url.pathname.endsWith('/merge') ? { merged: true, sha: merged } : pull;
  });
  t.after(() => api.close());
  await api.createPull('private-test-token', 'example/research', {
    title: pull.title,
    body: pull.body,
    head: pull.head.ref,
    base: 'main',
    draft: true,
  });
  await api.updatePull('private-test-token', 'example/research', 3, { state: 'closed' });
  assert.deepEqual(await api.mergePull('private-test-token', 'example/research', 3, sha), {
    merged: true,
    sha: merged,
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.maintainer_can_modify, false);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[2].method, 'PUT');
  assert.deepEqual(calls[2].body, { sha, merge_method: 'merge' });
  assert.ok(calls.every((c) => !JSON.stringify(c).includes('private-test-token')));
});

test('the pinned API contract preserves the merge receipt needed after a lost merge reply', async (t) => {
  const api = client((_url, init) => {
    const version = new Headers(init.headers).get('x-github-api-version');
    const response = { ...pull, state: 'closed', merged: true };
    // GitHub 2026-03-10 removes this property from every pull response.
    return version === '2022-11-28'
      ? { ...response, merge_commit_sha: merged }
      : { ...response, merge_commit_sha: undefined };
  });
  t.after(() => api.close());
  const result = await api.pull('private-test-token', 'example/research', 3);
  assert.equal(result.merged, true);
  assert.equal(result.mergeCommitSha, merged);
});

test('PR inspection preserves missing binary patches and distinguishes no CI statuses', async (t) => {
  const api = client((url) => {
    if (url.pathname.endsWith('/files'))
      return [{ filename: 'weights.bin', status: 'modified', additions: 0, deletions: 0 }];
    if (url.pathname.endsWith('/commits')) return [commit];
    if (url.pathname.endsWith('/reviews'))
      return [
        {
          id: 4,
          user: { login: 'reviewer' },
          state: 'APPROVED',
          commit_id: sha,
          body: 'Checked',
          submitted_at: '2026-09-16T00:00:00Z',
        },
      ];
    if (url.pathname.endsWith('/check-runs'))
      return {
        check_runs: [
          {
            name: 'tests',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/example/research/actions/runs/1',
          },
        ],
      };
    if (url.pathname.endsWith('/status')) return { state: 'pending', total_count: 0 };
    return pull;
  });
  t.after(() => api.close());
  const result = await api.pullDetails('private-test-token', 'example/research', 3);
  assert.equal(result.files[0].patch, null);
  assert.equal(result.statusCount, 0);
  assert.equal(result.checks[0].conclusion, 'success');
  assert.equal(result.reviews[0].commitSha, sha);
  assert.equal(result.commits[0].sha, sha);
});

test('PR inspection refuses a head or base that changes while fetching review evidence', async (t) => {
  for (const side of ['head', 'base'] as const) {
    let reads = 0;
    const api = client((url) => {
      if (url.pathname.endsWith('/3'))
        return ++reads === 1 ? pull : { ...pull, [side]: { ...pull[side], sha: merged } };
      if (url.pathname.endsWith('/status')) return { state: 'success', total_count: 1 };
      if (url.pathname.endsWith('/check-runs')) return { check_runs: [] };
      return [];
    });
    t.after(() => api.close());
    await assert.rejects(api.pullDetails('private-test-token', 'example/research', 3), {
      code: 'github_conflict',
    });
  }
});

test('exact commit reads and repo routing reject substitution', async (t) => {
  let calls = 0;
  const api = client(() => {
    calls++;
    return { ...commit, sha: merged };
  });
  t.after(() => api.close());
  await assert.rejects(api.commit('private-test-token', 'example/research', sha), {
    code: 'github_response',
  });
  for (const repo of [
    '../research',
    'example/..',
    'https://evil.example/repo',
    'example/repo?next=evil',
  ])
    await assert.rejects(api.commit('private-test-token', repo, sha), {
      code: 'invalid_github_repository',
    });
  assert.equal(calls, 1);
});

test('write conflicts preserve safe diagnostics without returning upstream bodies', async (t) => {
  const api = client(
    () => new Response('private-test-token internal GitHub response', { status: 422 }),
  );
  t.after(() => api.close());
  await assert.rejects(
    api.mergePull('private-test-token', 'example/research', 3, sha),
    (error: any) =>
      error.code === 'github_conflict' && !error.message.includes('private-test-token'),
  );
});

test('branch names are encoded as a single REST path parameter', async (t) => {
  const api = client((url) => {
    assert.equal(url.pathname, '/repos/example/research/branches/feature%2Fone');
    return { name: 'feature/one', commit: { sha }, protected: false };
  });
  t.after(() => api.close());
  assert.equal(
    (await api.branch('private-test-token', 'example/research', 'feature/one')).sha,
    sha,
  );
});

test('generic App statuses verify the exact context, commit and issuer before and after emission', async (t) => {
  const status = { context: 'build/reproducibility', description: 'Verified by the build owner' };
  let statuses = [
    { context: status.context, sha, state: 'success', creator: { login: 'other[bot]' } },
  ];
  const emitted: unknown[] = [];
  const api = client((url, init) => {
    if (url.pathname.endsWith('/statuses')) return statuses;
    assert.equal(url.pathname, `/repos/example/research/statuses/${sha}`);
    const body = JSON.parse(String(init.body));
    emitted.push(body);
    statuses = [{ ...body, sha, creator: { login: 'merv[bot]' } }];
    return statuses[0];
  });
  t.after(() => api.close());
  assert.equal(await api.appStatus('private-test-token', 'example/research', sha, status), false);
  assert.equal(
    await api.appStatus('private-test-token', 'example/research', sha, status, true),
    true,
  );
  assert.equal(
    await api.appStatus('private-test-token', 'example/research', sha, status, true),
    true,
  );
  assert.deepEqual(emitted, [{ state: 'success', ...status }]);
  statuses[0].sha = base;
  assert.equal(await api.appStatus('private-test-token', 'example/research', sha, status), false);
});

test('rules inspect a caller-selected App status and comments preserve caller text once', async (t) => {
  const context = 'build/reproducibility';
  const comments: { body: string }[] = [];
  const api = client((url, init) => {
    if (url.pathname.endsWith('/rules/branches/main'))
      return [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context, integration_id: 7 }],
          },
        },
      ];
    if (url.pathname.endsWith('/rulesets')) return [];
    if (url.pathname === '/apps/merv') return { id: 7 };
    assert.equal(url.pathname, '/repos/example/research/issues/3/comments');
    if (init.method === 'POST') comments.push(JSON.parse(String(init.body)));
    return comments;
  });
  t.after(() => api.close());
  assert.equal(
    (await api.rules('private-test-token', 'example/research', 'main', context)).strict,
    true,
  );
  assert.equal(
    (await api.rules('private-test-token', 'example/research', 'main', 'other/check')).strict,
    false,
  );
  const body = 'This build is retained under its original identifier.';
  await api.commentOnce('private-test-token', 'example/research', 3, body);
  await api.commentOnce('private-test-token', 'example/research', 3, body);
  assert.deepEqual(comments, [{ body }]);
});
