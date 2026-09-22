import { check } from '@merv/contracts';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerGit } from '@merv/code/git';
import { CodeRepositories } from '@merv/code/store/repository';
import {
  codePrefix,
  LATEST,
  type BackupManifest,
  type BackupObject,
  type BackupObjectStore,
} from '@merv/code/store/backup';

export interface RestoreOptions {
  store: BackupObjectStore;
  /** The segment production and rehearsal are kept apart by; a restore never crosses it. */
  deployment: string;
  /** Where repositories are written. Required unless this only verifies. */
  root?: string;
  projectId?: string;
  /** The stamp of an older copy, instead of the one the pointer names. */
  at?: string;
  /** Write over a repository that already holds refs this copy does not; destructive. */
  overwrite?: boolean;
  verifyOnly: boolean;
}
export interface RestoredProject {
  projectId: string;
  takenAt: string;
  bundle: string | null;
  bytes: number;
  refs: number;
  state: 'verified' | 'restored' | 'failed';
  problem?: string;
}
export interface RestoreReport {
  deployment: string;
  mode: 'verify' | 'restore';
  database: { key: string; backend: string; state: 'verified' | 'failed' } | null;
  projects: RestoredProject[];
  problems: string[];
}

/**
 * Read back what the backup wrote. Verification touches no repository at all, so the monthly
 * drill runs against production's bucket while production is up; a restore writes into a
 * root, and takes the writer lock to prove no server is writing there.
 */
