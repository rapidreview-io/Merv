import { check, MervError } from '@merv/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, connect, type Server } from 'node:net';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerGit } from '../git.js';

export type ObjectFormat = 'sha1' | 'sha256';
export interface CodeRepositoryConfig {
  /** The directory that holds every project's repository; it lives on the data volume. */
  root: string;
  /** Everything one project may keep: objects, quarantine, held bundles and exports. */
  quotaBytes: number;
  /** A transfer is refused while the volume has less free space than this. */
  reservedFreeBytes: number;
}
export interface ProjectPaths {
  directory: string;
  repository: string;
  marker: string;
  quarantine: string;
  held: string;
  exports: string;
}

const HOUR = 3600_000;
export const EXPORT_TTL_MS = 15 * 60_000;
/** How long a disk measurement is good enough for a reader, who asks every ten seconds. */
const USAGE_TTL = 60_000;
/** A unix socket address holds about a hundred bytes on the systems Merv runs on. */
const SOCKET_PATH_BYTES = 100;
/** What Code writes into a repository's configuration; anything else found there is refused. */
const controlled: Record<string, string> = {
  'core.bare': 'true',
  'core.fsync': 'all',
  'core.fsyncmethod': 'fsync',
  'core.logallrefupdates': 'false',
  'gc.auto': '0',
  'transfer.fsckobjects': 'true',
};
/** What `git init` writes by itself, whose values depend on the filesystem. */
const incidental = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'extensions.objectformat',
]);

/** Write a directory entry to disk, so a rename or a link survives losing power. */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The bytes beneath a path; a missing path holds none. */
export async function diskBytes(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    return (await lstat(path)).size;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await diskBytes(child);
    else
      total += await lstat(child).then(
        (stat) => stat.size,
        () => 0,
      );
  }
  return total;
}

/**
 * The directory of repositories Code owns on the server's disk: one bare repository for each
 * project, created from an empty template with a configuration Code wrote and checks again
 * whenever it opens one. One process writes here at a time, which a bound unix socket
 * enforces for as long as that process lives, and work on one project runs in turn.
 */
export class CodeRepositories {
  readonly git: ServerGit;
  private lock?: Server;
  private alias?: string;
  private closing = false;
  private readonly chains = new Map<string, Promise<unknown>>();
  private transfers = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly validated = new Set<string>();
  private readonly measured = new Map<string, { bytes: number; atMs: number }>();

  constructor(
    readonly config: CodeRepositoryConfig,
    git?: ServerGit,
  ) {
    this.git = git ?? new ServerGit(join(config.root, 'tmp'));
  }

  private get template(): string {
    return join(this.config.root, 'empty-template');
  }

