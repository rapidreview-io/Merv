import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CodeGitRemote } from '@merv/code/store/http';
import { MervError, type Caller } from '@merv/contracts';
import { writerFixture } from './fixtures/code-writers.js';
import { gitSource, recoverLegacyOperation, seedLegacyOperation } from './fixtures/code-store.js';
const exec = promisify(execFile);

async function fixture(t: TestContext, fault?: ConstructorParameters<typeof CodeGitRemote>[4]) {
  const f = await writerFixture(t);
  const remote = new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers, fault);
  await remote.initialize();
  const credential = await f.scope.credentials.issueActorCredential(f.admin, {
    actorId: f.admin.actorId,
  });
  const uploadPackEncodings: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/git-upload-pack'))
      uploadPackEncodings.push(req.headers['content-encoding']);
    void remote.handle(req, res, new URL(req.url!, 'http://localhost')).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(error instanceof MervError ? error.status : 500);
      res.end(error instanceof MervError ? `${error.code}: ${error.message}` : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/git/${f.admin.projectId}.git`;
  const git = async (cwd: string, args: string[], token = credential.token) =>
    (
      await exec('git', args, {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`merv:${token}`).toString('base64')}`,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
        },
        maxBuffer: 8 * 1024 ** 2,
      })
    ).stdout.trim();
  const session = async (id: string, readOnly = false) => {
    if (readOnly) await f.reviewer(id, f.root);
    else await f.lease(id);
    return await remote.issue(f.admin, {
      sessionId: id,
      runnerId: 'runner-1',
      hostRef: `launch-${id}`,
      unitId: f.unitId,
      generation: readOnly ? null : (await f.unit()).generation,
      leaseId: id,
      mode: readOnly ? 'read' : 'write',
    });
  };
  return { ...f, remote, url, git, session, credential, uploadPackEncodings };
}

test('ordinary Git clones and incrementally pushes named user branches, preserving history and refusing reserved refs, deletion and divergence', async (t) => {
  const f = await fixture(t);
  const local = join(f.directory, 'clone');
  await f.git(f.directory, ['clone', f.url, local]);
  assert.equal(await f.git(local, ['rev-parse', 'HEAD']), f.root);
  assert.equal(await f.git(local, ['branch', '--show-current']), 'merv-main');
  await f.git(local, ['checkout', '-b', 'main']);
  writeFileSync(join(local, 'first.txt'), 'first\n');
  await f.git(local, ['add', '.']);
  await f.git(local, ['commit', '-m', 'first']);
  const first = await f.git(local, ['rev-parse', 'HEAD']);
  await f.git(local, ['push', 'origin', 'main']);
  writeFileSync(join(local, 'second.txt'), 'second\n');
  await f.git(local, ['add', '.']);
  await f.git(local, ['commit', '-m', 'second']);
  const second = await f.git(local, ['rev-parse', 'HEAD']);
  await f.git(local, ['push', 'origin', 'main']);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/main'), second);
  assert.ok(await f.core.repositories.ancestor(f.admin.projectId, first, second));
  await assert.rejects(
    f.git(local, ['push', '--force', 'origin', `${first}:main`]),
    /non.fast.forward|rejected/,
  );
  await assert.rejects(f.git(local, ['push', 'origin', ':main']), /delet|rejected/);
  await assert.rejects(f.git(local, ['push', 'origin', 'HEAD:merv-main']), /reserved|rejected/);
  await assert.rejects(f.git(local, ['push', 'origin', 'HEAD:merv/user']), /reserved|rejected/);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/merv-main'),
    f.root,
  );
});

test('the reserved merv ancestor is refused before any research branch exists', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.git(f.source.repository, ['push', f.url, 'HEAD:merv']), /reserved/);
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, 'HEAD:merv-main/archive']),
    /reserved/,
  );
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/merv'), null);
  const access = await f.session('ses_reserved_ancestor');
  const head = f.source.commit({ 'research.txt': 'research after rejected user push\n' });
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], access.token);
  assert.equal((await f.unit()).canonicalHead, head);
  assert.match(await f.git(f.directory, ['ls-remote', f.url]), new RegExp(head));
  assert.deepEqual(await pendingPushes(f), []);
});

