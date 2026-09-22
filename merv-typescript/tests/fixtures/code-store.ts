import { createService, type Caller } from '@merv/contracts';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import type { Sessions } from '@merv/sessions/types';
import { CodeService, type CodeStoreOptions } from '@merv/code-research/service';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeStoreConfig, FaultPoint } from '@merv/code/store/operations';
import { boundProject } from './code-binding.js';

export const backends = ['sqlite', 'postgres'] as const;
export type Backend = (typeof backends)[number];
const postgresUrl = process.env.MERV_TEST_POSTGRES_URL;
export const optional = (backend: Backend) => ({ skip: backend === 'postgres' && !postgresUrl });

/** Git as a test runs it: no configuration of the machine or the user reaches it. */
export function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();
}

export interface Bundle {
  file: string;
  tip: string;
  sha256: string;
  bytes: number;
  content: Buffer;
}

/** An operator's repository in a temporary directory, and bundles cut from it. */
export function gitSource(t: TestContext, format: 'sha1' | 'sha256' = 'sha1') {
  const directory = mkdtempSync(join(tmpdir(), 'merv-src-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, 'source');
  mkdirSync(repository);
  git(repository, ['init', '--quiet', `--object-format=${format}`, '--initial-branch=main']);
  let bundles = 0;
  const source = {
    directory,
    repository,
    git: (...args: string[]) => git(repository, args),
    /** Write the files, stage everything and commit; returns the commit. */
    commit(files: Record<string, string | Buffer | null>, message = 'change'): string {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(repository, path), { recursive: true, force: true });
        else {
          mkdirSync(dirname(join(repository, path)), { recursive: true });
          writeFileSync(join(repository, path), content);
        }
      }
      git(repository, ['add', '-A']);
      git(repository, ['commit', '--quiet', '--allow-empty', '-m', message]);
      return git(repository, ['rev-parse', 'HEAD']);
    },
    /** A bundle that delivers `tip` and builds on `not`. */
    bundle(tip: string, not: string[] = [], extra: string[] = []): Bundle {
      const file = join(directory, `bundle-${++bundles}`);
      git(repository, ['update-ref', 'refs/heads/transfer', tip]);
      git(repository, [
        'bundle',
        'create',
        file,
        ...extra,
        'refs/heads/transfer',
        ...not.map((oid) => `^${oid}`),
      ]);
      return described(file, tip);
    },
  };
  return source;
}

export function described(file: string, tip: string): Bundle {
  const content = readFileSync(file);
  return {
    file,
    tip,
    content,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

/** Real services on one backend, a bound project, and Code keeping repositories in `root`. */
export async function codeStoreFixture(
  t: TestContext,
  backend: Backend,
  config: Partial<CodeStoreConfig> = {},
  /** The commit the project names as its main; by default one no repository holds. */
  mainOid = 'a'.repeat(40),
  /** Methods that stand in for Sessions', where a test plays the sessions itself. */
  played: Partial<Sessions> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-cs-'));
  const root = join(directory, 'code');
  const schema = `code_store_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(directory, 'state.sqlite'))
      : await PostgresState.open({ connectionString: postgresUrl!, schema });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  const seen = Object.assign(Object.create(sessions) as Sessions, played);
  let code: CodeService | undefined;
  /** Code as a new process would start it, on the same database and the same directory. */
  const open = async (
    options: Omit<CodeStoreOptions, 'config'> & { config?: Partial<CodeStoreConfig> } = {},
  ) => {
    await code?.close();
    code = new CodeService(state, scope, seen, artifacts, workflows, undefined, undefined, {
      ...options,
      config: { root, settleMs: 60_000, reservedFreeBytes: 1, ...config, ...options.config },
    });
    await code.initialize();
    return code;
  };
  t.after(async () => {
    await code?.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
    if (backend === 'sqlite') return;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  const boot = await scope.bootstrap({ projectName: 'Code store', actorName: 'Owner' });
  const admin: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await open();
  await boundProject(state, admin.projectId, mainOid, 'fixture-repository');
  const paths = new CodeRepositories({ root, quotaBytes: 0, reservedFreeBytes: 0 }).paths(
    admin.projectId,
  );
  let requests = 0;
  return {
    directory,
    root,
    /** The PostgreSQL schema this fixture owns; empty on SQLite, which has none. */
    schema: backend === 'postgres' ? schema : '',
    state,
    scope,
    workflows,
    admin,
    /** A signed-in administrator of the same project, for what only a human may do. */
    async human(): Promise<Caller> {
      const principal = await scope.acceptVerifiedIdentity({
        issuer: 'https://issuer.example.test',
        subject: 'operator',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      await scope.adoptProject(principal, admin.projectId);
      return await scope.caller(principal, admin.projectId);
    },
    paths,
    /** The same paths for any other project this server keeps a repository for. */
    pathsOf: (id: string) =>
      new CodeRepositories({ root, quotaBytes: 0, reservedFreeBytes: 0 }).paths(id),
    open,
    get code() {
      return code!;
    },
    /** Refs of the project's repository as `name oid` lines. */
    refs: () =>
      git(paths.repository, ['for-each-ref', '--format=%(refname) %(objectname)'])
        .split('\n')
        .filter(Boolean),
    /** Promise a bundle, send it in parts and ask for it to be admitted. */
    async deliver(bundle: Bundle, partBytes = 1024 * 1024, requestId = `import-${++requests}`) {
      const begun = await code!.importRepository(admin, {
        source: 'bundle',
        tip: bundle.tip,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId,
      });
      if (begun.status !== 'prepared' || begun.phase !== 'receiving') return begun;
      for (let offset = begun.received; offset < bundle.bytes; offset += partBytes)
        await code!.v2!.putPart(
          admin,
          begun.id,
          offset,
          bundle.content.subarray(offset, offset + partBytes),
        );
      return (
        (await code!.v2!.call(admin, `uploads/${begun.id}/complete`, {})) as {
          operation: typeof begun;
        }
      ).operation;
    },
    operationRow: async (id: string) => {
      const row = await state.read(
        async (sql) =>
          await sql.get<{ status: string; phase: string | null; error: string | null }>(
            'SELECT status,phase,error FROM code_operations WHERE id=?',
            id,
          ),
      );
      return row && { status: row.status, phase: row.phase, error: row.error };
    },
  };
}

/** A fault hook that throws the first time one named boundary is reached. */
export function faultAt(point: FaultPoint) {
  let fired = false;
  return (reached: FaultPoint) => {
    if (reached !== point || fired) return;
    fired = true;
    throw new Error(`process ended ${point}`);
  };
}