export async function restoreCode(options: RestoreOptions): Promise<RestoreReport> {
  const { store, deployment } = options;
  check(
    /^[a-zA-Z0-9_-]{1,64}$/.test(deployment),
    'code_restore_failed',
    'The deployment name must be a single path segment',
  );
  const manifests: BackupManifest[] = [];
  const problems: string[] = [];
  const prefixes = options.projectId
    ? [codePrefix(deployment, options.projectId)]
    : [
        ...new Set(
          (await store.list(`${deployment}/code/`))
            .map((key) => /^(.*\/)[^/]+$/.exec(key)?.[1])
            .filter((prefix): prefix is string => !!prefix),
        ),
      ];
  for (const prefix of prefixes) {
    const key = `${prefix}${options.at ? `${options.at}.manifest.json` : LATEST}`;
    if ((await store.head(key)) === null) {
      problems.push(`${key} is not in the bucket`);
      continue;
    }
    const manifest = JSON.parse((await store.getBytes(key)).toString('utf8')) as BackupManifest;
    // A manifest of another deployment under this prefix would restore the wrong history into
    // a live project, which is the whole reason the deployment segment exists.
    if (manifest.format !== 1 || manifest.deployment !== deployment)
      problems.push(`${key} was written by another deployment`);
    else manifests.push(manifest);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'merv-code-restore-'));
  const git = new ServerGit(scratch);
  try {
    await git.assertGit();
    const report: RestoreReport = {
      deployment,
      mode: options.verifyOnly ? 'verify' : 'restore',
      database: null,
      projects: [],
      problems,
    };
    const database = manifests.find((manifest) => manifest.database)?.database;
    if (database) {
      const problem = await read(store, database, join(scratch, 'database'));
      if (problem) problems.push(problem);
      report.database = {
        key: database.key,
        backend: database.backend,
        state: problem ? 'failed' : 'verified',
      };
      await rm(join(scratch, 'database'), { force: true });
    }
    if (options.verifyOnly) {
      for (const manifest of manifests)
        report.projects.push(await verify(store, git, manifest, scratch, problems));
      return report;
    }
    check(options.root, 'code_restore_failed', 'A restore needs the root it writes into');
    const repositories = new CodeRepositories(
      { root: options.root, quotaBytes: 0, reservedFreeBytes: 0 },
      git,
    );
    // open() binds the writer socket, which a running server holds: a restore beneath a live
    // server is refused with code_repository_locked rather than half-written.
    await repositories.open();
    try {
      for (const manifest of manifests)
        report.projects.push(
          await restore(store, repositories, manifest, scratch, problems, options.overwrite),
        );
    } finally {
      await repositories.close(1000);
    }
    return report;
  } finally {
    git.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Fetch one object to a file and check it against what the manifest says it is. */
async function read(
  store: BackupObjectStore,
  object: BackupObject,
  file: string,
): Promise<string | undefined> {
  let got;
  try {
    got = await store.getFile(object.key, file);
  } catch (error) {
    return `${object.key} could not be read: ${(error as Error).message}`;
  }
  if (got.bytes !== object.bytes || got.sha256 !== object.sha256)
    return `${object.key} is not the object the manifest names`;
  return undefined;
}

/** What `--verify-only` proves: the object is there, it is unchanged, and Git accepts it. */
async function verify(
  store: BackupObjectStore,
  git: ServerGit,
  manifest: BackupManifest,
  scratch: string,
  problems: string[],
): Promise<RestoredProject> {
  const row: RestoredProject = {
    projectId: manifest.projectId,
    takenAt: manifest.takenAt,
    bundle: manifest.bundle?.key ?? null,
    bytes: manifest.bundle?.bytes ?? 0,
    refs: manifest.refs.length,
    state: 'verified',
  };
  if (!manifest.bundle) return row;
  const file = join(scratch, 'bundle');
  const empty = join(scratch, 'verify.git');
  try {
    const problem = await read(store, manifest.bundle, file);
    if (!problem) {
      await git.ok([
        'init',
        '--quiet',
        '--bare',
        `--object-format=${manifest.objectFormat}`,
        empty,
      ]);
      const verified = await git.run(['bundle', 'verify', file], { env: { GIT_DIR: empty } });
      if (verified.code !== 0)
        return fault(row, problems, `${manifest.bundle.key} is not a complete bundle`);
      return row;
    }
    return fault(row, problems, problem);
  } finally {
    await rm(file, { force: true });
    await rm(empty, { recursive: true, force: true });
  }
}

/** Write one project's repository back, then prove it holds exactly the refs that were copied. */
async function restore(
  store: BackupObjectStore,
  repositories: CodeRepositories,
  manifest: BackupManifest,
  scratch: string,
  problems: string[],
  overwrite?: boolean,
): Promise<RestoredProject> {
  const row: RestoredProject = {
    projectId: manifest.projectId,
    takenAt: manifest.takenAt,
    bundle: manifest.bundle?.key ?? null,
    bytes: manifest.bundle?.bytes ?? 0,
    refs: manifest.refs.length,
    state: 'restored',
  };
  const paths = repositories.paths(manifest.projectId);
  const file = join(scratch, 'bundle');
  const expected = manifest.refs.map((ref) => `${ref.name} ${ref.oid}`).sort();
  const refsOf = async () =>
    (
      await repositories.git.ok(['for-each-ref', '--format=%(refname) %(objectname)'], {
        env: repositories.environment(manifest.projectId),
      })
    )
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .sort();
  try {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    // The marker is written from the manifest rather than rebuilt, so a directory that once
    // served several repository identities serves them again; a directory that already
    // carries another project's is left alone and refused by ensure() below.
    await open(paths.marker, 'wx', 0o600).then(
      async (handle) => {
        try {
          await handle.writeFile(manifest.marker);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    await repositories.ensure(manifest.projectId, manifest.repositoryId, manifest.objectFormat);
    // The writer lock proves no server is running, not that the root is empty — and the
    // server is stopped in exactly the two cases a restore runs. The fetch below is forced,
    // so anything admitted since takenAt would be rewound silently: refuse unless this
    // repository is empty or already at this copy, and make the other case be asked for.
    const before = await refsOf();
    if (before.length && before.join('\n') !== expected.join('\n') && !overwrite)
      return fault(
        row,
        problems,
        `${manifest.projectId} already holds refs this copy would rewind; pass --overwrite to replace them`,
      );
    if (manifest.bundle) {
      const problem = await read(store, manifest.bundle, file);
      if (problem) return fault(row, problems, problem);
      const env = repositories.environment(manifest.projectId);
      const verified = await repositories.git.run(['bundle', 'verify', file], { env });
      if (verified.code !== 0)
        return fault(row, problems, `${manifest.bundle.key} is not a complete bundle`);
      // A bundle is an ordinary fetch source, and a fetch with no named remote writes no
      // remote.* key — which validate() would refuse. `git clone --bare` writes one.
      await repositories.git.ok(['fetch', '--no-tags', file, '+refs/*:refs/*'], {
        env,
        protocol: 'file',
        timeoutMs: 10 * 60_000,
      });
    }
    if ((await refsOf()).join('\n') !== expected.join('\n'))
      return fault(row, problems, `${manifest.projectId} was restored to another set of refs`);
    return row;
  } catch (error) {
    return fault(row, problems, `${manifest.projectId}: ${(error as Error).message}`);
  } finally {
    await rm(file, { force: true });
  }
}

function fault(row: RestoredProject, problems: string[], problem: string): RestoredProject {
  problems.push(problem);
  return { ...row, state: 'failed', problem };
}