for (const blocked of ['merv', 'merv/work', 'merv-main/archive', 'work-child']) {
  test(`existing reserved namespace collision ${blocked} requires an explicit history-preserving move`, async (t) => {
    const f = await fixture(t);
    const head = f.source.commit({ 'user.txt': 'existing user history must survive\n' });
    await f.deliver(f.source.bundle(head, [f.root]));
    const ref = `refs/heads/${blocked === 'work-child' ? `merv/work/${f.unitId}/child` : blocked}`;
    const env = f.core.repositories.environment(f.admin.projectId);
    await f.core.repositories.git.ok(['update-ref', ref, head], { env });
    const access = await f.session('ses_existing_collision');
    const refs = async () =>
      (
        await f.core.repositories.git.ok(['for-each-ref', '--format=%(refname) %(objectname)'], {
          env,
        })
      ).toString();
    const before = await refs();
    for (const service of ['git-upload-pack', 'git-receive-pack']) {
      const response = await fetch(`${f.url}/info/refs?service=${service}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`merv:${f.credential.token}`).toString('base64')}`,
        },
      });
      assert.equal(response.status, 409);
      const message = await response.text();
      assert.match(message, /code_ref_collision/);
      assert.ok(message.includes(ref), message);
      assert.ok(message.includes(head), message);
      assert.match(message, /administrator.*move.*non-reserved branch.*server repository/i);
      assert.equal(await refs(), before, 'preflight must not change any ref');
    }
    await f.remote.initialize();
    assert.equal(await refs(), before, 'restart must not rename or delete existing history');
    assert.deepEqual(await pendingPushes(f), []);

    // An operator explicitly chooses the destination in the server repository. Git's
    // branch rename preserves the commit; the remote never makes this choice itself.
    await f.core.repositories.git.ok(
      ['branch', '-m', ref.slice('refs/heads/'.length), 'recovered-user-history'],
      { env },
    );
    const clone = join(f.directory, 'recovered-clone');
    await f.git(f.directory, ['clone', f.url, clone]);
    assert.equal(await f.git(clone, ['rev-parse', 'origin/recovered-user-history']), head);
    assert.equal(await f.git(clone, ['rev-parse', 'HEAD']), f.root);
    await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], access.token);
    assert.equal((await f.unit()).canonicalHead, head);
    assert.equal(
      await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/recovered-user-history'),
      head,
    );
    await f.git(clone, ['fetch', 'origin']);
    await f.git(clone, ['fsck', '--strict', '--no-dangling']);
    assert.deepEqual(await pendingPushes(f), []);
  });
}

test('a newer legacy work ref advances its visible alias and legacy recovery still updates that branch', async (t) => {
  const f = await fixture(t);
  const sessionId = 'ses_legacy_work';
  await f.session(sessionId);
  const legacy = f.source.commit({ 'legacy.txt': 'retained legacy work\n' });
  await f.deliver(f.source.bundle(legacy, [f.root]));
  const internal = `refs/merv/work/${f.unitId}`;
  const visible = `refs/heads/merv/work/${f.unitId}`;
  const env = f.core.repositories.environment(f.admin.projectId);
  await f.core.repositories.git.ok(['update-ref', internal, legacy], { env });
  await f.core.repositories.git.ok(['update-ref', visible, f.root], { env });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_workspaces SET head_oid=? WHERE project_id=? AND unit_id=?',
      legacy,
      f.admin.projectId,
      f.unitId,
    ),
  );
  await f.git(f.source.repository, ['ls-remote', f.url]);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, visible), legacy);
  assert.equal(
    (await f.core.repositories.git.ok(['symbolic-ref', internal], { env })).toString().trim(),
    visible,
  );

  const next = f.source.commit({ 'legacy.txt': 'last persisted legacy update\n' });
  const bundle = f.source.bundle(next, [legacy]);
  const id = await seedLegacyOperation(f.code, f.admin, bundle, {
    upload: {
      format: 1,
      source: 'upload',
      actorId: f.admin.actorId,
      kind: 'checkpoint',
      runnerId: 'runner-1',
      hostRef: `launch-${sessionId}`,
      sessionId,
      leaseId: sessionId,
      unitId: f.unitId,
      generation: 1,
      commandId: 'legacy_recovery',
      expectedHead: legacy,
      tip: next,
      treeOid: f.source.git('rev-parse', `${next}^{tree}`),
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    },
  });
  assert.equal((await recoverLegacyOperation(f.code, id)).status, 'completed');
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, internal), next);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, visible), next);
  assert.equal((await f.unit()).canonicalHead, next);
});

test('divergent legacy and visible work refs are preserved until explicitly reconciled', async (t) => {
  const f = await fixture(t);
  await f.session('ses_legacy_divergence');
  const legacy = f.source.commit({ 'legacy.txt': 'legacy history\n' });
  await f.deliver(f.source.bundle(legacy, [f.root]));
  f.source.git('checkout', '-B', 'other', f.root);
  const other = f.source.commit({ 'other.txt': 'separate history\n' });
  await f.deliver(f.source.bundle(other, [f.root]));
  const internal = `refs/merv/work/${f.unitId}`;
  const visible = `refs/heads/merv/work/${f.unitId}`;
  const env = f.core.repositories.environment(f.admin.projectId);
  await f.core.repositories.git.ok(['update-ref', internal, legacy], { env });
  await f.core.repositories.git.ok(['update-ref', visible, other], { env });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_workspaces SET head_oid=? WHERE project_id=? AND unit_id=?',
      legacy,
      f.admin.projectId,
      f.unitId,
    ),
  );
  await assert.rejects(f.git(f.source.repository, ['ls-remote', f.url]), /409|colli|diverg/i);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, internal), legacy);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, visible), other);
  assert.equal(
    (await f.core.repositories.git.run(['symbolic-ref', '-q', internal], { env })).code,
    1,
  );
  assert.equal((await f.unit()).canonicalHead, legacy);
  assert.deepEqual(await pendingPushes(f), []);
});