  /** Create the root, prove Git is usable and take the writer lock. */
  async open(): Promise<void> {
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.config.root, 'tmp'), { recursive: true, mode: 0o700 });
    await mkdir(this.template, { recursive: true, mode: 0o700 });
    await this.git.assertGit();
    await this.acquire();
  }

  /**
   * The lock is a listening unix socket: the operating system releases it when the process
   * dies, however it dies. A path that is in use but refuses a connection was left by a dead
   * process and is taken over once. Two servers started on one volume in the same instant can
   * both take it over; one server per volume is the supported deployment.
   */
  private async acquire(): Promise<void> {
    let path = join(this.config.root, 'writer.sock');
    if (Buffer.byteLength(path) > SOCKET_PATH_BYTES) {
      // The socket still lives in the root, so it still excludes another process there; it
      // is only addressed through a shorter name.
      const alias = join(
        tmpdir(),
        `merv-code-${createHash('sha256').update(this.config.root).digest('hex').slice(0, 16)}`,
      );
      if ((await readlink(alias).catch(() => null)) !== this.config.root) {
        await rm(alias, { force: true });
        await symlink(this.config.root, alias);
      }
      path = join(alias, 'writer.sock');
      check(
        Buffer.byteLength(path) <= SOCKET_PATH_BYTES,
        'code_repository_path',
        'The Code repository root is too long a path to lock',
        500,
      );
      this.alias = alias;
    }
    const locked = new MervError(
      'code_repository_locked',
      'Another Merv server is writing to this Code repository root; one server writes to a volume at a time',
      503,
    );
    for (const attempt of [0, 1]) {
      const server = createServer((socket) => socket.destroy());
      const bound = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        server.once('error', resolve);
        server.listen(path, () => resolve(null));
      });
      if (!bound) {
        server.unref();
        this.lock = server;
        return;
      }
      if (bound.code !== 'EADDRINUSE') throw bound;
      const alive = await new Promise<boolean>((resolve) => {
        const socket = connect(path);
        socket.once('connect', () => (socket.destroy(), resolve(true)));
        socket.once('error', () => resolve(false));
      });
      if (alive || attempt) throw locked;
      await unlink(path).catch(() => {});
    }
    throw locked;
  }

  paths(projectId: string): ProjectPaths {
    const directory = join(
      this.config.root,
      createHash('sha256').update(projectId).digest('hex').slice(0, 32),
    );
    return {
      directory,
      repository: join(directory, 'repository.git'),
      marker: join(directory, 'merv-project.json'),
      quarantine: join(directory, 'quarantine'),
      held: join(directory, 'held'),
      exports: join(directory, 'exports'),
    };
  }

  /** The environment of a Git child that reads and writes the project's own repository. */
  environment(projectId: string): Record<string, string> {
    return { GIT_DIR: this.paths(projectId).repository };
  }

  async exists(projectId: string): Promise<boolean> {
    return await lstat(this.paths(projectId).repository).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
  }

  /**
   * Create the project's repository, or check the one that is there. Nothing of another
   * repository is ever copied in: no configuration, hook, alternate or ref, only objects that
   * passed admission.
   */
  async ensure(projectId: string, repositoryId: string, format: ObjectFormat): Promise<void> {
    const paths = this.paths(projectId);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const identity = JSON.stringify({ format: 1, projectId, repositoryId });
    try {
      const marker = await open(paths.marker, 'wx', 0o600);
      try {
        await marker.writeFile(identity);
        await marker.sync();
      } finally {
        await marker.close();
      }
      await syncDirectory(paths.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await this.exists(projectId))) {
      const bootstrap = join(paths.directory, `bootstrap-${randomUUID()}`);
      const target = join(bootstrap, 'repository.git');
      try {
        await mkdir(bootstrap, { mode: 0o700 });
        await this.git.ok([
          'init',
          '--quiet',
          '--bare',
          `--template=${this.template}`,
          `--object-format=${format}`,
          target,
        ]);
        for (const [key, value] of Object.entries(controlled))
          await this.git.ok(['config', '--file', join(target, 'config'), key, value]);
        await rename(target, paths.repository);
        await syncDirectory(paths.directory);
      } finally {
        await rm(bootstrap, { recursive: true, force: true });
      }
      this.validated.delete(projectId);
    }
    await this.validate(projectId, repositoryId);
    check(
      (await this.objectFormat(projectId)) === format,
      'code_bundle_format',
      'This project’s repository uses another object format',
      409,
    );
  }

  /** Remove a repository nothing was ever admitted into, so it can be created in another format. */
  async discard(projectId: string): Promise<void> {
    this.validated.delete(projectId);
    await rm(this.paths(projectId).repository, { recursive: true, force: true });
  }

  async objectFormat(projectId: string): Promise<ObjectFormat> {
    const format = (
      await this.git.ok(['rev-parse', '--show-object-format'], {
        env: this.environment(projectId),
      })
    )
      .toString('utf8')
      .trim();
    check(
      format === 'sha1' || format === 'sha256',
      'code_repository_unsafe',
      'The repository reports an object format Code does not know',
      500,
    );
    return format;
  }

  /**
   * Record that this directory now also serves `repositoryId`, and answer with every identity
   * it serves, oldest first. It runs before the activation transaction: a crash between the two
   * leaves the new identity accepted here while the row still names the old one, which breaks
   * nothing and replays, whereas appending afterwards would leave every Git operation of the
   * project failing validate() with code_repository_foreign.
   *
   * `lineage` is what the binding row itself holds, oldest first and ending in the repository
   * the project is bound to now. The written list is built from it rather than from the file,
   * so an identity left behind by a rebind that never reached its transaction is pruned by the
   * next one that does; and the directory is refused unless it already serves the identity the
   * row names, which is the one thing the format-1 marker proved.
   */
  async rebind(projectId: string, lineage: string[], repositoryId: string): Promise<string[]> {
    const paths = this.paths(projectId);
    const held = await this.marker(projectId);
    check(
      held.projectId === projectId && held.repositoryIds.includes(lineage.at(-1)!),
      'code_repository_foreign',
      'The repository directory belongs to another project or does not serve this binding',
      500,
    );
    const repositoryIds = lineage.includes(repositoryId) ? lineage : [...lineage, repositoryId];
    const next = `${paths.marker}.next`;
    const handle = await open(next, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ format: 2, projectId, repositoryIds }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(next, paths.marker);
    await syncDirectory(paths.directory);
    // validate() answers from this memo for the life of the process, so the next Git operation
    // of this project would otherwise never read the identity just written.
    this.validated.delete(projectId);
    return repositoryIds;
  }

  /**
   * The identities the marker file says this directory serves, in the order it gained them.
   * Format 1 is the marker every project that was never rebound still carries, and it is read
   * back byte-for-byte as `ensure` wrote it; format 2 is the append-only list a rebind writes.
   */
  private async marker(projectId: string): Promise<{ projectId: string; repositoryIds: string[] }> {
    let held: unknown;
    try {
      held = JSON.parse(await readFile(this.paths(projectId).marker, 'utf8'));
    } catch {
      throw new MervError(
        'code_repository_foreign',
        'The repository directory carries no Code identity',
        500,
      );
    }
    const body = held as { format?: unknown; projectId?: unknown; repositoryId?: unknown };
    const foreign = 'The repository directory carries a Code identity this server cannot read';
    if (body.format === 1) {
      check(
        JSON.stringify(held) ===
          JSON.stringify({
            format: 1,
            projectId: body.projectId,
            repositoryId: body.repositoryId,
          }) && typeof body.repositoryId === 'string',
        'code_repository_foreign',
        foreign,
        500,
      );
      return { projectId: String(body.projectId), repositoryIds: [body.repositoryId as string] };
    }
    const listed = held as { format?: unknown; projectId?: unknown; repositoryIds?: unknown };
    check(
      listed.format === 2 &&
        typeof listed.projectId === 'string' &&
        Array.isArray(listed.repositoryIds) &&
        listed.repositoryIds.every((entry) => typeof entry === 'string') &&
        Object.keys(listed).length === 3,
      'code_repository_foreign',
      foreign,
      500,
    );
    return {
      projectId: listed.projectId as string,
      repositoryIds: listed.repositoryIds as string[],
    };
  }

  /** Refuse a directory Code did not make, or one whose configuration was changed beneath it. */
  async validate(projectId: string, repositoryId: string): Promise<void> {
    if (this.validated.has(projectId)) return;
    const paths = this.paths(projectId);
    const unsafe = (message: string) => new MervError('code_repository_unsafe', message, 500);
    const held = await this.marker(projectId);
    check(
      held.projectId === projectId && held.repositoryIds.includes(repositoryId),
      'code_repository_foreign',
      'The repository directory belongs to another project or repository',
      500,
    );
    if (await lstat(join(paths.repository, 'objects', 'info', 'alternates')).catch(() => null))
      throw unsafe('The repository borrows objects from another through an alternates file');
    if ((await readdir(join(paths.repository, 'hooks')).catch(() => [])).length)
      throw unsafe('The repository contains hooks');
    const listed = (
      await this.git.ok(['config', '--file', join(paths.repository, 'config'), '--list', '-z'])
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('\n');
        return [at < 0 ? entry : entry.slice(0, at), at < 0 ? '' : entry.slice(at + 1)];
      });
    for (const [key, value] of listed)
      if (!(incidental.has(key) || controlled[key] === value))
        throw unsafe(`The repository configuration sets ${key}, which Code did not write`);
    for (const key of Object.keys(controlled))
      if (!listed.some(([name]) => name === key))
        throw unsafe(`The repository configuration lost ${key}`);
    this.validated.add(projectId);
  }

  /** Work on one project runs in the order it was asked for, never at the same time. */
  run<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new MervError('code_unavailable', 'Code is unavailable', 503));
    const next = (this.chains.get(projectId) ?? Promise.resolve()).then(job, job);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.chains.set(projectId, settled);
    void settled.then(() => {
      // That work may have changed what the project takes on disk, so the measurement goes.
      this.measured.delete(projectId);
      if (this.chains.get(projectId) === settled) this.chains.delete(projectId);
    });
    return next;
  }

  /** At most two imports or exports index or write packs at once, across every project. */
  async transfer<T>(job: () => Promise<T>): Promise<T> {
    if (this.transfers >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.transfers++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.transfers--;
    }
  }

  /**
   * How much disk the project's repository takes. Walking it is the most expensive thing a
   * status read does, so a reader is given a measurement up to a minute old. It is never
   * older than the last work on that project, which forgets it, and whoever is about to
   * write takes a fresh one.
   */
  async usage(projectId: string): Promise<number> {
    const held = this.measured.get(projectId);
    if (held && Date.now() - held.atMs < USAGE_TTL) return held.bytes;
    return await this.measure(projectId);
  }

  private async measure(projectId: string): Promise<number> {
    const bytes = await diskBytes(this.paths(projectId).directory);
    this.measured.set(projectId, { bytes, atMs: Date.now() });
    return bytes;
  }

  /** Refuse bytes the volume or the project's quota cannot take; the refusal passes with time or an operator. */
  async assertRoom(projectId: string, incoming: number): Promise<void> {
    const full = (message: string) => new MervError('code_store_full', message, 507);
    const volume = await statfs(this.config.root);
    if (volume.bavail * volume.bsize - incoming < this.config.reservedFreeBytes)
      throw full('The Code volume is below its reserved free space');
    if (incoming && (await this.measure(projectId)) + incoming > this.config.quotaBytes)
      throw full('This transfer would take the project past its Code disk quota');
  }

  /**
   * Remove what no operation needs any more: quarantine directories of finished operations,
   * or of none when they are an hour old, expired exports with their refs, and temporary
   * packs an interrupted child left behind. Held bundles, every other ref and every pack of
   * a repository are never touched; nothing here collects garbage or prunes.
   */
  async sweep(
    finished: (operationId: string) => Promise<boolean | undefined>,
    nowMs = Date.now(),
  ): Promise<void> {
    const old = async (path: string, age: number) =>
      await lstat(path).then(
        (stat) => nowMs - stat.mtimeMs > age,
        () => false,
      );
    for (const entry of await readdir(this.config.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue;
      const directory = join(this.config.root, entry.name);
      for (const operationId of await readdir(join(directory, 'quarantine')).catch(() => [])) {
        const path = join(directory, 'quarantine', operationId);
        const state = await finished(operationId);
        if (state === true || (state === undefined && (await old(path, HOUR))))
          await rm(path, { recursive: true, force: true });
      }
      const repository = join(directory, 'repository.git');
      for (const name of await readdir(join(directory, 'exports')).catch(() => [])) {
        const path = join(directory, 'exports', name);
        if (!(await old(path, EXPORT_TTL_MS))) continue;
        await rm(path, { force: true });
        const exportId = name.replace(/\.bundle$/, '');
        if (/^[A-Za-z0-9_]+$/.test(exportId))
          for (const suffix of ['', '-second'])
            await this.git.run(['update-ref', '-d', `refs/merv/exports/${exportId}${suffix}`], {
              env: { GIT_DIR: repository },
            });
      }
      const packs = join(repository, 'objects', 'pack');
      for (const name of await readdir(packs).catch(() => []))
        if (name.startsWith('tmp_') && (await old(join(packs, name), HOUR)))
          await rm(join(packs, name), { force: true });
    }
  }

  /**
   * Stop taking work and wait for what is running. When that outlasts the deadline the Git
   * children are ended instead: every step they were in is journalled and is replayed by the
   * next start. Returns whether everything finished by itself.
   */
  async close(deadlineMs: number): Promise<boolean> {
    this.closing = true;
    const idle = async () => {
      while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
    };
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      idle().then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), deadlineMs))),
    ]);
    clearTimeout(timer);
    this.git.close();
    await idle();
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await new Promise<void>((resolve) => lock.close(() => resolve()));
    if (this.alias) await rm(this.alias, { force: true });
    return drained;
  }
}
