import { check, digest, type Caller } from '@merv/contracts';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile } from '../files.js';
import { bundleHeader } from './admission.js';
import { EXPORT_TTL_MS } from './repository.js';
import { FETCH_TIMEOUT_MS, serial, type StoreCore } from './core.js';

export type CodeExport =
  | { upToDate: true; head: string }
  | {
      exportId: string;
      sha256: string;
      bytes: number;
      head: string;
      prerequisites: string[];
      partBytes: number;
      expiresAt: string;
    };

/** Downloads: the bundle a session reads of one commit and of what its machine lacks. */
export class CodeExporter {
  readonly exporting = new Map<string, Promise<void>>();
  readonly exports = new Map<
    string,
    {
      key: string;
      projectId: string;
      sessionId: string;
      view: Exclude<CodeExport, { upToDate: true }>;
    }
  >();
  constructor(private readonly core: StoreCore) {}

  /**
   * Write exactly one commit and what the machine does not have of its history into a bundle
   * a session may read in parts. A session has one export at a time: asking again for the
   * same thing finds it, asking for another replaces it. Only commits this repository holds
   * count as haves, so a machine that claims more than it has breaks only its own import.
   */
  async export(
    caller: Caller,
    input: { sessionId: string; head: string; haves: string[]; secondParent?: string },
  ): Promise<CodeExport> {
    this.core.assertOpen();
    await this.core.managedRead(caller, input.sessionId);
    // The session's one bundle path is cut, or swept, by one job at a time; one asked again waits.
    const exportId = `exp${createHash('sha256').update(`${caller.projectId}\0${input.sessionId}`).digest('hex').slice(0, 32)}`;
    return await serial(this.exporting, exportId, () =>
      this.core.owned(() => this.writeExport(caller, input, exportId)),
    );
  }

  private async writeExport(
    caller: Caller,
    input: { sessionId: string; head: string; haves: string[]; secondParent?: string },
    exportId: string,
  ): Promise<CodeExport> {
    const projectId = caller.projectId;
    const env = this.core.repositories.environment(projectId);
    const git = this.core.repositories.git;
    const missing = await this.core.absent(projectId, input.haves);
    const haves = [...new Set(input.haves)].filter((oid) => !missing.has(oid)).sort();
    if (haves.includes(input.head) && (!input.secondParent || haves.includes(input.secondParent)))
      return { upToDate: true, head: input.head };
    const key = digest({ head: input.head, haves, secondParent: input.secondParent ?? null });
    const paths = this.core.repositories.paths(projectId);
    const file = join(paths.exports, `${exportId}.bundle`);
    const known = this.exports.get(exportId);
    if (
      known?.key === key &&
      Date.parse(known.view.expiresAt) > Date.now() + 60_000 &&
      (await lstat(file).catch(() => null))
    )
      return known.view;
    return await this.core.repositories.transfer(async () => {
      await mkdir(paths.exports, { recursive: true, mode: 0o700 });
      const ref = `refs/merv/exports/${exportId}`;
      // Whatever this session held is given back before the next is measured: one download at
      // a time is all a session ever costs, whether or not this Code is the one that wrote it.
      this.exports.delete(exportId);
      // This session's exports run one at a time on the one server writing this root, so a
      // lock still on its bundle or refs is what a killed Git child or server left behind.
      await rm(`${file}.lock`, { force: true });
      await this.core.clearRefLocks(paths.repository, [ref, `${ref}-second`]);
      await rm(file, { force: true });
      await git.run(['update-ref', '-d', ref], { env });
      await git.run(['update-ref', '-d', `${ref}-second`], { env });
      // The bundle is written under the project's directory and counts against its quota, so
      // what it will take is weighed before a byte of it is written, as a transfer's bytes are.
      // Without that, a first download of a large history fills the quota and every upload of
      // the project is refused until the export is old enough for the sweep to take it away.
      const measured = await git.ok(
        [
          'rev-list',
          '--disk-usage',
          '--objects',
          input.head,
          ...(input.secondParent ? [input.secondParent] : []),
          ...(haves.length ? ['--not', ...haves] : []),
        ],
        { env, timeoutMs: FETCH_TIMEOUT_MS },
      );
      const estimate = Number(measured.toString('utf8').trim());
      check(Number.isFinite(estimate), 'code_git_failed', 'Git could not weigh the download', 500);
      await this.core.repositories.assertRoom(projectId, estimate);
      await git.ok(['update-ref', ref, input.head], { env });
      const secondRef = `${ref}-second`;
      if (input.secondParent) await git.ok(['update-ref', secondRef, input.secondParent], { env });
      const made = await git.run(
        [
          'bundle',
          'create',
          file,
          ref,
          ...(input.secondParent ? [secondRef] : []),
          ...(haves.length ? ['--not', ...haves] : []),
        ],
        { env, timeoutMs: FETCH_TIMEOUT_MS },
      );
      if (made.code !== 0) {
        // Git refuses an empty bundle: everything the head reaches is beneath a have.
        await rm(file, { force: true });
        await git.run(['update-ref', '-d', ref], { env });
        await git.run(['update-ref', '-d', `${ref}-second`], { env });
        this.exports.delete(exportId);
        // Any other failure is Git not writing the bundle at all. Calling that up to date
        // would send the machine away believing it holds a history it never received; said
        // as a failure, the machine defers and asks again.
        check(
          /empty bundle/i.test(made.stderr),
          'code_git_failed',
          `git bundle failed: ${made.stderr.split('\n')[0] ?? ''}`.trim(),
          500,
        );
        return { upToDate: true as const, head: input.head };
      }
      await chmod(file, 0o600);
      const view = {
        exportId,
        sha256: await hashFile(file),
        bytes: (await stat(file)).size,
        head: input.head,
        prerequisites: (await bundleHeader(file, true)).prerequisites,
        partBytes: this.core.config.partBytes,
        expiresAt: new Date(Date.now() + EXPORT_TTL_MS).toISOString(),
      };
      this.exports.set(exportId, { key, projectId, sessionId: input.sessionId, view });
      return view;
    });
  }