test('ordinary Git fetch accepts gzip negotiation for sixty independent branch tips', async (t) => {
  const f = await fixture(t);
  const local = join(f.directory, 'clone');
  await f.git(f.directory, ['clone', f.url, local]);
  const tips = new Map<string, string>();
  for (let index = 0; index < 60; index++) {
    f.source.git('checkout', '-B', 'main', f.root);
    tips.set(`branch-${index}`, f.source.commit({ [`branch-${index}.txt`]: `branch ${index}\n` }));
  }
  await f.git(f.source.repository, [
    'push',
    f.url,
    ...[...tips].map(([name, head]) => `${head}:refs/heads/${name}`),
  ]);
  f.uploadPackEncodings.length = 0;
  await f.git(local, ['fetch', 'origin']);
  assert.ok(f.uploadPackEncodings.includes('gzip'), 'ordinary Git sent compressed negotiation');
  for (const [name, head] of tips)
    assert.equal(await f.git(local, ['rev-parse', `refs/remotes/origin/${name}`]), head, name);
  await f.git(local, ['fsck', '--strict', '--no-dangling']);
});

/** Git's per-ref result is authoritative even when a non-atomic push partly succeeds. */
async function rejectedPush(
  f: Awaited<ReturnType<typeof fixture>>,
  refs: string[],
  atomic: boolean,
): Promise<Map<string, boolean>> {
  let report = '';
  await assert.rejects(
    f.git(f.source.repository, [
      'push',
      '--porcelain',
      ...(atomic ? ['--atomic'] : []),
      f.url,
      ...refs.map((ref) => `HEAD:${ref}`),
    ]),
    (error: unknown) => {
      report = (error as { stdout?: string }).stdout ?? '';
      return /rejected/.test(report);
    },
  );
  const outcomes = new Map<string, boolean>();
  for (const line of report.split('\n')) {
    const [flag, mapping] = line.split('\t');
    if (mapping?.includes(':')) outcomes.set(mapping.slice(mapping.indexOf(':') + 1), flag !== '!');
  }
  assert.deepEqual([...outcomes.keys()].sort(), [...refs].sort(), report);
  return outcomes;
}

const pendingPushes = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.state.read((sql) =>
    sql.all<{ id: string }>(
      "SELECT id FROM code_git_pushes WHERE project_id=? AND status='prepared'",
      f.admin.projectId,
    ),
  );

async function assertHealthyAfterRejectedPush(
  f: Awaited<ReturnType<typeof fixture>>,
  expected: Map<string, string | null>,
) {
  assert.deepEqual(
    await pendingPushes(f),
    [],
    'a rejected Git transaction must not leave an admitted journal that poisons recovery',
  );
  await new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers).initialize();
  const advertised = new Map(
    (await f.git(f.source.repository, ['ls-remote', f.url])).split('\n').map((line) => {
      const [head, ref] = line.split('\t');
      return [ref, head];
    }),
  );
  for (const [ref, head] of expected) {
    assert.equal(await f.core.repositories.resolve(f.admin.projectId, ref), head, ref);
    assert.equal(advertised.get(ref) ?? null, head, `${ref} advertisement`);
  }
  const local = join(f.directory, 'after-rejection');
  await f.git(f.directory, ['clone', f.url, local]);
  assert.equal(await f.git(local, ['rev-parse', 'HEAD']), f.root);
  const next = f.source.commit({ 'after-rejection.txt': 'remote remains writable\n' });
  await f.git(f.source.repository, ['push', f.url, 'HEAD:refs/heads/after-rejection']);
  await f.git(local, ['fetch', 'origin']);
  assert.equal(await f.git(local, ['rev-parse', 'refs/remotes/origin/after-rejection']), next);
}

for (const atomic of [false, true]) {
  for (const existing of ['topic', 'topic/child'])
    test(`existing ${existing} rejects a conflicting branch without poisoning ${atomic ? 'atomic' : 'non-atomic'} pushes`, async (t) => {
      const f = await fixture(t);
      const retained = `refs/heads/${existing}`;
      const rejected = `refs/heads/${existing === 'topic' ? 'topic/child' : 'topic'}`;
      const independent = 'refs/heads/independent';
      await f.git(f.source.repository, ['push', f.url, `HEAD:${retained}`]);
      const head = f.source.commit({ 'new.txt': 'new candidate\n' });
      const outcomes = await rejectedPush(f, [rejected, independent], atomic);
      assert.equal(outcomes.get(rejected), false);
      assert.equal(
        outcomes.get(independent),
        !atomic,
        'Git accepts the independent ref only without --atomic',
      );
      await assertHealthyAfterRejectedPush(
        f,
        new Map([
          [retained, f.root],
          [rejected, null],
          [independent, atomic ? null : head],
        ]),
      );
    });

  for (const refs of [
    ['refs/heads/topic', 'refs/heads/topic/child'],
    ['refs/heads/topic/child', 'refs/heads/topic'],
  ])
    test(`one ${atomic ? 'atomic' : 'non-atomic'} push of ${refs.map((ref) => ref.slice(11)).join(' then ')} cannot poison its ref namespace`, async (t) => {
      const f = await fixture(t);
      const head = f.source.commit({ 'candidate.txt': 'candidate\n' });
      const outcomes = await rejectedPush(f, refs, atomic);
      assert.equal([...outcomes.values()].filter(Boolean).length, atomic ? 0 : 1);
      await assertHealthyAfterRejectedPush(
        f,
        new Map(refs.map((ref) => [ref, outcomes.get(ref) ? head : null])),
      );
    });
}

