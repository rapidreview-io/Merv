import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createService, type State } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { Pool } from 'pg';
import { ProjectScope } from '@merv/scope';
import { CodeGitHubService } from '../packages/code/src/github.js';
import { randomUUID } from 'node:crypto';
import { CodePublicationService } from '../packages/code/src/publications.js';
import type { CodeTransportService } from '../packages/code/src/transport.js';
import type { CodeProposal } from '../packages/code/src/types.js';
import {
  githubFixture,
  repository,
  baseOid,
  headOid,
  treeOid,
  mergeOid,
  config,
} from './github-fixture.js';

async function setup(t: TestContext, storage?: State) {
  const f = await githubFixture(t, storage);
  await f.enable();
  const binding = { revision: 3, repository, baseBranch: 'main' };
  const transport = { bindingForProposal: async () => binding } as unknown as CodeTransportService;
  const publications = await createService(
    new CodePublicationService(f.state, f.scope, f.github, transport),
  );
  const proposal = {
    id: 'codeprop_fixture',
    projectId: f.project.id,
    instanceId: 'instance_fixture',
    manifestHash: 'f'.repeat(64),
    producer: { actorId: f.caller.actorId, sessionId: 'session_fixture' },
    summary: 'Consolidation: fixture',
    receipt: { repositoryId: 'github:101', baseOid, headOid, treeOid },
  } as CodeProposal;
  await f.state.transaction((tx) => publications.enqueue(f.caller, proposal, tx));
  const review = (verdict: 'pass' | 'needs_changes' = 'pass') =>
    f.state.transaction((tx) =>
      publications.recordReview(f.reviewer, proposal, 'review_fixture', verdict, tx),
    );
  const sync = async () => {
    await f.state.transaction((tx) => tx.run("UPDATE code_publications SET synced_at=''"));
    return (await publications.syncPublications(f.caller))[0];
  };
  return { ...f, publications, proposal, review, sync, transport };
}

test('draft PR creation recovers a lost response and independent approval readies exactly that proposal', async (t) => {
  const f = await setup(t);
  f.control.loseCreateReply = true;
  const draft = await f.sync();
  assert.equal(draft.lastError, null);
  assert.equal(draft.pull?.draft, true);
  assert.equal(f.pulls.length, 1);
  await f.sync();
  assert.equal(f.pulls.length, 1);
  await assert.rejects(
    f.publications.mergePublication(f.caller, {
      proposalId: f.proposal.id,
      expectedHead: headOid,
      expectedBase: baseOid,
      requestId: 'merge',
    }),
    { code: 'publication_review_required' },
  );
  await f.review();
  const ready = await f.sync();
  assert.equal(ready.pull?.draft, false);
  assert.equal(ready.review?.verdict, 'pass');
  const restarted = await createService(
    new CodePublicationService(f.state, f.scope, f.github, f.transport),
  );
  assert.equal((await restarted.publications(f.caller))[0].review?.id, 'review_fixture');
  const detail = await restarted.publicationDetails(f.caller, f.proposal.id);
  assert.equal(detail.details?.pull.head.sha, headOid);
  const merged = await restarted.mergePublication(f.caller, {
    proposalId: f.proposal.id,
    expectedHead: headOid,
    expectedBase: baseOid,
    requestId: 'merge',
  });
  assert.equal(merged.pull?.merged, true);
  assert.equal(merged.merge?.commitSha, mergeOid);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 1);
});

test('changed PR heads and non-passing checks prevent merge; a rejection closes only the matching PR', async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.review();
  await f.sync();
  f.pulls[0].head.sha = 'e'.repeat(40);
  const input = {
    proposalId: f.proposal.id,
    expectedHead: headOid,
    expectedBase: baseOid,
    requestId: 'merge',
  };
  await assert.rejects(f.publications.mergePublication(f.caller, input), {
    code: 'github_head_changed',
  });
  f.pulls[0].head.sha = headOid;
  f.control.checks = [
    { name: 'tests', status: 'completed', conclusion: 'failure', html_url: null },
  ];
  await assert.rejects(f.publications.mergePublication(f.caller, input), {
    code: 'github_checks_pending',
  });
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
  await assert.rejects(f.review('needs_changes'), { code: 'publication_conflict' });
});

test('rejected proposals close their PR and never authorize a merge', async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.review('needs_changes');
  assert.equal((await f.sync()).pull?.state, 'closed');
  await assert.rejects(
    f.publications.mergePublication(f.caller, {
      proposalId: f.proposal.id,
      expectedHead: headOid,
      expectedBase: baseOid,
      requestId: 'merge',
    }),
    { code: 'publication_review_required' },
  );
});

