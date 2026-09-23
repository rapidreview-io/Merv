import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CodePublicationService } from '../packages/code-research/src/publications.js';
import type { CodeTransportService } from '../packages/code-research/src/transport.js';
import type { CodeProposal } from '../packages/code-research/src/types.js';
import {
  baseOid,
  githubFixture,
  headOid,
  mergeOid,
  repository,
  treeOid,
} from './github-fixture.js';
// Loaded at top level so its cleanup hook belongs to the file, not to the first githubFixture test.
import './fixtures/state.js';

async function setup(t: TestContext) {
  const f = await githubFixture(t);
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

/** Retained envelopes must not consume the reconciliation slot of live work. */
async function retainedPublications(f: Awaited<ReturnType<typeof setup>>) {
  await f.state.transaction(async (tx) => {
    const original = await tx.get<{ record_json: string; binding_json: string }>(
      'SELECT record_json,binding_json FROM code_publications WHERE proposal_id=?',
      f.proposal.id,
    );
    for (let i = 0; i < 101; i++) {
      const id = `aaa_retired_${String(i).padStart(3, '0')}`;
      const record = {
        ...JSON.parse(original!.record_json),
        proposalId: id,
        approval: {
          ...(i % 2 ? { source: 'consolidation' } : {}),
          integrationBase: baseOid,
          certificateHash: 'retained',
          acceptanceHash: 'retained',
        },
      };
      await tx.run(
        'INSERT INTO code_publications(proposal_id,project_id,record_json,binding_json) VALUES(?,?,?,?)',
        id,
        f.caller.projectId,
        JSON.stringify(record),
        original!.binding_json,
      );
    }
  });
}

test('retired publications remain untouched and cannot starve current proposals', async (t) => {
  const f = await setup(t);
  await retainedPublications(f);
  assert.equal((await f.sync()).pull?.draft, true);
  assert.equal(f.pulls.length, 1);
  const changed = await f.state.read((sql) =>
    sql.all(
      "SELECT proposal_id FROM code_publications WHERE proposal_id LIKE 'aaa_retired_%' AND (pull_json IS NOT NULL OR error IS NOT NULL OR synced_at <> '')",
    ),
  );
  assert.deepEqual(changed, []);
});

test('draft PR creation recovers a lost response and independent approval readies exactly that proposal', async (t) => {
  const f = await setup(t);
  f.control.loseCreateReply = true;
  const source = structuredClone(f.caller);
  const syncing = f.publications.syncPublications(source);
  source.actorId = 'missing';
  const draft = (await syncing)[0];
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
  const mergingCaller = structuredClone(f.caller);
  const merging = restarted.mergePublication(mergingCaller, {
    proposalId: f.proposal.id,
    expectedHead: headOid,
    expectedBase: baseOid,
    requestId: 'merge',
  });
  mergingCaller.actorId = 'missing';
  const merged = await merging;
  assert.equal(merged.pull?.merged, true);
  assert.equal(merged.merge?.commitSha, mergeOid);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 1);
});

test('publication reads retain their original reader', async (t) => {
  const f = await setup(t);
  for (const method of ['publications', 'publicationDetails'] as const) {
    await t.test(method, async () => {
      const caller = { ...structuredClone(f.caller), actorId: 'missing' };
      const pending =
        method === 'publications'
          ? f.publications.publications(caller)
          : f.publications.publicationDetails(caller, f.proposal.id);
      Object.assign(caller, f.caller);
      await assert.rejects(pending, { code: 'membership_required' });
    });
  }
});