test('native receive admission rejects unsafe paths and secret objects without moving any ref', async (t) => {
  const f = await fixture(t);
  const source = gitSource(t);
  const safe = source.commit({ 'safe.txt': 'safe\n' });
  source.commit({ 'secret.txt': '-----BEGIN PRIVATE KEY-----\nabc\n' });
  source.commit({ 'secret.txt': null });
  await assert.rejects(
    f.git(source.repository, ['push', f.url, `${safe}:refs/heads/safe`, 'HEAD:unsafe']),
    /admission|rejected/,
  );
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/safe'), null);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/unsafe'), null);
});

test('native receive admits a packed history beyond the loose-object threshold', async (t) => {
  const f = await fixture(t);
  rmSync(f.paths.quarantine, { recursive: true, force: true });
  f.source.commit(
    Object.fromEntries(
      Array.from({ length: 160 }, (_, index) => [`many/${index}.txt`, `content ${index}\n`]),
    ),
  );
  await f.git(f.source.repository, ['push', f.url, 'HEAD:packed']);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/packed'),
    f.source.git('rev-parse', 'HEAD'),
  );
});

test('native receive rejects committed Merv Git and user credentials', async (t) => {
  const f = await fixture(t);
  const grant = await f.session('ses_credential_admission');
  f.source.commit({
    'access.txt': `${grant.agentToken}\nmk_${'A'.repeat(43)}\nmr_${'1'.repeat(64)}\n`,
  });
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, 'HEAD:credentials']),
    /admission|rejected/,
  );
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/credentials'),
    null,
  );
});

test('scoped workers push only their assigned branch; reviewers and stale generations cannot push', async (t) => {
  const f = await fixture(t);
  const worker = await f.session('ses_git_writer');
  const branch = `merv/work/${f.unitId}`;
  f.source.commit({ 'worker.txt': 'work\n' });
  await f.git(f.source.repository, ['push', f.url, `HEAD:${branch}`], worker.agentToken);
  const head = f.source.git('rev-parse', 'HEAD');
  assert.equal((await f.unit()).canonicalHead, head);
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, 'HEAD:other'], worker.agentToken),
    /assigned branch|rejected/,
  );
  const reviewer = await f.session('ses_git_reviewer', true);
  await f.git(f.source.repository, ['ls-remote', f.url], reviewer.agentToken);
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `HEAD:${branch}`], reviewer.agentToken),
    /403|read.only/,
  );
  await f.event('session.closed', 'ses_git_writer');
  await f.session('ses_git_successor');
  f.source.commit({ 'stale.txt': 'must not arrive\n' });
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `HEAD:${branch}`], worker.agentToken),
    /403|another writer|ended/i,
  );
  assert.equal((await f.unit()).canonicalHead, head);
});

test('ordinary Git resolution preserves the frozen ordered parents and records merge provenance', async (t) => {
  const f = await fixture(t);
  const right = f.source.commit({ 'right.txt': 'frozen right\n' });
  await f.git(f.source.repository, ['push', f.url, 'HEAD:resolution-right']);
  f.source.git('checkout', '-B', 'main', f.root);
  const left = f.source.commit({ 'left.txt': 'working left\n' });
  const sessionId = 'ses_resolution_git';
  const grant = await f.session(sessionId);
  await f.state.transaction((tx) =>
    tx.run(
      'INSERT INTO code_pending_merges(project_id,unit_id,plan_key,left_oid,right_oid,head_oid) VALUES(?,?,?,?,?,?)',
      f.admin.projectId,
      f.unitId,
      'frozen-plan',
      f.root,
      right,
      f.root,
    ),
  );
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], grant.agentToken);
  f.source.git('merge', '--no-ff', '-m', 'resolve frozen inputs', right);
  const head = f.source.git('rev-parse', 'HEAD');
  assert.equal(f.source.git('rev-list', '--parents', '-n', '1', head), `${head} ${left} ${right}`);
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], grant.agentToken);
  const operation = await f.remote.acknowledge(f.admin, {
    sessionId,
    unitId: f.unitId,
    generation: 1,
    leaseId: sessionId,
    expectedHead: left,
    proposedHead: head,
    treeOid: f.source.git('rev-parse', 'HEAD^{tree}'),
    kind: 'checkpoint',
    commandId: 'resolution_receipt',
  });
  const recorded = await f.state.read((sql) =>
    sql.get<{ result_json: string }>(
      'SELECT result_json FROM code_operations WHERE id=?',
      operation.id,
    ),
  );
  assert.deepEqual(JSON.parse(recorded!.result_json).merge, {
    plan: 'frozen-plan',
    left: f.root,
    right,
    firstMerge: head,
  });
  f.source.git('checkout', '-B', 'extra', right);
  f.source.commit({ 'extra.txt': 'not a frozen input\n' });
  f.source.git('checkout', 'main');
  f.source.git('merge', '--no-ff', '-m', 'extra merge', 'extra');
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], grant.agentToken),
    /frozen right|later rounds|rejected/,
  );
  assert.equal((await f.unit()).canonicalHead, head);
});