test('lost merge replies reconcile to the actual merge without reissuing it', async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.review();
  await f.sync();
  f.control.loseMergeReply = true;
  const input = {
    proposalId: f.proposal.id,
    expectedHead: headOid,
    expectedBase: baseOid,
    requestId: 'merge',
  };
  await assert.rejects(f.publications.mergePublication(f.caller, input), {
    code: 'github_unavailable',
  });
  const recovered = await f.publications.mergePublication(f.caller, input);
  assert.equal(recovered.merge?.commitSha, mergeOid);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 1);
});

test('a rejection recovers and closes a draft after both creation and recovery replies were lost', async (t) => {
  const f = await setup(t);
  f.control.loseCreateReply = true;
  f.control.before = async (path) => {
    if (path.endsWith('/pulls') && f.calls.at(-1)?.method === 'GET' && f.pulls.length)
      throw new Error('recovery unavailable');
  };
  assert.equal((await f.sync()).pull, null);
  assert.equal(f.pulls.length, 1);
  f.control.before = undefined;
  await f.review('needs_changes');
  assert.equal((await f.sync()).pull?.state, 'closed');
  assert.equal(f.pulls.length, 1);
  const count = f.calls.length;
  await f.sync();
  assert.equal(f.calls.length, count);
});

test('publication intent and its review remain durable when GitHub automation is disabled', async (t) => {
  const f = await setup(t);
  await f.github.configureAutomation(f.caller, {
    expectedRevision: 3,
    mode: 'off',
    baseBranch: null,
  });
  const proposal = { ...f.proposal, id: 'codeprop_offline' };
  const count = f.calls.length;
  await f.state.transaction(async (tx) => {
    await f.publications.enqueue(f.caller, proposal, tx);
    await f.publications.recordReview(f.reviewer, proposal, 'review_offline', 'pass', tx);
  });
  assert.equal(f.calls.length, count);
  const record = (await f.publications.publications(f.caller)).find(
    (p) => p.proposalId === proposal.id,
  )!;
  assert.equal(record.review?.verdict, 'pass');
  await f.sync();
  assert.equal(f.pulls.length, 0);
});

test('a superseded merge lock prevents GitHub writes and does not record an unowned intent', async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.review();
  await f.sync();
  f.control.before = async (path) => {
    if (path.endsWith('/status')) {
      await f.state.transaction((tx) => tx.run("UPDATE code_publications SET lock_id='new-owner'"));
    }
  };
  await assert.rejects(
    f.publications.mergePublication(f.caller, {
      proposalId: f.proposal.id,
      expectedHead: headOid,
      expectedBase: baseOid,
      requestId: 'merge',
    }),
    { code: 'publication_busy' },
  );
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
  assert.equal((await f.publications.publications(f.caller))[0].merge, null);
});

test('repository relinking fences publications, and verdict rollback leaves the draft unapproved', async (t) => {
  const f = await setup(t);
  await f.sync();
  await assert.rejects(
    f.state.transaction(async (tx) => {
      await f.publications.recordReview(f.reviewer, f.proposal, 'review_fixture', 'pass', tx);
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal((await f.publications.publications(f.caller))[0].review, null);
  await f.github.link(f.caller, { expectedRevision: 3, repositoryId: 101, installationId: 17 });
  await f.enable();
  assert.equal((await f.sync()).lastError, 'github_conflict');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
});

test(
  'PostgreSQL retains publication/review bindings and recovers an uncertain PR across service instances',
  { skip: !process.env.MERV_TEST_POSTGRES_URL },
  async (t) => {
    const connectionString = process.env.MERV_TEST_POSTGRES_URL!,
      schema = `github_pub_${randomUUID().replaceAll('-', '')}`;
    const state = await PostgresState.open({ connectionString, schema });
    t.after(async () => {
      await state.close();
      const pool = new Pool({ connectionString });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });
    const f = await setup(t, state);
    f.control.loseCreateReply = true;
    assert.equal((await f.sync()).pull?.draft, true);
    await f.review();
    const secondState = await PostgresState.open({ connectionString, schema });
    t.after(() => secondState.close());
    const secondScope = await createService(new ProjectScope(secondState));
    const secondGitHub = await createService(
      new CodeGitHubService(secondState, secondScope, config, f.fetcher),
    );
    t.after(() => secondGitHub.close());
    const restarted = await createService(
      new CodePublicationService(secondState, secondScope, secondGitHub, f.transport),
    );
    assert.equal((await restarted.publications(f.caller))[0].review?.verdict, 'pass');
    const ready = (await restarted.syncPublications(f.caller))[0];
    assert.equal(ready.pull?.draft, false);
    assert.equal(f.pulls.length, 1);
  },
);
