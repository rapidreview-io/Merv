import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CodeGitRemote } from '@merv/code/store/http';
import { MervError, type Caller } from '@merv/contracts';
import { writerFixture } from './fixtures/code-writers.js';
import { gitSource } from './fixtures/code-store.js';
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
test('historical shutdown archives survive a cross-allocation generation race without touching the current writer', async (t) => {
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

  await f.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO session_workspaces(session_id,attachment_json) VALUES(?,?)',
      sessionId,
      JSON.stringify({ headOid: f.root }),
    );
    await f.core.writers.settle(tx, {
      projectId: f.admin.projectId,
      ...input,
      expectedHead: f.root,
      moves: false,
    });
  });
  await f.end(sessionId);
  await f.session('replacement_writer');
  const first = await f.remote.issueShutdown(cleanup, { ...input, archive: true });
  assert.ok(first.archive);
  const current = await f.unit();
  const currentHead = await f.core.repositories.resolve(
    f.admin.projectId,
    `refs/heads/merv/work/${f.unitId}`,
  );
  const retry = await f.remote.issueShutdown(cleanup, { ...input, archive: true });
  assert.deepEqual(retry.archive, first.archive);
  f.source.commit({ 'preserved.txt': 'old host evidence\n' });
  const head = f.source.git('rev-parse', 'HEAD');
  const tree = f.source.git('rev-parse', 'HEAD^{tree}');
  await assert.rejects(
    f.git(
      f.source.repository,
      ['push', f.url, `HEAD:refs/heads/merv/work/${f.unitId}`],
      first.token,
    ),
    /immutable|only|403/,
  );
  await f.git(f.source.repository, ['push', f.url, `HEAD:${first.archive.ref}`], first.token);
  const ack = {
    ...input,
    kind: 'final' as const,
    expectedHead: f.root,
    proposedHead: head,
    treeOid: tree,
    archiveRef: first.archive.ref,
  };
  await assert.rejects(f.remote.acknowledge(cleanup, { ...ack, treeOid: f.root }), /tree differs/);
  await assert.rejects(
    f.remote.acknowledge(
      { ...cleanup, managed: { ...cleanup.managed!, allocationId: 'other' } },
      ack,
    ),
    /capability/,
  );
  for (const altered of [
    { runnerId: 'foreign-runner' },
    { hostRef: 'foreign-host' },
    { sessionId: 'foreign-session' },
  ])
    await assert.rejects(f.remote.acknowledge(cleanup, { ...ack, ...altered }), /capability/);
  const receipt = await f.remote.acknowledge(cleanup, ack);
  assert.equal((await f.remote.acknowledge(cleanup, ack)).id, receipt.id);
  assert.equal(receipt.head, head);
  assert.deepEqual(await f.unit(), current);
  assert.equal(
    await f.core.repositories.resolve(f.admin.projectId, `refs/heads/merv/work/${f.unitId}`),
    currentHead,
  );
  f.source.commit({ 'second.txt': 'must not overwrite archive\n' });
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `HEAD:${first.archive.ref}`], retry.token),
    /immutable/,
  );
  await assert.rejects(
    f.git(f.source.repository, ['push', f.url, `:${first.archive.ref}`], retry.token),
    /deletion/,
  );
});
