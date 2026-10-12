/**
 * Reading a project's code as a person reads it on GitHub: one commit's folder, as its entries, or
 * one of its files, as text. It reads Code's own repository and writes nothing; a path is a path
 * inside that commit's tree and can name nothing outside it.
 */
import { MervError, check } from '@merv/contracts';
import type { CodeRepositories } from './store/repository.js';
import type { CodeBrowsed, CodeFolderEntry, CodeLogEntry } from './models.js';

/** The most of one file shown as text. */
export const MOST_FILE_BYTES = 1024 * 1024;
/** The most of one file the page fetches whole (raw): a PDF, a picture, a long log. */
export const MOST_RAW_BYTES = 32 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KINDS: Record<string, CodeFolderEntry['kind']> = {
  tree: 'folder',
  blob: 'file',
  commit: 'submodule',
};

/** A path inside a tree: segments of a name each, no `.`, `..` or empty one, and no NUL. */
export function treePath(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  check(
    !clean.includes('\0') &&
      clean.length <= 4096 &&
      clean.split('/').every((part) => part && part !== '.' && part !== '..'),
    'invalid_code_path',
    'A path names a file or folder inside the code, segment by segment',
  );
  return clean;
}

/** Git over one project's repository, and what `path` names in `commit`: its type, or not there. */
async function at(repositories: CodeRepositories, projectId: string, commit: string, path: string) {
  check(OID.test(commit), 'invalid_code_ref', 'A commit is its full object id');
  path = treePath(path);
  const git = (args: string[], maxBuffer = 4 * 1024 * 1024) =>
    repositories.git.run(args, {
      env: repositories.environment(projectId),
      timeoutMs: 10_000,
      maxBuffer,
    });
  check(await repositories.exists(projectId), 'code_not_found', 'This project has no code', 404);
  const target = `${commit}:${path}`;
  const kind = await git(['cat-file', '-t', target]);
  if (kind.code !== 0) {
    const known = await git(['cat-file', '-e', `${commit}^{commit}`]);
    throw new MervError(
      'code_path_not_found',
      known.code === 0 ? `No "${path}" in this code` : 'Code does not hold that commit',
      404,
    );
  }
  const type = kind.stdout.toString('utf8').trim();
  const size = async () => {
    check(type === 'blob', 'code_path_not_found', `"${path}" is not a file`, 404);
    return Number((await git(['cat-file', '-s', target])).stdout.toString('utf8').trim());
  };
  return { git, path, target, type, size };
}

/** One commit's folder or file at `path` ('' is the root). */
export async function browse(
  repositories: CodeRepositories,
  projectId: string,
  commit: string,
  path: string,
): Promise<CodeBrowsed> {
  const found = await at(repositories, projectId, commit, path);
  const { git, target } = found;
  path = found.path;
  if (found.type === 'tree') {
    const listed = await git(['ls-tree', '-l', '-z', target]);
    check(listed.code === 0, 'code_git_failed', 'The folder could not be read', 500);
    const entries = listed.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line): CodeFolderEntry => {
        const [meta, name] = [
          line.slice(0, line.indexOf('\t')),
          line.slice(line.indexOf('\t') + 1),
        ];
        const [mode, objectType, , size] = meta.split(/\s+/);
        return {
          name: name!,
          kind: mode === '120000' ? 'link' : (KINDS[objectType!] ?? 'file'),
          ...(objectType === 'blob' && { size: Number(size) }),
        };
      })
      // Folders first, then files, each by name as a person sorts them.
      .sort(
        (a, b) =>
          Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      );
    return { kind: 'folder', commit, path, entries };
  }
  const size = await found.size();
  if (size > MOST_FILE_BYTES) return { kind: 'file', commit, path, size, withheld: 'too_large' };
  const bytes = (await git(['cat-file', 'blob', target], MOST_FILE_BYTES + 1024)).stdout;
  // Git's own test for binary content: a NUL in the first 8000 bytes.
  if (bytes.subarray(0, 8000).includes(0))
    return { kind: 'file', commit, path, size, withheld: 'binary' };
  return { kind: 'file', commit, path, size, text: bytes.toString('utf8') };
}

/** One file's bytes as they are, for the page to show what is not text or too long to send as such. */
export async function raw(
  repositories: CodeRepositories,
  projectId: string,
  commit: string,
  path: string,
): Promise<Buffer> {
  const { git, target, size } = await at(repositories, projectId, commit, path);
  const bytes = await size();
  check(
    bytes <= MOST_RAW_BYTES,
    'code_file_too_large',
    'Over 32 MiB, too large to fetch here',
    413,
  );
  const read = await git(['cat-file', 'blob', target], bytes + 1024);
  check(read.code === 0, 'code_git_failed', 'The file could not be read', 500);
  return read.stdout;
}

/** The most commits one read of history returns. */
export const MOST_LOG = 200;

/** A commit's history as `git log` reads it, newest first, optionally only where `path` changed. */
export async function log(
  repositories: CodeRepositories,
  projectId: string,
  commit: string,
  { limit = 50, path = '' }: { limit?: number; path?: string } = {},
): Promise<CodeLogEntry[]> {
  check(OID.test(commit), 'invalid_code_ref', 'A commit is its full object id');
  const where = treePath(path);
  const listed = await repositories.git.run(
    [
      'log',
      `-n${Math.max(1, Math.min(MOST_LOG, limit))}`,
      '--format=%H%x00%P%x00%aI%x00%s%x00%b%x1e',
      commit,
      ...(where ? ['--', where] : []),
    ],
    { env: repositories.environment(projectId), timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  check(listed.code === 0, 'code_path_not_found', 'Code does not hold that commit', 404);
  return listed.stdout
    .toString('utf8')
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [oid, parents, date, subject, body] = record.split('\0');
      return {
        oid: oid!,
        parents: parents ? parents.split(' ') : [],
        date: date!,
        subject: subject ?? '',
        // A body is the bullet points of a change; kept short whatever was written.
        body: (body ?? '').trim().slice(0, 2_000),
      };
    });
}

/** The commits `head` adds over `base`: the work of the unit whose head and base they are. */
export async function added(
  repositories: CodeRepositories,
  projectId: string,
  head: string,
  base: string | null,
): Promise<string[]> {
  const walk = await repositories.git.run(
    ['rev-list', '--max-count=5000', head, ...(base ? ['--not', base] : [])],
    { env: repositories.environment(projectId), timeoutMs: 10_000 },
  );
  return walk.code === 0 ? walk.stdout.toString('utf8').split('\n').filter(Boolean) : [];
}