test('frozen submission transfers tree and parent without a commit; approval reuses exact tree and is idempotent', async (t) => {
  const f = await fixture(t);
  const grant = await f.session('ses_git_freeze');
  writeFileSync(join(f.source.repository, 'candidate.txt'), 'reviewed\n');
  f.source.git('add', '.');
  const tree = f.source.git('write-tree');
  const prefix = 'refs/merv/submissions/ses_git_freeze';
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `${tree}:${prefix}/nested/tree`], grant.token),
    /submission ref|rejected/,
  );
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `${tree}:${prefix}/tree`], grant.agentToken),
    /assigned branch|rejected/,
  );
  await f.git(
    f.source.repository,
    ['push', f.url, `${tree}:${prefix}/tree`, `${f.root}:${prefix}/parent`],
    grant.token,
  );
  assert.equal(f.source.git('rev-parse', 'HEAD'), f.root);
  await f.remote.verifySubmission(f.admin.projectId, {
    sessionId: 'ses_git_freeze',
    parentOid: f.root,
    treeOid: tree,
  });
  writeFileSync(join(f.source.repository, 'candidate.txt'), 'later edit\n');
  const input = {
    sessionId: 'ses_git_freeze',
    parentOid: f.root,
    treeOid: tree,
    approvalId: 'approval_one',
    createdAt: '2026-10-21T00:00:00Z',
    message: 'Approved plan',
    unitId: f.unitId,
  };
  const approved = await f.remote.materializeSubmission(f.admin.projectId, input);
  const replay = await f.remote.materializeSubmission(f.admin.projectId, input);
  assert.deepEqual(approved, replay);
  assert.notEqual(approved.head, f.root);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, `${approved.head}^{tree}`),
    tree,
  );
  assert.equal(
    (
      await f.core.repositories.git.ok(['show', `${approved.head}:candidate.txt`], {
        env: f.core.repositories.environment(f.admin.projectId),
      })
    ).toString(),
    'reviewed\n',
  );
});

test('approval reuses an acknowledged shutdown capture of the frozen tree, while refusing an unacknowledged same-tree descendant', async (t) => {
  const f = await fixture(t);
  const sessionId = 'ses_shutdown_review';
  const grant = await f.session(sessionId);
  writeFileSync(join(f.source.repository, 'reviewed.txt'), 'frozen\n');
  f.source.git('add', '.');
  const treeOid = f.source.git('write-tree');
  await f.git(
    f.source.repository,
    [
      'push',
      f.url,
      `${treeOid}:refs/merv/submissions/${sessionId}/tree`,
      `${f.root}:refs/merv/submissions/${sessionId}/parent`,
    ],
    grant.token,
  );
  await f.event('session.closed', sessionId);
  await f.end(sessionId);
  const shutdown = await f.remote.issueShutdown(f.admin, {
    sessionId,
    runnerId: 'runner-1',
    hostRef: `launch-${sessionId}`,
    unitId: f.unitId,
    generation: 1,
    leaseId: sessionId,
  });
  f.source.git('commit', '-qm', 'planned shutdown');
  const head = f.source.git('rev-parse', 'HEAD');
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], shutdown.token);
  const input = {
    sessionId,
    parentOid: f.root,
    treeOid,
    approvalId: 'review_after_shutdown',
    createdAt: '2026-10-21T00:00:00Z',
    message: 'approved',
    unitId: f.unitId,
  };
  await assert.rejects(
    f.remote.materializeSubmission(f.admin.projectId, input),
    /producer branch changed/,
  );
  await f.remote.acknowledge(f.admin, {
    sessionId,
    unitId: f.unitId,
    generation: 1,
    leaseId: sessionId,
    expectedHead: f.root,
    proposedHead: head,
    treeOid,
    kind: 'final',
  });
  const approved = await f.remote.materializeSubmission(f.admin.projectId, input);
  assert.equal(approved.head, head);
  assert.deepEqual(await f.remote.materializeSubmission(f.admin.projectId, input), approved);
  assert.equal(await f.core.repositories.resolve(f.admin.projectId, approved.ref), head);
  assert.equal(f.source.git('rev-list', '--count', `${f.root}..${head}`), '1');
});

for (const point of ['after_objects', 'after_journal', 'after_refs'] as const)
  test(`interrupted native push after ${point.slice(6)} recovers only Git's actual ref outcome`, async (t) => {
    let fired = false;
    const f = await fixture(t, (reached) => {
      if (reached === point && !fired) {
        fired = true;
        throw new Error('crash');
      }
    });
    const head = f.source.commit({ 'durable.txt': 'one\n' });
    const push = f.git(f.source.repository, ['push', f.url, 'HEAD:recovery']);
    // Once Git wrote refs, losing the HTTP reply cannot turn that write into rejection.
    if (point === 'after_refs') await push.catch(() => {});
    else await assert.rejects(push, /rejected/);
    assert.equal(fired, true, `reached ${point}`);
    const actual = await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/recovery');
    assert.equal(actual, point === 'after_refs' ? head : null);
    const restarted = new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers);
    await restarted.initialize();
    assert.equal(
      await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/recovery'),
      actual,
      'recovery projects the native outcome and never applies a rejected proposal',
    );
    assert.deepEqual(await pendingPushes(f), []);
    await f.git(f.source.repository, ['push', f.url, 'HEAD:recovery']);
    assert.equal(await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/recovery'), head);
  });

