import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CodeUnitStore } from '@merv/code/units';
import type { PublicationHost } from '../packages/code-work/src/publication-host.js';
import {
  CodePublicationService,
  type CodeUnitPublicationSeal,
} from '../packages/code-work/src/publications.js';
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

/**
 * The publication journal on its own: a unit's publication opened with its passing review,
 * and a host whose repository checks all pass, so only the journal and GitHub are exercised.
 */
const host = {
  check: async () => {},
  reconcile: async () => {},
  ancestor: async () => true,
  snapshot: async () => {},
  import: async () => {},
  main: async () => {},
  rules: async () => [],
  verify: async () => baseOid,
  verifyLocal: async () => {},
} as unknown as PublicationHost;

const seal = (publicationId: string): CodeUnitPublicationSeal => ({
  publicationId,
  unitId: 'unit_fixture',
  title: 'Unit: fixture',
  reviewId: 'review_fixture',
  baseOid,
  headOid,
  treeOid,
  approval: {
    source: 'unit',
    integrationBase: baseOid,
    certificateHash: null,
    acceptanceHash: 'f'.repeat(64),
  },
});

/** Main as Code stores it; the journal reads nothing else of Code's binding. */
const units = (f: { state: ConstructorParameters<typeof CodeUnitStore>[0] }) =>
  new CodeUnitStore(f.state, undefined as never, undefined as never);

async function setup(t: TestContext) {
  const f = await githubFixture(t);
  await f.enable();
  const publications = await createService(
    new CodePublicationService(f.state, f.scope, f.github, units(f), host),
  );
  const open = (publicationId = 'codeprop_fixture') =>
    f.state.transaction((tx) => publications.openUnit(f.reviewer, seal(publicationId), tx));
  await open();
  const sync = async () => {
    await f.state.transaction((tx) => tx.run("UPDATE code_publications SET synced_at=''"));
    return (await publications.syncPublications(f.caller))[0];
  };
  const merge = (requestId = 'merge') => ({
    proposalId: 'codeprop_fixture',
    expectedHead: headOid,
    expectedBase: baseOid,
    requestId,
  });
  return { ...f, publications, open, sync, merge };
}

test('pull request creation recovers a lost response and readies exactly that publication', async (t) => {
  const f = await setup(t);
  f.control.loseCreateReply = true;
  const source = structuredClone(f.caller);
  const syncing = f.publications.syncPublications(source);
  source.actorId = 'missing';
  const ready = (await syncing)[0];
  assert.equal(ready.lastError, null);
  assert.equal(ready.pull?.draft, false);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.review?.verdict, 'pass');
  assert.equal(f.pulls.length, 1);
  await f.sync();
  assert.equal(f.pulls.length, 1);
  const restarted = await createService(
    new CodePublicationService(f.state, f.scope, f.github, units(f), host),
  );
  assert.equal((await restarted.publications(f.caller))[0].review?.id, 'review_fixture');
  const detail = await restarted.publicationDetails(f.caller, 'codeprop_fixture');
  assert.equal(detail.details?.pull.head.sha, headOid);
  const mergingCaller = structuredClone(f.caller);
  const merging = restarted.mergePublication(mergingCaller, f.merge());
  mergingCaller.actorId = 'missing';
  const merged = await merging;
  assert.equal(merged.pull?.merged, true);
  assert.equal(merged.merge?.commitSha, mergeOid);
  assert.equal(merged.verified, true);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 1);
});

test('publication details say where the pull request they just read stands', async (t) => {
  const f = await setup(t);
  await f.sync();
  // Merged on GitHub since Merv last synced.
  f.pulls[0].merged = true;
  f.pulls[0].state = 'closed';
  const { publication } = await f.publications.publicationDetails(f.caller, 'codeprop_fixture');
  assert.equal(publication.pull?.merged, true);
  assert.equal(publication.state, 'merged');
});

test('publication reads retain their original reader', async (t) => {
  const f = await setup(t);
  for (const method of ['publications', 'publicationDetails'] as const) {
    await t.test(method, async () => {
      const caller = { ...structuredClone(f.caller), actorId: 'missing' };
      const pending =
        method === 'publications'
          ? f.publications.publications(caller)
          : f.publications.publicationDetails(caller, 'codeprop_fixture');
      Object.assign(caller, f.caller);
      await assert.rejects(pending, { code: 'membership_required' });
    });
  }
});

