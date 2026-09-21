import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest, MervError, newId, now } from '@merv/contracts';
import type { CodeMirrorStatus, CodeStoreWarning, Transaction } from '@merv/contracts';
import type { GitResult, ServerGit } from '@merv/code/git';
import type { CodeRepositories } from '@merv/code/store/repository';
import {
  enqueueMirror,
  GitMirrorTransport,
  type MirrorOutcome,
  type MirrorTransport,
  type MirrorUpdate,
} from '@merv/code/store/mirror';
import { backends, git, optional, type Backend } from './fixtures/code-store.js';
import { writerFixture } from './fixtures/code-writers.js';
import { githubFixture } from './github-fixture.js';

/**
 * A repository somewhere else, reached with real Git over a local path: everything the mirror
 * does to a repository it does not own, without a network or a credential.
 */
function elsewhere(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-remote-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git');
  git(directory, ['init', '--quiet', '--bare', remote]);
  const pushes: MirrorUpdate[] = [];
  const control = { blocked: null as string | null, mode: 'ok' as 'ok' | 'fail' | 'lost' };
  const refs = () =>
    git(directory, ['ls-remote', remote])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').reverse().join(' '));
  const put = (ref: string, oid: string, from: string) =>
    git(from, ['push', '--quiet', '--force', remote, `${oid}:${ref}`]);
  const transport = (repository: string): MirrorTransport => ({
    target: async () =>
      control.blocked ? { blocked: control.blocked } : { repository: 'fixture/remote' },
    lsRemote: async (_projectId, ref) => {
      const line = git(repository, ['ls-remote', remote, ref]);
      return line ? line.split('\t')[0] : null;
    },
    push: async (_projectId, update): Promise<MirrorOutcome> => {
      pushes.push(update);
      if (control.mode === 'fail')
        throw new MervError('code_mirror_failed', 'The repository is away', 502);
      try {
        git(repository, [
          'push',
          '--porcelain',
          `--force-with-lease=${update.ref}:${update.expectedRemote ?? ''}`,
          remote,
          `${update.oid}:${update.ref}`,
        ]);
      } catch {
        return 'rejected';
      }
      // A push that landed and whose answer was lost is exactly this.
      return control.mode === 'lost' ? 'unknown' : 'ok';
    },
  });
  return { directory, remote, pushes, control, refs, put, transport };
}

/** A hosted project with one unit whose work is published to that repository. */
async function mirrored(t: TestContext, backend: Backend, config = {}) {
  const remote = elsewhere(t);
  let transport: MirrorTransport | undefined;
  const f = await writerFixture(t, backend, 900, {
    mirror: {
      target: (projectId) => transport!.target(projectId),
      lsRemote: (projectId, ref) => transport!.lsRemote(projectId, ref),
      push: (projectId, update) => transport!.push(projectId, update),
    },
    mirrorConfig: { mirrorSeconds: 0, backoffMs: 0, maxAttempts: 3, ...config },
  });
  transport = remote.transport(f.paths.repository);
  const rows = async () =>
    await f.state.read(
      async (sql) =>
        await sql.all<{ id: string; kind: string; status: string; phase: string | null }>(
          "SELECT id,kind,status,phase FROM code_operations WHERE kind LIKE 'mirror%' ORDER BY created_at,id",
        ),
    );
  return {
    ...f,
    remote,
    rows,
    open: async () => (await rows()).filter((row) => row.status === 'prepared'),
    status: async (): Promise<CodeMirrorStatus> => (await f.code.status(f.admin)).mirror!,
    warnings: async (): Promise<CodeStoreWarning[]> => (await f.code.status(f.admin)).warnings,
    step: async () => await f.code.mirrorStep(),
  };
}

