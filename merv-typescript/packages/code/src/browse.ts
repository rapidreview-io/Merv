/**
 * Reading a project's code as a person reads it on GitHub: one commit's folder, as its entries, or
 * one of its files, as text. It reads Code's own repository and writes nothing; a path is a path
 * inside that commit's tree and can name nothing outside it.
 */
import { MervError, check } from '@merv/contracts';
import type { CodeRepositories } from './store/repository.js';
import type { CodeBrowsed, CodeFolderEntry } from './models.js';

/** The most of one file shown as text. */
export const MOST_FILE_BYTES = 1024 * 1024;
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

/** One commit's folder or file at `path` ('' is the root). */
export async function browse(
  repositories: CodeRepositories,
  projectId: string,
  commit: string,
  path: string,
): Promise<CodeBrowsed> {
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
  if (type === 'tree') {
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
  check(type === 'blob', 'code_path_not_found', `"${path}" is not a file or a folder`, 404);
  const size = Number((await git(['cat-file', '-s', target])).stdout.toString('utf8').trim());
  if (size > MOST_FILE_BYTES) return { kind: 'file', commit, path, size, withheld: 'too_large' };
  const bytes = (await git(['cat-file', 'blob', target], MOST_FILE_BYTES + 1024)).stdout;
  // Git's own test for binary content: a NUL in the first 8000 bytes.
  if (bytes.subarray(0, 8000).includes(0))
    return { kind: 'file', commit, path, size, withheld: 'binary' };
  return { kind: 'file', commit, path, size, text: bytes.toString('utf8') };
}