  /** One part of a session's own export; nothing else under the project's directory is served. */
  async readExport(
    caller: Caller,
    exportId: string,
    input: { sessionId: string; offset: number; length: number },
  ): Promise<Buffer> {
    this.core.assertOpen();
    await this.core.managedRead(caller, input.sessionId);
    const known = this.exports.get(exportId);
    check(
      known &&
        known.projectId === caller.projectId &&
        known.sessionId === input.sessionId &&
        Date.parse(known.view.expiresAt) > Date.now(),
      'code_export_not_found',
      'No such export for this session; ask for the download again',
      404,
    );
    const handle = await open(
      join(this.core.repositories.paths(caller.projectId).exports, `${exportId}.bundle`),
      'r',
    ).catch(() => null);
    check(handle, 'code_export_not_found', 'This export has expired; ask for it again', 404);
    try {
      const length = Math.min(
        input.length,
        this.core.config.partBytes,
        known.view.bytes - input.offset,
      );
      check(length > 0, 'code_upload_offset', 'The export has no bytes at that offset', 409);
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, input.offset);
      // A download somebody is still reading is not an abandoned one. Each part puts both the
      // deadline and the age the sweep reads back to a full term, so a transfer that needs
      // longer than one term finishes, instead of being refused in the middle and beginning
      // again at its first byte against a bundle that was just cut anew.
      const at = new Date();
      // Stamping the file is bookkeeping for the sweep and no part of the answer. A volume
      // that will not stamp a handle must not fail a part whose bytes are already read, and
      // the stamp goes first so the age the sweep measures is never behind the deadline.
      await handle.utimes(at, at).catch(() => {});
      // Only the entry these bytes were read against may be given the longer term. export()
      // runs in the transfer lane and this read in none, so it may have cut a new bundle over
      // the same path meanwhile; its view describes the file that is there now, and putting
      // the old one back would clamp every later part by the wrong length.
      if (this.exports.get(exportId) === known)
        this.exports.set(exportId, {
          ...known,
          view: {
            ...known.view,
            expiresAt: new Date(at.getTime() + EXPORT_TTL_MS).toISOString(),
          },
        });
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
