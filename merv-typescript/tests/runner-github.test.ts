import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeTransportGrant } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { LocalLedger } from '../packages/runner/src/ledger.js';
import { GitWorkspaceManager } from '../packages/runner/src/workspaces.js';

test('separate runners exchange exact objects, recover a lost push reply, and never replace a different remote ref', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-github-transport-'));
  const source = join(directory, 'source'),
    remote = join(directory, 'remote.git');
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          HOME: directory,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    ).trim();
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'result.txt'), 'before\n');
  git(source, 'add', '.');
  git(
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Initial',
  );
  git(source, 'clone', '--bare', '--no-local', source, remote);
  const baseOid = git(source, 'rev-parse', 'HEAD');
  const grant: CodeTransportGrant = {
    repositoryId: 'github:101',
    repository: 'fixture/private',
    revision: 3,
    baseBranch: 'main',
    baseOid,
    target: null,
    token: 'synthetic-private-installation-token',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  let loseReply = true;
  const ledgers: LocalLedger[] = [],
    managers: GitWorkspaceManager[] = [];
  const machine = (name: string) => {
    const ledger = new LocalLedger({
      directory: join(directory, name),
      binding: { baseUrl: 'http://127.0.0.1:3000', projectId: 'project', sourceId: name },
    });
    const manager = new GitWorkspaceManager(ledger, { github: true });
    ledgers.push(ledger);
    managers.push(manager);
    const originalGit = (manager as any).git.bind(manager);
    // Replace only the network destination with a real local bare remote. All manager Git arguments,
    // object verification, private-repository checks and process environment code still execute.
    (manager as any).git = async (
      args: string[],
      timeout: number,
      allowOne: boolean,
      env: Record<string, string> | undefined,
      input?: string,
    ) => {
      assert.equal(JSON.stringify(args).includes(grant.token), false);
      if (args.includes('https://github.com/fixture/private.git')) {
        assert.ok(
          env?.GIT_CONFIG_VALUE_0.endsWith(
            Buffer.from(`x-access-token:${grant.token}`).toString('base64'),
          ),
        );
        assert.ok(args.includes('http.followRedirects=false'));
      }
      const result = await originalGit(
        args.map((arg) => (arg === 'https://github.com/fixture/private.git' ? remote : arg)),
        timeout,
        allowOne,
        env,
        input,
      );
      if (args.includes('push') && loseReply) {
        loseReply = false;
        throw new Error('lost push response');
      }
      return result;
    };
    return { ledger, manager };
  };
  t.after(() => {
    managers.forEach((m) => m.dispose());
    ledgers.forEach((l) => l.close());
    rmSync(directory, { recursive: true, force: true });
  });
  const producer = machine('producer');
  await producer.manager.syncGitHub(grant);
  const originalFetch = (producer.manager as any).remoteGit;
  (producer.manager as any).remoteGit = () => {
    throw new Error('already imported objects must work offline');
  };
  await producer.manager.syncGitHub(grant);
  (producer.manager as any).remoteGit = originalFetch;
  const launch = producer.ledger.reserve({
    id: 'launch_producer',
    sessionId: 'session_producer',
    deadline: Date.now() + 60000,
  });
  const session = {
    id: launch.sessionId,
    projectId: 'project',
    instanceId: 'instance',
    execution: {
      references: {},
      policy: {
        readOnly: false,
        workspace: {
          mode: 'persistent',
          namespace: 'fixture',
          base: 'central',
          perBase: true,
          retain: true,
          advancesCentral: false,
        },
      },
    },
  } as unknown as Session;
  const checkout = await producer.manager.prepare(launch, session);
  writeFileSync(join(checkout.path, 'result.txt'), 'review this exact result\n');
  producer.ledger.cancelReservation(launch.id);
  const captured = (await producer.manager.capture(launch))!;
  const push = {
    ...grant,
    target: {
      branch: 'merv/checkpoints/fixture',
      headOid: captured.headOid,
      treeOid: captured.treeOid!,
    },
  };
  await producer.manager.pushGitHub(push);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${push.target.branch}`), captured.headOid);
  await producer.manager.pushGitHub(push);
  const reviewer = machine('reviewer');
  await reviewer.manager.syncGitHub(grant, [captured.headOid]);
  const reviewLaunch = reviewer.ledger.reserve({
    id: 'launch_reviewer',
    sessionId: 'session_reviewer',
    deadline: Date.now() + 60000,
  });
  const reviewSession = {
    ...session,
    id: reviewLaunch.sessionId,
    execution: {
      references: { code: captured.headOid },
      policy: {
        readOnly: true,
        workspace: {
          mode: 'ephemeral',
          namespace: 'reviews',
          base: 'reference:code',
          retain: false,
        },
      },
    },
  } as unknown as Session;
  const reviewCheckout = await reviewer.manager.prepare(reviewLaunch, reviewSession);
  assert.equal(reviewCheckout.snapshot?.repositoryId, checkout.snapshot?.repositoryId);
  assert.equal(reviewCheckout.snapshot?.headOid, captured.headOid);
  assert.equal(
    readFileSync(join(reviewCheckout.path, 'result.txt'), 'utf8'),
    'review this exact result\n',
  );
  git(remote, 'update-ref', `refs/heads/${push.target.branch}`, baseOid);
  await assert.rejects(producer.manager.pushGitHub(push), /workspace_remote_ref_conflict/);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${push.target.branch}`), baseOid);
  const scan = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(file);
        assert.equal(bytes.includes(Buffer.from(grant.token)), false, file);
        assert.equal(
          bytes.includes(
            Buffer.from(Buffer.from(`x-access-token:${grant.token}`).toString('base64')),
          ),
          false,
          file,
        );
      }
    }
  };
  scan(directory);
});