test('shutdown capture gets a separate capability only after the writer stopped and before any successor', async (t) => {
  const f = await fixture(t);
  const id = 'ses_shutdown';
  const grant = await f.session(id);
  const input = {
    sessionId: id,
    runnerId: 'runner-1',
    hostRef: `launch-${id}`,
    unitId: f.unitId,
    generation: 1,
    leaseId: id,
  };
  await assert.rejects(f.remote.issueShutdown(f.admin, input), /Stop the writer/);
  await f.event('session.closed', id);
  await f.state.transaction((tx) =>
    tx.run("UPDATE worker_sessions SET status='released' WHERE id=?", id),
  );
  const shutdown = await f.remote.issueShutdown(f.admin, input);
  f.source.commit({ 'shutdown.txt': 'captured before release\n' });
  const head = f.source.git('rev-parse', 'HEAD');
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], grant.token),
    /403/,
  );
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], shutdown.token);
  const receipt = await f.remote.acknowledge(f.admin, {
    sessionId: id,
    unitId: f.unitId,
    generation: 1,
    leaseId: id,
    expectedHead: f.root,
    proposedHead: head,
    treeOid: f.source.git('rev-parse', 'HEAD^{tree}'),
    kind: 'final',
  });
  assert.equal(receipt.head, head);
  assert.equal((await f.unit()).writerState, 'closed');
  await f.session('ses_next');
  await assert.rejects(f.remote.issueShutdown(f.admin, input), /Another writer/);
});

test('stopped runner capture seals an own-end closing writer while agent grants remain invalid', async (t) => {
  const f = await fixture(t);
  const sessionId = 'ses_own_end_capture';
  const ordinary = await f.session(sessionId);
  await f.event('session.workspace_attached', sessionId);
  await f.event('session.closed', sessionId, true);
  await f.end(sessionId, 'handoff');
  const input = {
    sessionId,
    runnerId: 'runner-1',
    hostRef: `launch-${sessionId}`,
    unitId: f.unitId,
    generation: 1,
    leaseId: sessionId,
    stopped: true as const,
  };
  const capture = await f.remote.issueCapture(f.admin, input);
  assert.equal('agentToken' in capture, false);
  f.source.commit({ 'deliberate.txt': 'explicit agent commit before handoff\n' });
  const parent = f.source.git('rev-parse', 'HEAD');
  writeFileSync(join(f.source.repository, 'dirty.txt'), 'frozen without a commit\n');
  f.source.git('add', '.');
  const tree = f.source.git('write-tree');
  const refs = [
    `${parent}:refs/heads/merv/work/${f.unitId}`,
    `${parent}:refs/merv/submissions/${sessionId}/parent`,
    `${tree}:refs/merv/submissions/${sessionId}/tree`,
  ];
  await assert.rejects(
    f.git(f.source.repository, ['push', '--atomic', f.url, ...refs], ordinary.agentToken),
    /403/,
  );
  await assert.rejects(
    f.git(f.source.repository, ['push', '--atomic', f.url, ...refs], ordinary.token),
    /closed|rejected/,
  );
  await f.git(f.source.repository, ['push', '--atomic', f.url, ...refs], capture.token);
  assert.equal((await f.unit()).canonicalHead, parent);
  assert.equal((await f.unit()).writerState, 'closing');
  await f.remote.verifySubmission(f.admin.projectId, {
    sessionId,
    parentOid: parent,
    treeOid: tree,
    unitId: f.unitId,
  });
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_workspaces SET writer_changed_at=? WHERE project_id=? AND unit_id=?',
      '2000-01-01T00:00:00.000Z',
      f.admin.projectId,
      f.unitId,
    ),
  );
  await assert.rejects(f.remote.issueCapture(f.admin, input), /window ended/);
  await assert.rejects(f.git(f.source.repository, ['ls-remote', f.url], capture.token), /403/);
});

