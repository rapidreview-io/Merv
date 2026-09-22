import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { CodeService } from '@merv/code-research/service';
import { LeasedSessions } from '@merv/sessions';
import { SqliteState, PostgresState } from '@merv/state';
import { CodeRepositories } from '@merv/code/store/repository';
import { CodeBaseService } from '@merv/code-research/bases';
import type { Backend } from './code-store.js';

/** A project repository holding four accepted commits off one main: a and c collide, b and d do not. */
export async function baseFixture(t: TestContext, backend: Backend, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'merv-bases-'));
  const schema = `code_bases_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(root, 'state.sqlite'))
      : await PostgresState.open({
          connectionString: process.env.MERV_TEST_POSTGRES_URL!,
          schema,
        });
  let time = Date.now();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      sweepIntervalMs: 60_000,
      clock: () => time,
    }),
  );
  const boot = await scope.bootstrap({ projectName: 'Bases', actorName: 'Owner' });
  const PROJECT = boot.project.id;
  const admin = { projectId: PROJECT, actorId: boot.actor.id, credentialId: boot.credential.id };
  await sessions.setDispatch(admin, { enabled: true });
  const repositories = new CodeRepositories({
    root: join(root, 'code'),
    quotaBytes: 1024 * 1024 * 1024,
    reservedFreeBytes: 1,
  });
  // Repository content tests need no process-wide socket lock.
  mkdirSync(join(root, 'code', 'tmp'), { recursive: true });
  mkdirSync(join(root, 'code', 'empty-template'));
  await repositories.ensure(PROJECT, 'repository-bases', 'sha1');
  const bare = repositories.paths(PROJECT).repository;
  const work = join(root, 'work');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'Test');
  for (const file of ['f', 'g', 'h']) writeFileSync(join(work, `${file}.txt`), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const commit = (branch: string, file: string, text: string) => {
    git('checkout', '-q', '-B', branch, 'main');
    writeFileSync(join(work, file), text);
    git('commit', '-q', '-am', branch);
    git('push', '-q', bare, `${branch}:refs/heads/${branch}`);
    return git('rev-parse', 'HEAD');
  };
  const commits = {
    a: commit('a', 'f.txt', 'base\nA\n'),
    b: commit('b', 'g.txt', 'base\nB\n'),
    c: commit('c', 'f.txt', 'base\nC\n'),
    d: commit('d', 'h.txt', 'base\nD\n'),
  };
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(root, 'blobs'))),
  );
  const code = await createService(new CodeService(state, scope, sessions, artifacts, workflows));
  let changes = 0;
  const hooks = {
    changed: async () => void (changes += 1),
    sponsors: async () => ['root-a', 'root-b'],
    serviceWork: sessions.serviceWork,
  };
  const workers: CodeBaseService[] = [];
  const worker = (admission = true, deadlineMs = 120_000) => {
    const base = new CodeBaseService(
      state,
      repositories,
      { ...hooks, serviceWork: admission ? sessions.serviceWork : undefined },
      true,
      () => time,
      deadlineMs,
    );
    workers.push(base);
    return base;
  };
  const bases = new CodeBaseService(state, repositories, hooks, enabled, () => time);
  await bases.initialize();
  t.after(async () => {
    await bases.close();
    for (const worker of workers) await worker.close();
    await code.close();
    await repositories.close(1000);
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(root, { recursive: true, force: true });
    if (backend === 'postgres') {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  const parents = (oid: string) =>
    execFileSync('git', ['--git-dir', bare, 'rev-list', '--parents', '-n', '1', oid], {
      encoding: 'utf8',
    })
      .trim()
      .split(' ')
      .slice(1);
  const rows = async () =>
    await state.read(
      async (sql) =>
        await sql.all<{ base_key: string; state: string }>(
          'SELECT base_key,state FROM code_bases WHERE project_id=? ORDER BY base_key',
          PROJECT,
        ),
    );
  return {
    state,
    hooks,
    worker,
    clock: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    sessions,
    scope,
    workflows,
    admin,
    projectId: PROJECT,
    repositories,
    bases,
    commits,
    parents,
    rows,
    bare,
    changed: () => changes,
  };
}