test('changed PR heads and non-passing checks prevent merge', async (t) => {
  const f = await setup(t);
  await f.sync();
  f.control.checks = [
    { name: 'tests', status: 'completed', conclusion: 'failure', html_url: null },
  ];
  await assert.rejects(f.publications.mergePublication(f.caller, f.merge()), {
    code: 'github_checks_pending',
  });
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
  // A head nobody reviewed settles the publication stale: a successor takes the work.
  f.control.checks = [];
  f.pulls[0].head.sha = 'e'.repeat(40);
  const stale = await f.publications.mergePublication(f.caller, f.merge());
  assert.equal(stale.stale, true);
  assert.equal(stale.lastError, 'github_head_changed');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
});

test('lost merge replies reconcile to the actual merge without reissuing it', async (t) => {
  const f = await setup(t);
  await f.sync();
  f.control.loseMergeReply = true;
  await assert.rejects(f.publications.mergePublication(f.caller, f.merge()), {
    code: 'github_unavailable',
  });
  const recovered = await f.publications.mergePublication(f.caller, f.merge());
  assert.equal(recovered.merge?.commitSha, mergeOid);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 1);
});

test('a publication and its review stay durable while GitHub automation is disabled', async (t) => {
  const f = await setup(t);
  await f.github.configureAutomation(f.caller, {
    expectedRevision: 3,
    mode: 'off',
    baseBranch: null,
  });
  const count = f.calls.length;
  await f.open('codeprop_offline');
  assert.equal(f.calls.length, count);
  const record = (await f.publications.publications(f.caller)).find(
    (p) => p.proposalId === 'codeprop_offline',
  )!;
  assert.equal(record.review?.verdict, 'pass');
  assert.equal(record.headOid, headOid);
  assert.equal(record.review?.actorId, f.reviewer.actorId);
  await f.sync();
  assert.equal(f.pulls.length, 0);
});

test('publication writes stop when automation is disabled or the lock expires or changes', async (t) => {
  for (const action of ['create', 'ready'] as const) {
    for (const failure of ['revoked', 'expired', 'replaced'] as const) {
      await t.test(`${action}: ${failure}`, async (t) => {
        const f = await setup(t);
        let successor: unknown;
        const stored = () =>
          f.state.read((sql) =>
            sql.get('SELECT lock_id,lock_until,error,synced_at,pull_json FROM code_publications'),
          );
        // A request is authorized before it is sent, so the interruption lands on the one before
        // the write it must stop: the search for an existing pull request, or its creation.
        let pulls = 0;
        f.control.before = async (path) => {
          if (path.endsWith('/pulls') && ++pulls === (action === 'create' ? 1 : 2)) {
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
        const writes = f.calls.slice(before).filter((call) => call.method !== 'GET');
        // Nothing past the interruption was written.
        assert.deepEqual(
          writes.filter((call) =>
            action === 'create' ? call.path.endsWith('/pulls') : call.path.includes('/statuses/'),
          ),
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
  f.control.before = async (path) => {
    if (path.endsWith('/status')) {
      await f.state.transaction((tx) => tx.run("UPDATE code_publications SET lock_id='new-owner'"));
    }
  };
  await assert.rejects(f.publications.mergePublication(f.caller, f.merge()), {
    code: 'publication_busy',
  });
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
  await assert.rejects(f.publications.mergePublication(f.caller, f.merge('expired-merge')), {
    code: 'publication_busy',
  });
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
  assert.equal((await f.publications.publications(f.caller))[0].merge, null);
});

test('repository relinking fences publications', async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.github.link(f.caller, { expectedRevision: 3, repositoryId: 101, installationId: 17 });
  await f.enable();
  assert.equal((await f.sync()).lastError, 'github_conflict');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/merge')).length, 0);
});

test('an exact completed merge retry returns its saved receipt without GitHub access', async (t) => {
  const f = await setup(t);
  await f.sync();
  const input = f.merge('completed-retry');
  const first = await f.publications.mergePublication(f.caller, input);
  assert.equal(first.pull?.merged, true);
  const calls = f.calls.length;
  await f.github.disconnect(f.caller, { expectedRevision: 3 });
  assert.deepEqual(await f.publications.mergePublication(f.caller, input), first);
  assert.equal(f.calls.length, calls, 'reading the saved receipt needs no remote credential');
  await assert.rejects(
    f.publications.mergePublication(f.caller, { ...input, expectedBase: headOid }),
    { code: 'publication_conflict' },
  );
  await assert.rejects(
    f.publications.mergePublication(f.caller, { ...input, requestId: 'different-request' }),
    { code: 'publication_conflict' },
  );
  await assert.rejects(f.publications.mergePublication(f.reviewer, input), {
    code: 'publication_conflict',
  });
});