test('a proposal edit cannot turn a pending self-review into an independent approval', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.state.transaction(async (tx) => {
      const proposal = structuredClone(f.proposal);
      const pending = f.publications.recordReview(f.caller, proposal, 'self', 'pass', tx);
      proposal.producer.actorId = f.reviewer.actorId;
      await pending;
    }),
    { code: 'self_review' },
  );
  assert.equal((await f.publications.publications(f.caller))[0].review, null);
  await f.review();
  assert.equal(
    (await f.publications.publications(f.caller))[0].review?.actorId,
    f.reviewer.actorId,
  );
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
    const source = structuredClone(f.caller),
      supplied = structuredClone(proposal);
    const enqueue = f.publications.enqueue(source, supplied, tx);
    source.projectId = 'missing';
    supplied.id = 'changed';
    supplied.receipt.headOid = 'e'.repeat(40);
    await enqueue;
    const reviewer = structuredClone(f.reviewer);
    const reviewing = f.publications.recordReview(reviewer, proposal, 'review_offline', 'pass', tx);
    reviewer.actorId = f.caller.actorId;
    await reviewing;
  });
  assert.equal(f.calls.length, count);
  const record = (await f.publications.publications(f.caller)).find(
    (p) => p.proposalId === proposal.id,
  )!;
  assert.equal(record.review?.verdict, 'pass');
  assert.equal(record.headOid, headOid);
  assert.equal(record.review?.actorId, f.reviewer.actorId);
  await f.sync();
  assert.equal(f.pulls.length, 0);
});

test('publication writes stop when automation is disabled or the lock expires or changes', async (t) => {
  for (const action of ['create', 'ready', 'close'] as const) {
    for (const failure of ['revoked', 'expired', 'replaced'] as const) {
      await t.test(`${action}: ${failure}`, async (t) => {
        const f = await setup(t);
        if (action !== 'create') {
          await f.sync();
          await f.review(action === 'ready' ? 'pass' : 'needs_changes');
        }
        let successor: unknown;
        const stored = () =>
          f.state.read((sql) =>
            sql.get('SELECT lock_id,lock_until,error,synced_at,pull_json FROM code_publications'),
          );
        f.control.before = async (path) => {
          if (path.endsWith(action === 'create' ? '/pulls' : '/pulls/1')) {
            f.control.before = undefined;
            if (failure === 'revoked')
              await f.github.configureAutomation(f.caller, {
                expectedRevision: 3,
                mode: 'off',
                baseBranch: null,
              });
            else
              await f.state.transaction((tx) =>
                tx.run(
                  failure === 'replaced'
                    ? "UPDATE code_publications SET lock_id='new-owner',error='successor_error'"
                    : "UPDATE code_publications SET lock_until='2000-01-01T00:00:00.000Z'",
                ),
              );
            successor = await stored();
          }
        };
        const before = f.calls.length;
        const result = await f.sync();
        assert.deepEqual(
          f.calls
            .slice(before)
            .filter((call) => call.method !== 'GET')
            .map((call) => call.path),
          [],
        );
        if (failure === 'replaced') assert.deepEqual(await stored(), successor);
        else
          assert.equal(
            result.lastError,
            failure === 'revoked' ? 'github_automation_disabled' : 'publication_busy',
          );
        if (action === 'create') assert.equal(f.pulls.length, 0);
        else {
          assert.equal(f.pulls[0].draft, true);
          assert.equal(f.pulls[0].state, 'open');
        }
        if (failure === 'expired') assert.equal((await f.sync()).lastError, null);
      });
    }
  }
});

test('superseded and expired merge locks prevent GitHub writes and unowned intents', async (t) => {
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
  await f.state.transaction((tx) =>
    tx.run('UPDATE code_publications SET lock_id=NULL,lock_until=NULL'),
  );
  f.control.before = async (path) => {
    if (path.endsWith('/status'))
      await f.state.transaction((tx) =>
        tx.run("UPDATE code_publications SET lock_until='2000-01-01T00:00:00.000Z'"),
      );
  };
  await assert.rejects(
    f.publications.mergePublication(f.caller, {
      proposalId: f.proposal.id,
      expectedHead: headOid,
      expectedBase: baseOid,
      requestId: 'expired-merge',
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