test('managed shutdown seals a stopped active writer with a separate capability, then captures and acknowledges durable progress', async (t) => {
  const f = await fixture(t);
  const sessionId = 'ses_managed_shutdown';
  await f.session(sessionId);
  const allocationId = 'allocation_git_shutdown';
  const credentialHash = 'c'.repeat(64);
  const at = new Date().toISOString();
  await f.state.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO identity_credentials(id,token_hash,owner,subject,kind,created_at) VALUES(?,?,?,?,'managed-control',?)",
      'ic_shutdown',
      credentialHash,
      'sessions',
      allocationId,
      at,
    );
    await tx.run(
      `INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,runner_id,created_at)
      VALUES(?,1,?,?,?,'test','{}','[]',?,?,?,?,?,?)`,
      allocationId,
      f.admin.projectId,
      JSON.stringify({ actorId: f.admin.actorId, projectId: f.admin.projectId }),
      'source',
      'e'.repeat(64),
      at,
      credentialHash,
      at,
      'runner-1',
      at,
    );
    await tx.run(
      'INSERT INTO session_managed_assignments(session_id,allocation_id,runner_id,source_json,bound_at,release_ack_at,settled_at) VALUES(?,?,?,?,?,?,?)',
      sessionId,
      allocationId,
      'runner-1',
      '{}',
      at,
      at,
      at,
    );
    await tx.run(
      'INSERT INTO session_managed_shutdowns(allocation_id,epoch,requested_at) VALUES(?,1,?)',
      allocationId,
      at,
    );
  });
  const cleanup: Caller = {
    actorId: f.admin.actorId,
    projectId: f.admin.projectId,
    managed: { allocationId, epoch: 1, credentialHash, cleanup: true },
  };
  const input = {
    sessionId,
    runnerId: 'runner-1',
    hostRef: `launch-${sessionId}`,
    unitId: f.unitId,
    generation: 1,
    leaseId: sessionId,
  };
  await assert.rejects(
    f.remote.issueCapture(
      {
        ...cleanup,
        managed: { ...cleanup.managed!, cleanup: undefined, boundSessionId: 'another_session' },
      },
      { ...input, stopped: true },
    ),
    /Only the assigned runner/,
  );
  const sealing = await f.remote.issueCapture(cleanup, { ...input, stopped: true });
  assert.equal('agentToken' in sealing, false);
  writeFileSync(join(f.source.repository, 'cleanup.txt'), 'captured after stop intent\n');
  f.source.git('add', '.');
  const treeOid = f.source.git('write-tree');
  await f.git(
    f.source.repository,
    [
      'push',
      f.url,
      `${treeOid}:refs/merv/submissions/${sessionId}/tree`,
      `${f.root}:refs/merv/submissions/${sessionId}/parent`,
    ],
    sealing.token,
  );
  await f.remote.verifySubmission(f.admin.projectId, {
    sessionId,
    parentOid: f.root,
    treeOid,
    unitId: f.unitId,
  });
  await f.state.transaction((tx) =>
    f.core.writers.settle(tx, {
      projectId: f.admin.projectId,
      ...input,
      expectedHead: f.root,
      moves: false,
    }),
  );
  await f.end(sessionId);
  assert.equal(f.source.git('rev-parse', 'HEAD'), f.root, 'sealing never creates a commit');
  await assert.rejects(f.git(f.source.repository, ['ls-remote', f.url], sealing.token), /403/);
  await assert.rejects(
    f.remote.issueCapture(cleanup, { ...input, stopped: true }),
    /writer has ended/,
  );
  await assert.rejects(
    f.remote.issueShutdown({ ...cleanup, managed: { ...cleanup.managed!, epoch: 2 } }, input),
    /no longer current/,
  );
  const grant = await f.remote.issueShutdown(cleanup, input);
  f.source.commit({ 'cleanup.txt': 'captured after stop intent\n' });
  const head = f.source.git('rev-parse', 'HEAD');
  await f.git(f.source.repository, ['push', f.url, `HEAD:merv/work/${f.unitId}`], grant.token);
  const receipt = await f.remote.acknowledge(cleanup, {
    ...input,
    kind: 'final',
    expectedHead: f.root,
    proposedHead: head,
    treeOid: f.source.git('rev-parse', 'HEAD^{tree}'),
  });
  assert.equal(receipt.head, head);
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE session_managed_shutdowns SET receipt_json=?,acknowledged_at=? WHERE allocation_id=?',
      JSON.stringify(receipt),
      at,
      allocationId,
    ),
  );
  await assert.rejects(f.git(f.source.repository, ['ls-remote', f.url], grant.token), /403/);
  await assert.rejects(f.remote.issueShutdown(cleanup, input), /no longer current/);
});

test('standard Basic authentication uses revocable user keys without a Merv client', async (t) => {
  const f = await fixture(t);
  const principal = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test',
    subject: 'git-user',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await f.scope.members.adoptProject(principal, f.admin.projectId);
  const key = await f.scope.userKeys.create(principal, { projectId: f.admin.projectId });
  assert.match(await f.git(f.directory, ['ls-remote', f.url], key.token), /refs\/heads\/merv-main/);
  await f.scope.userKeys.revoke(principal, key.key.id);
  await assert.rejects(
    f.git(f.directory, ['ls-remote', f.url], key.token),
    /Authentication failed|401|terminal prompts disabled/,
  );
});