for (const backend of backends) {
  test(
    `${backend}: a unit's branch is published, coalesces while it waits and only ever fast-forwards`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(one, [f.root]));
      const two = f.source.commit({ 'a.txt': 'two\n' });
      await f.upload('checkpoint', 'session-1', 1, one, f.source.bundle(two, [one]));
      assert.equal((await f.open()).length, 1, 'one ref waiting, however often it moved');

      await f.step();
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${two}`]);
      assert.deepEqual(
        f.remote.pushes.map((push) => [push.oid, push.expectedRemote]),
        [[two, null]],
        'one push, of the newest commit, onto a branch that was not there',
      );
      assert.deepEqual([(await f.unit()).mirroredHead, (await f.unit()).canonicalHead], [two, two]);
      assert.equal((await f.status()).state, 'idle');

      const three = f.source.commit({ 'a.txt': 'three\n' });
      await f.upload('checkpoint', 'session-1', 1, two, f.source.bundle(three, [two]));
      await f.step();
      assert.deepEqual(f.remote.pushes[1], {
        ref: `refs/heads/merv/work/${f.unitId}`,
        oid: three,
        expectedRemote: two,
      });
      assert.equal((await f.open()).length, 0);
      // Nothing is asked for twice: a pass with everything published pushes nothing.
      await f.step();
      assert.equal(f.remote.pushes.length, 2);
    },
  );

  test(
    `${backend}: a branch that moved by another hand is never forced, and an operator re-queues it once they have seen it`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      // Somebody else's commit on the published branch, which Code did not write and
      // which nothing of this unit's history is built on.
      f.source.git('checkout', '--quiet', '-b', 'theirs');
      const foreign = f.source.commit({ 'theirs.txt': 'not ours\n' });
      f.source.git('checkout', '--quiet', 'main');
      f.remote.put(`refs/heads/merv/work/${f.unitId}`, foreign, f.source.repository);

      await f.lease('session-1');
      const ours = f.source.commit({ 'a.txt': 'one\n' }, 'ours');
      await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(ours, [f.root]));
      await f.step();
      assert.deepEqual(f.remote.pushes, [], 'nothing is pushed over it');
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${foreign}`]);
      const blocked = await f.status();
      assert.equal(blocked.state, 'blocked');
      assert.deepEqual(
        blocked.blockedRefs.map((ref) => [ref.code, ref.ref]),
        [['code_mirror_diverged', `refs/merv/work/${f.unitId}`]],
      );
      assert.deepEqual(
        (await f.warnings()).map((warning) => [warning.code, warning.ref]),
        [['code_mirror_diverged', `refs/heads/merv/work/${f.unitId}`]],
      );
      assert.equal((await f.unit()).canonicalHead, ours, 'the work itself is untouched');

      const human = await f.human();
      const operation = blocked.blockedRefs[0].operationId;
      await assert.rejects(
        async () => await f.code.retryMirror(human, { operationId: operation, requestId: 'r1' }),
        { code: 'code_mirror_diverged' },
      );
      await assert.rejects(
        async () =>
          await f.code.retryMirror(human, {
            operationId: operation,
            acknowledgeRemote: ours,
            requestId: 'r2',
          }),
        { code: 'code_mirror_diverged' },
      );
      // Acknowledging exactly the foreign commit re-queues it; it still never forces.
      await f.code.retryMirror(human, {
        operationId: operation,
        acknowledgeRemote: foreign,
        requestId: 'r3',
      });
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${foreign}`]);
      assert.equal((await f.status()).state, 'blocked');

      // Once the foreign commit is somewhere else and the branch is gone, it publishes.
      git(f.source.repository, [
        'push',
        '--quiet',
        '--delete',
        f.remote.remote,
        `refs/heads/merv/work/${f.unitId}`,
      ]);
      await f.code.retryMirror(human, {
        operationId: operation,
        acknowledgeRemote: foreign,
        requestId: 'r4',
      });
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${ours}`]);
      assert.deepEqual(await f.warnings(), []);
      assert.equal((await f.status()).state, 'idle');
    },
  );

  test(
    `${backend}: a repository that is away is retried and then waits for an operator, and holds nothing up`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(one, [f.root]));
      f.remote.control.mode = 'fail';

      await f.step();
      assert.deepEqual(
        (await f.open()).map((row) => row.phase),
        ['retry_wait'],
      );
      assert.equal((await f.status()).state, 'retrying');
      await f.step();
      await f.step();
      const stopped = await f.status();
      assert.equal(stopped.state, 'blocked');
      assert.equal(stopped.blockedRefs[0].code, 'code_mirror_failed');
      assert.equal(f.remote.pushes.length, 3, 'three attempts, then it waits');
      assert.deepEqual(
        (
          await f.state.read(
            async (sql) =>
              await sql.all<{ type: string }>(
                "SELECT type FROM events WHERE type='code.mirror_blocked'",
              ),
          )
        ).length,
        1,
      );

      // The session goes on: the branch is durable in Code, which is all a handoff needs.
      const two = f.source.commit({ 'a.txt': 'two\n' });
      const final = await f.upload('final', 'session-1', 1, one, f.source.bundle(two, [one]));
      assert.equal(final.status, 'completed');
      assert.equal((await f.unit()).writerState, 'closed');

      f.remote.control.mode = 'ok';
      await f.code.retryMirror(await f.human(), {
        operationId: stopped.blockedRefs[0].operationId,
        requestId: 'retry',
      });
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${two}`]);
      assert.deepEqual(await f.warnings(), []);
      assert.equal((await f.unit()).mirroredHead, two, 'it catches up with where the unit is now');
    },
  );

  test(
    `${backend}: a push whose answer was lost is read again instead of made twice`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(one, [f.root]));
      f.remote.control.mode = 'lost';

      await f.step();
      assert.equal(f.remote.pushes.length, 1);
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${one}`]);
      assert.equal((await f.open()).length, 0);
      assert.equal((await f.unit()).mirroredHead, one);
    },
  );

  test(
    `${backend}: a quarantined unit and an unlinked project publish nothing, and neither is an error`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(one, [f.root]));

      f.remote.control.blocked = 'github_repository_required';
      await f.step();
      assert.deepEqual(f.remote.pushes, []);
      const off = await f.status();
      assert.deepEqual(
        [off.state, off.repository, off.blockedBy],
        ['off', null, 'github_repository_required'],
      );
      assert.deepEqual(await f.warnings(), [], 'nothing linked is quiet, not a warning');

      f.remote.control.blocked = null;
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "UPDATE code_units SET quarantine_operation_id='cop_fixture' WHERE unit_id=?",
            f.unitId,
          ),
      );
      await f.step();
      assert.deepEqual(f.remote.pushes, [], 'a refused capture holds its unit back');
      assert.deepEqual(
        (await f.open()).map((row) => row.phase),
        ['retry_wait'],
      );

      await f.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE code_units SET quarantine_operation_id=NULL WHERE unit_id=?',
            f.unitId,
          ),
      );
      await f.step();
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${one}`]);
    },
  );

  test(
    `${backend}: an accepted commit is created on the repository, never moved, and blocks if another one is there`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      await f.upload('final', 'session-1', 1, f.root, f.source.bundle(one, [f.root]));
      await f.step();

      // An acceptance journals the ref its commit is kept under; the journal makes it.
      const accepted = async (tip: string, requestId: string) => {
        await f.state.transaction(async (tx: Transaction) => {
          const payload = {
            format: 1,
            source: 'accept-ref',
            actorId: f.admin.actorId,
            unitId: f.unitId,
            tip,
          };
          const at = now();
          await tx.run(
            'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,progress_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            newId('cop'),
            f.admin.projectId,
            'system:code',
            requestId,
            'accept-ref',
            digest(payload),
            canonical(payload),
            'prepared',
            at,
            f.unitId,
            'objects_durable',
            canonical({
              received: 0,
              expectedOld: null,
              target: tip,
              receiptRef: `refs/merv/accepted/${f.unitId}`,
            }),
            at,
          );
        });
        await f.code.maintainStore();
        await f.step();
      };
      await accepted(one, `accept-ref:${f.unitId}`);
      assert.ok(
        f.refs().includes(`refs/merv/accepted/${f.unitId} ${one}`),
        JSON.stringify(f.refs()),
      );
      assert.ok(f.remote.refs().includes(`refs/heads/merv/accepted/${f.unitId} ${one}`));
      const pushed = f.remote.pushes.length;
      await f.step();
      assert.equal(f.remote.pushes.length, pushed, 'an accepted ref is published exactly once');

      // An accepted ref is created, never moved: asked for another commit, it blocks.
      const other = f.source.commit({ 'a.txt': 'other\n' });
      await f.state.transaction(
        async (tx) =>
          await enqueueMirror(tx, f.admin.projectId, 'mirror-accepted', f.unitId, other),
      );
      await f.step();
      assert.equal(f.remote.pushes.length, pushed, 'nothing is pushed over an accepted ref');
      assert.ok(f.remote.refs().includes(`refs/heads/merv/accepted/${f.unitId} ${one}`));
      assert.deepEqual(
        (await f.status()).blockedRefs.map((ref) => [ref.code, ref.ref]),
        [['code_mirror_diverged', `refs/merv/accepted/${f.unitId}`]],
      );
    },
  );
  test(
    `${backend}: with the repository away for the whole run, every generation still works, hands over and is accepted`,
    optional(backend),
    async (t) => {
      const f = await mirrored(t, backend);
      f.remote.control.mode = 'fail';
      await f.lease('session-1');
      const one = f.source.commit({ 'a.txt': 'one\n' });
      assert.equal(
        (await f.upload('checkpoint', 'session-1', 1, f.root, f.source.bundle(one, [f.root])))
          .status,
        'completed',
      );
      await f.step();
      const two = f.source.commit({ 'a.txt': 'two\n' });
      assert.equal(
        (await f.upload('final', 'session-1', 1, one, f.source.bundle(two, [one]))).status,
        'completed',
      );
      f.end('session-1');
      await f.event('session.closed', 'session-1');
      assert.equal((await f.unit()).writerState, 'closed');

      // The next machine takes the unit up from exactly where Code holds it.
      assert.equal((await f.lease('session-2')).generation, 2);
      const three = f.source.commit({ 'a.txt': 'three\n' });
      assert.equal(
        (await f.upload('final', 'session-2', 2, two, f.source.bundle(three, [two]))).status,
        'completed',
      );
      await f.step();
      await f.step();
      await f.step();

      const status = await f.status();
      assert.equal(status.state, 'blocked');
      const unit = await f.unit();
      assert.deepEqual(
        [unit.canonicalHead, unit.mirroredHead, unit.writerState],
        [three, null, 'closed'],
      );
      assert.ok(status.oldestPendingAt);
      assert.deepEqual(
        (
          await f.state.read(
            async (sql) =>
              await sql.all<{ error: string | null }>(
                "SELECT error FROM code_operations WHERE kind='upload' AND status<>'completed'",
              ),
          )
        ).length,
        0,
        'nothing a machine handed over was left unfinished by a repository being away',
      );

      // And it catches up by itself the moment the repository answers again.
      f.remote.control.mode = 'ok';
      await f.code.retryMirror(await f.human(), {
        operationId: status.blockedRefs[0].operationId,
        requestId: 'back',
      });
      assert.deepEqual(f.remote.refs(), [`refs/heads/merv/work/${f.unitId} ${three}`]);
      assert.equal((await f.unit()).mirroredHead, three);
    },
  );
}

test('what publishes a project’s work is the owner’s link and the write automation they turned on', async (t) => {
  const f = await githubFixture(t);
  assert.deepEqual(
    await f.github.mirrorTarget(f.project.id),
    { blocked: 'github_automation_disabled' },
    'a linked repository alone publishes nothing',
  );
  await f.enable('read');
  assert.deepEqual(await f.github.mirrorTarget(f.project.id), {
    blocked: 'github_automation_disabled',
  });
  await f.enable('write');
  const target = await f.github.mirrorTarget(f.project.id);
  assert.ok(!('blocked' in target));
  assert.deepEqual([target.id, target.fullName], [101, 'fixture/private']);

  // The credential is minted for one operation and given up however that operation ends.
  const minted = () => f.calls.filter((call) => call.path.endsWith('/access_tokens')).length;
  const revoked = () => f.calls.filter((call) => call.method === 'DELETE').length;
  assert.equal(
    await f.github.mirrorToken(target, async (token) => {
      assert.equal(token, 'synthetic-installation-secret');
      return 'done';
    }),
    'done',
  );
  assert.deepEqual([minted(), revoked()], [1, 1]);
  await assert.rejects(
    async () =>
      await f.github.mirrorToken(target, () => Promise.reject(new Error('the push failed'))),
    /the push failed/,
  );
  assert.deepEqual([minted(), revoked()], [2, 2], 'a failed push gives its credential up too');
  assert.ok(
    f.calls.every((call) => JSON.stringify(call.body ?? '').indexOf('synthetic-installation') < 0),
  );
});

test('the credential of a push exists only in the environment of that one Git child', async (t) => {
  const seen: { args: string[]; env: Record<string, string> }[] = [];
  const fake = {
    run: async (args: string[], options: { env?: Record<string, string> }) => {
      seen.push({ args, env: options.env ?? {} });
      return {
        code: 0,
        stdout: Buffer.from(
          args[0] === 'ls-remote' ? `${'a'.repeat(40)}\trefs/heads/merv/work/unit\n` : '',
        ),
        stderr: '',
      } satisfies GitResult;
    },
  } as unknown as ServerGit;
  const repositories = {
    git: fake,
    environment: () => ({ GIT_DIR: '/var/lib/merv-ts/code/x/repository.git' }),
  } as unknown as CodeRepositories;
  const transport = new GitMirrorTransport(repositories, {
    target: async () => ({ id: 101, fullName: 'fixture/private' }),
    token: async (_projectId, use) => await use('synthetic-installation-secret'),
  });
  assert.equal(await transport.lsRemote('project', 'refs/heads/merv/work/unit'), 'a'.repeat(40));
  assert.equal(
    await transport.push('project', {
      ref: 'refs/heads/merv/work/unit',
      oid: 'b'.repeat(40),
      expectedRemote: 'a'.repeat(40),
    }),
    'ok',
  );
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.ok(
      !call.args.some((argument) => argument.includes('synthetic-installation-secret')),
      call.args.join(' '),
    );
    assert.ok(
      Object.entries(call.env).every(
        ([name, value]) =>
          !value.includes('synthetic-installation-secret') || name === 'GIT_CONFIG_VALUE_0',
      ),
    );
    assert.ok(call.args.every((argument) => !argument.startsWith('http://')));
  }
  assert.deepEqual(seen[1].args.slice(0, 3), [
    'push',
    '--porcelain',
    `--force-with-lease=refs/heads/merv/work/unit:${'a'.repeat(40)}`,
  ]);
});