test('interrupted standard Git pack moves no branch, and a complete retry succeeds', async (t) => {
  const f = await fixture(t);
  f.source.commit({ 'large.txt': 'content\n'.repeat(1000) });
  const head = f.source.git('rev-parse', 'HEAD');
  const pack = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      'git',
      ['pack-objects', '--stdout', '--revs'],
      { cwd: f.source.repository, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
    child.stdin!.end(`${head}\n^${f.root}\n`);
  });
  const command = `${'0'.repeat(40)} ${head} refs/heads/interrupted\0report-status\n`;
  const header = Buffer.from(
    (Buffer.byteLength(command) + 4).toString(16).padStart(4, '0') + command + '0000',
  );
  const send = (body: Buffer) =>
    fetch(`${f.url}/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: `Basic ${Buffer.from(`merv:${f.credential.token}`).toString('base64')}`,
      },
      body: new Uint8Array(body).buffer,
    });
  const interrupted = await send(
    Buffer.concat([header, pack.subarray(0, Math.floor(pack.length / 2))]),
  );
  assert.equal(interrupted.status, 200);
  assert.match(await interrupted.text(), /unpack (?!ok)/);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/interrupted'),
    null,
  );
  const retry = await send(Buffer.concat([header, pack]));
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /unpack ok/);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, 'refs/heads/interrupted'),
    head,
  );
});

for (const submission of [false, true])
  test(`a rejected journaled ${submission ? 'submission' : 'writer'} push preserves prior refs and permits its successor`, async (t) => {
    let fired = false;
    const f = await fixture(t, (point) => {
      if (point === 'after_journal' && !fired) {
        fired = true;
        throw new Error('crash');
      }
    });
    const sessionId = 'ses_rejected_proposal';
    const grant = await f.session(sessionId);
    writeFileSync(join(f.source.repository, 'candidate.txt'), 'unaccepted proposal\n');
    f.source.git('add', '.');
    const treeOid = f.source.git('write-tree');
    if (!submission) f.source.git('commit', '-qm', 'candidate');
    const refs = submission
      ? [
          `${treeOid}:refs/merv/submissions/${sessionId}/tree`,
          `${f.root}:refs/merv/submissions/${sessionId}/parent`,
        ]
      : [`HEAD:refs/heads/merv/work/${f.unitId}`];
    const token = submission ? grant.token : grant.agentToken;
    await f.git(f.source.repository, ['ls-remote', f.url], token);
    const before = await Promise.all(
      refs.map(async (mapping) => {
        const ref = mapping.split(':')[1]!;
        return [ref, await f.core.repositories.resolve(f.admin.projectId, ref)] as const;
      }),
    );
    await assert.rejects(
      f.git(f.source.repository, ['push', '--atomic', f.url, ...refs], token),
      /rejected/,
    );
    assert.equal(fired, true);
    await f.remote.recover();
    for (const [ref, previous] of before)
      assert.equal(await f.core.repositories.resolve(f.admin.projectId, ref), previous);
    assert.deepEqual(await pendingPushes(f), []);
    if (submission)
      await assert.rejects(
        f.remote.verifySubmission(f.admin.projectId, { sessionId, parentOid: f.root, treeOid }),
        { code: 'code_submission_missing' },
      );
    await f.event('session.closed', sessionId);
    await f.end(sessionId);
    assert.equal((await f.lease('ses_after_rejection')).generation, 2);
    assert.equal(
      (await f.unit()).canonicalHead,
      null,
      'a rejected proposal cannot become canonical',
    );
  });

for (const submission of [false, true])
  test(`native ${submission ? 'submission' : 'writer'} refs committed before a lost reply fence successors until their actual outcome is projected`, async (t) => {
    let fired = false;
    const f = await fixture(t, (point) => {
      if (point === 'after_refs' && !fired) {
        fired = true;
        throw new Error('crash');
      }
    });
    const sessionId = 'ses_committed_before_reply';
    const grant = await f.session(sessionId);
    writeFileSync(join(f.source.repository, 'candidate.txt'), 'native outcome\n');
    f.source.git('add', '.');
    const treeOid = f.source.git('write-tree');
    if (!submission) f.source.git('commit', '-qm', 'native outcome');
    const head = f.source.git('rev-parse', 'HEAD');
    const retained = submission
      ? new Map([
          [`refs/merv/submissions/${sessionId}/tree`, treeOid],
          [`refs/merv/submissions/${sessionId}/parent`, f.root],
        ])
      : new Map([[`refs/heads/merv/work/${f.unitId}`, head]]);
    await f
      .git(
        f.source.repository,
        ['push', '--atomic', f.url, ...[...retained].map(([ref, value]) => `${value}:${ref}`)],
        submission ? grant.token : grant.agentToken,
      )
      .catch(() => {});
    assert.equal(fired, true);
    for (const [ref, value] of retained)
      assert.equal(await f.core.repositories.resolve(f.admin.projectId, ref), value);
    assert.ok(
      (await pendingPushes(f)).length > 0,
      'the fault happened before database reconciliation',
    );
    await f.event('session.closed', sessionId);
    await assert.rejects(f.lease('ses_too_soon'), /Database constraint|admitted Git push/);
    await f.remote.recover();
    assert.deepEqual(await pendingPushes(f), []);
    assert.equal((await f.unit()).canonicalHead, submission ? null : head);
    if (submission)
      await f.remote.verifySubmission(f.admin.projectId, { sessionId, parentOid: f.root, treeOid });
    assert.equal((await f.lease('ses_after_projection')).generation, 2);
  });
