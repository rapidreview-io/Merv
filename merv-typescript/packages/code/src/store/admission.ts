import { CODE_BUNDLE_MAX_BYTES, MervError, type CodeFinding } from '@merv/contracts';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerGit } from '../git.js';
import type { ObjectFormat } from './repository.js';

export interface AdmissionLimits {
  /** No blob, and no other object, may be larger. */
  blobBytes: number;
  /** The sum of the sizes of the objects a transfer introduces. */
  expandedBytes: number;
  /** How many objects a transfer may introduce. */
  objects: number;
  denyGlobs: string[];
  secretExemptGlobs: string[];
}
export const defaultLimits: Omit<AdmissionLimits, 'denyGlobs' | 'secretExemptGlobs'> = {
  blobBytes: 50 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024 * 1024,
  objects: 100_000,
};
export interface BundleHeader {
  objectFormat: ObjectFormat;
  prerequisites: string[];
  head: string;
  /** Where the pack begins in the file. */
  packOffset: number;
}
export interface AdmissionInput {
  git: ServerGit;
  /** The project's own repository, which the quarantine borrows objects from and never writes. */
  repository: string;
  /** This operation's directory; its `objects` are wiped and rebuilt on every run. */
  quarantine: string;
  bundle: string;
  /** The commit the operation was promised. The bundle's own ref name authorises nothing. */
  head: string;
  /** The commit the head must descend from, or null when there is none to continue. */
  expectedHead: string | null;
  /** The only prerequisites the bundle may name, or `admitted` for any commit already kept. */
  prerequisites: string[] | 'admitted';
  /** Frozen merge inputs authorise their already-retained ancestors as bundle boundaries. */
  prerequisiteAncestors?: boolean;
  limits: AdmissionLimits;
  /** Called after the pack is indexed, for tests that end the process there. */
  indexed?: () => void;
}
export interface Admission {
  objectFormat: ObjectFormat;
  head: string;
  tree: string;
  /** What the transfer introduces: the objects nothing already kept reaches. */
  objects: number;
  bytes: number;
  findings: CodeFinding[];
}

/** A transfer that is not what was promised. It is refused outright and nothing of it is kept. */
export class AdmissionRejected extends MervError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

const MAX_FINDINGS = 200;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_VISITS = 2_000_000;
const MAX_SYMLINK_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const MAX_DEPTH = 64;
const INDEX_TIMEOUT_MS = 15 * 60_000;
const WALK_TIMEOUT_MS = 15 * 60_000;

/**
 * credentials@1: a short list of credentials whose shape is unmistakable. It is not proof
 * that a history holds no secret; it keeps the well-known ones out of Code and of GitHub.
 */
const credentials: [rule: string, pattern: RegExp][] = [
  ['credentials@1.private_key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['credentials@1.github_token', /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,255}(?![A-Za-z0-9])/],
  ['credentials@1.github_pat', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/],
  ['credentials@1.slack_token', /(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['credentials@1.anthropic_key', /(?<![A-Za-z0-9_])sk-ant-[A-Za-z0-9_-]{80,}/],
  ['credentials@1.merv_session', /(?<![A-Za-z0-9_-])ms_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
];
const anyCredential = new RegExp(credentials.map(([, pattern]) => pattern.source).join('|'));

/**
 * The project deny-glob matcher: a literal matches itself, `?` one character and `*` any run
 * within one path segment, and `**` any run across segments; a whole segment of `**` also
 * matches no segment at all. A glob is matched against the whole path from the repository root.
 */
export function globPattern(glob: string): RegExp {
  let source = '';
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '*' && glob[at + 1] === '*') {
      at++;
      if (glob[at + 1] === '/' && (at === 1 || glob[at - 2] === '/')) {
        at++;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 's');
}

/** HFS+ ignores these code points in a name, so a `.git` spelt with one of them is still `.git` on a Mac. */
const hfsIgnored = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * What is wrong with one name in a tree, or null. Strict fsck already refuses `.`, `..`, an
 * empty name, a `/` in a name and `.git` with its HFS+ and NTFS spellings when the pack is
 * indexed; they are refused here as well so that the rule does not rest on one Git version.
 */
export function nameFinding(raw: Buffer): string | null {
  if (raw.length === 0 || raw.length > MAX_NAME_BYTES) return 'path_name';
  const name = raw.toString('utf8');
  if (name === '.' || name === '..' || /[/\\]/.test(name)) return 'path_name';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'path_control';
  if (/[. ]$/.test(name)) return 'path_name';
  const folded = name.replace(hfsIgnored, '').toLowerCase();
  if (folded === '.git' || /^git~[0-9]+$/.test(folded) || folded.startsWith('.git:'))
    return 'path_dotgit';
  return null;
}

/** Whether a symbolic link at `path` with this target stays inside the checkout. */
export function symlinkEscapes(path: string, target: string): boolean {
  if (target === '' || target.startsWith('/') || /[\x00\\]/.test(target)) return true;
  if (/^[A-Za-z]:/.test(target)) return true;
  let depth = path.split('/').length - 1;
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (--depth < 0) return true;
    } else depth++;
  }
  return false;
}

/** Read a bundle's header without Git. A filtered bundle, or one with two refs, is not a transfer. */
export async function bundleHeader(file: string, multiple = false): Promise<BundleHeader> {
  const rejected = (message: string) => new AdmissionRejected('code_bundle_header', message);
  const handle = await open(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await handle.close();
  }
  const end = text.indexOf('\n\n');
  if (end < 0) throw rejected('The bundle has no complete header');
  const lines = text.slice(0, end).split('\n');
  const signature = lines.shift();
  if (signature !== '# v2 git bundle' && signature !== '# v3 git bundle')
    throw rejected('This is not a Git bundle of a supported version');
  let objectFormat: ObjectFormat = 'sha1';
  const prerequisites: string[] = [];
  const heads: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@')) {
      const format = /^@object-format=(sha1|sha256)$/.exec(line);
      // A filter marks a partial bundle; any other capability is one admission cannot judge.
      if (signature !== '# v3 git bundle' || !format)
        throw rejected('The bundle declares a capability Code does not accept');
      objectFormat = format[1] as ObjectFormat;
      continue;
    }
    const length = objectFormat === 'sha1' ? 40 : 64;
    const prerequisite = line.startsWith('-');
    const value = line.slice(prerequisite ? 1 : 0, (prerequisite ? 1 : 0) + length);
    const rest = line.slice((prerequisite ? 1 : 0) + length);
    if (!/^[0-9a-f]+$/.test(value) || value.length !== length || (rest && !rest.startsWith(' ')))
      throw rejected('The bundle header is malformed');
    if (prerequisite) prerequisites.push(value);
    else if ((!multiple && heads.length) || prerequisites.length > 256 || !rest)
      throw rejected('A transfer delivers exactly one commit');
    else heads.push(value);
  }
  if ((!multiple && heads.length !== 1) || heads.length === 0)
    throw rejected('A transfer delivers exactly one commit');
  if (prerequisites.length > 256) throw rejected('The bundle names too many prerequisites');
  return { objectFormat, prerequisites, head: heads[0], packOffset: end + 2 };
}

interface TreeEntry {
  mode: string;
  name: Buffer;
  oid: string;
}
function parseTree(content: Buffer, format: ObjectFormat): TreeEntry[] | null {
  const width = format === 'sha1' ? 20 : 32;
  const entries: TreeEntry[] = [];
  for (let at = 0; at < content.length;) {
    const space = content.indexOf(0x20, at);
    const zero = content.indexOf(0x00, space);
    if (space < 0 || zero < 0 || zero + 1 + width > content.length) return null;
    entries.push({
      mode: content.toString('latin1', at, space),
      name: content.subarray(space + 1, zero),
      oid: content.toString('hex', zero + 1, zero + 1 + width),
    });
    at = zero + 1 + width;
  }
  return entries;
}

/**
 * Judge one bundle against the project's repository without changing that repository. The
 * pack is indexed into the operation's quarantine, which borrows the kept objects through an
 * alternate this server names; nothing in the upload can name one. Then the whole history the
 * transfer introduces is examined, not the difference of its last commit: a credential added
 * and removed again inside one transfer is still in what would be kept.
 *
 * A transfer that is not what was promised throws AdmissionRejected. One that is, but holds
 * something Code does not keep, returns findings, and nothing of it may be admitted.
 */
export async function admit(input: AdmissionInput): Promise<Admission> {
  const { git, repository, limits } = input;
  const objects = join(input.quarantine, 'objects');
  const header = await bundleHeader(input.bundle);
  if (header.head !== input.head)
    throw new AdmissionRejected(
      'code_bundle_head',
      'The bundle does not deliver the commit this operation was promised',
    );
  const kept = { GIT_DIR: repository };
  const joined = {
    GIT_DIR: repository,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repository, 'objects'),
  };
  const lines = (output: Buffer) => output.toString('latin1').split('\n').filter(Boolean);
  /** `<oid> <type> <size>` for each name, or `<oid> missing`. */
  const describe = async (env: Record<string, string>, names: string[]) =>
    names.length
      ? lines(
          await git.ok(['cat-file', '--batch-check'], {
            env,
            input: names.join('\n') + '\n',
            maxBuffer: 256 * 1024 * 1024,
            timeoutMs: WALK_TIMEOUT_MS,
          }),
        ).map((line) => line.split(' '))
      : [];

  const authorised = input.prerequisites === 'admitted' ? null : new Set(input.prerequisites);
  if (authorised) {
    const unauthorised = header.prerequisites.filter((value) => !authorised.has(value));
    if (unauthorised.length) {
      const reachable =
        input.prerequisiteAncestors && authorised.size
          ? await git.run(['rev-list', '--max-count=1', ...unauthorised, '--not', ...authorised], {
              env: kept,
              timeoutMs: WALK_TIMEOUT_MS,
            })
          : null;
      if (!reachable || reachable.code !== 0 || reachable.stdout.toString('utf8').trim())
        throw new AdmissionRejected(
          'code_bundle_prerequisite',
          'The bundle builds on a commit this operation was not told to build on',
        );
    }
  }
  for (const [value, type] of await describe(
    kept,
    header.prerequisites.map((value) => `${value}^{commit}`),
  ))
    if (type !== 'commit')
      throw new AdmissionRejected(
        'code_bundle_prerequisite',
        `The bundle builds on ${value.slice(0, 12)}, which this project’s repository does not hold`,
      );

  await rm(objects, { recursive: true, force: true });
  await mkdir(join(objects, 'pack'), { recursive: true, mode: 0o700 });
  const indexed = await git.run(
    [
      'index-pack',
      '--stdin',
      '--fix-thin',
      '--strict',
      '--fsck-objects',
      `--max-input-size=${CODE_BUNDLE_MAX_BYTES}`,
    ],
    {
      env: joined,
      input: createReadStream(input.bundle, { start: header.packOffset }),
      timeoutMs: INDEX_TIMEOUT_MS,
    },
  );
  // A volume that filled up while indexing says nothing about the pack.
  if (indexed.code !== 0 && /No space left on device/i.test(indexed.stderr))
    throw new MervError('code_store_full', 'The Code volume is full', 507);
  if (indexed.code !== 0)
    throw new AdmissionRejected(
      'code_bundle_corrupt',
      `Git refused the pack: ${(indexed.stderr.split('\n')[0] ?? '').slice(0, 300)}`,
    );
  input.indexed?.();

  // Q: what the pack put into quarantine, read with no alternate.
  const quarantined = new Map<string, { type: string; size: number }>();
  let partial = '';
  await git.run(['cat-file', '--batch-all-objects', '--batch-check', '--unordered'], {
    env: { GIT_DIR: repository, GIT_OBJECT_DIRECTORY: objects },
    timeoutMs: WALK_TIMEOUT_MS,
    output: (chunk) => {
      const text = partial + chunk.toString('latin1');
      const rows = text.split('\n');
      partial = rows.pop()!;
      // A pack of mostly thin-fix copies is still bounded by twice the limit.
      if (quarantined.size <= limits.objects * 2 + 1)
        for (const row of rows) {
          const [oid, type, size] = row.split(' ');
          quarantined.set(oid, { type, size: Number(size) });
        }
    },
  });
  const findings: CodeFinding[] = [];
  const found = (rule: string, path: string | null, oid: string | null) => {
    if (findings.length < MAX_FINDINGS) findings.push({ rule, path, oid });
  };
  const result = (tree: string, count: number, bytes: number): Admission => ({
    objectFormat: header.objectFormat,
    head: input.head,
    tree,
    objects: count,
    bytes,
    findings,
  });
  if (quarantined.size > limits.objects * 2) {
    found('object_count', null, null);
    return result('', quarantined.size, 0);
  }

  const [[, headType]] = await describe(joined, [input.head]);
  if (headType !== 'commit')
    throw new AdmissionRejected('code_bundle_head', 'The delivered object is not a commit');
  if (input.expectedHead !== null && input.expectedHead !== input.head) {
    const lineage = await git.run(['merge-base', '--is-ancestor', input.expectedHead, input.head], {
      env: joined,
      timeoutMs: WALK_TIMEOUT_MS,
    });
    if (lineage.code !== 0)
      throw new AdmissionRejected(
        'code_bundle_lineage',
        'The delivered commit does not continue the head it was expected to continue',
      );
  }

  // R: what the head reaches that nothing kept reaches. Git fails when any of it is missing.
  const reached = new Set<string>();
  partial = '';
  const walked = await git.run(['rev-list', '--objects', input.head, '--not', '--all'], {
    env: joined,
    timeoutMs: WALK_TIMEOUT_MS,
    output: (chunk) => {
      const rows = (partial + chunk.toString('latin1')).split('\n');
      partial = rows.pop()!;
      for (const row of rows) reached.add(row.slice(0, input.head.length));
    },
  });
  if (walked.code !== 0)
    throw new AdmissionRejected(
      'code_bundle_disconnected',
      'The delivered history is not complete: an object it needs is neither in the bundle nor kept',
    );
  // Everything in the pack is either part of that history or a copy --fix-thin made of a kept
  // object. A pack may not smuggle in anything else, because it would never be examined.
  const beside = [...quarantined.keys()].filter((oid) => !reached.has(oid));
  for (const [oid, type] of await describe(kept, beside))
    if (type === 'missing')
      throw new AdmissionRejected(
        'code_bundle_surplus',
        `The bundle carries ${oid.slice(0, 12)}, which the delivered history does not use`,
      );

  const fresh = [...quarantined].filter(([oid]) => reached.has(oid));
  const bytes = fresh.reduce((sum, [, object]) => sum + object.size, 0);
  let tree = '';
  if (fresh.length > limits.objects) found('object_count', null, null);
  if (bytes > limits.expandedBytes) found('expanded_size', null, null);
  if (findings.length) return result(tree, fresh.length, bytes);

  /** Stream whole objects out of the joined object store, one at a time. */
  const read = async (names: string[], each: (oid: string, content: Buffer) => void) => {
    if (!names.length) return;
    let pending: Buffer = Buffer.alloc(0);
    let current: { oid: string; content: Buffer; filled: number } | null = null;
    let broken = false;
    const consume = (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (!current) {
          const end = pending.indexOf(0x0a);
          if (end < 0) return;
          const [oid, , size] = pending.toString('latin1', 0, end).split(' ');
          pending = pending.subarray(end + 1);
          if (size === undefined) {
            broken = true;
            continue;
          }
          current = { oid, content: Buffer.alloc(Number(size)), filled: 0 };
        }
        const take = Math.min(pending.length, current.content.length - current.filled);
        pending.copy(current.content, current.filled, 0, take);
        current.filled += take;
        pending = pending.subarray(take);
        if (current.filled < current.content.length || !pending.length) return;
        pending = pending.subarray(1);
        each(current.oid, current.content);
        current = null;
      }
    };
    const done = await git.run(['cat-file', '--batch'], {
      env: joined,
      input: names.join('\n') + '\n',
      output: consume,
      timeoutMs: WALK_TIMEOUT_MS,
    });
    if (done.code !== 0 || broken || current)
      throw new MervError('code_git_failed', 'Git could not read the delivered objects', 500);
  };

  for (const [oid, object] of fresh)
    if (object.size > limits.blobBytes)
      found(object.type === 'blob' ? 'blob_size' : 'object_size', null, oid);
  const freshTrees = fresh.filter(([, object]) => object.type === 'tree');
  if (freshTrees.reduce((sum, [, object]) => sum + object.size, 0) > MAX_TREE_BYTES)
    found('tree_size', null, null);
  if (findings.length) return result(tree, fresh.length, bytes);

  const trees = new Map<string, TreeEntry[]>();
  await read(
    freshTrees.map(([oid]) => oid),
    (oid, content) => {
      const entries = parseTree(content, header.objectFormat);
      if (entries) trees.set(oid, entries);
      else found('tree_malformed', null, oid);
    },
  );
  const roots: string[] = [];
  /** Kept trees a fresh tree or commit puts somewhere, with how many directories lie above them. */
  const borrowed: { oid: string; path: string | null; depth: number }[] = [];
  const scan = (content: Buffer, path: string | null, oid: string) => {
    const text = content.toString('latin1');
    if (!anyCredential.test(text)) return;
    for (const [rule, pattern] of credentials) if (pattern.test(text)) found(rule, path, oid);
  };
  await read(
    fresh.filter(([, object]) => object.type === 'commit').map(([oid]) => oid),
    (oid, content) => {
      const root = /^tree ([0-9a-f]+)\n/.exec(content.toString('latin1', 0, 80))?.[1];
      if (oid === input.head) tree = root ?? '';
      if (root && trees.has(root)) roots.push(root);
      else if (root) borrowed.push({ oid: root, path: null, depth: 0 });
      scan(content, null, oid);
    },
  );

  const deny = limits.denyGlobs.map(globPattern);
  const exempt = limits.secretExemptGlobs.map(globPattern);
  /** The first path each fresh blob was found at; null while every path of it is exempt. */
  const blobPaths = new Map<string, string | null>();
  const links: { path: string; oid: string }[] = [];
  const visited = new Set<string>();
  const stack = roots.map((oid) => ({ oid, prefix: '', depth: 1 }));
  for (let node = stack.pop(); node; node = stack.pop()) {
    const key = `${node.oid}:${node.prefix}`;
    if (visited.has(key)) continue;
    if (visited.size >= MAX_TREE_VISITS) {
      found('history_size', null, null);
      break;
    }
    visited.add(key);
    const folded = new Set<string>();
    for (const entry of trees.get(node.oid) ?? []) {
      const path = node.prefix + entry.name.toString('utf8');
      const rule = nameFinding(entry.name);
      if (rule) found(rule, path, node.oid);
      if (node.depth > MAX_DEPTH) found('path_depth', path, node.oid);
      const fold = entry.name.toString('utf8').replace(hfsIgnored, '').normalize('NFC');
      if (folded.has(fold.toLowerCase())) found('path_collision', path, node.oid);
      folded.add(fold.toLowerCase());
      if (deny.some((pattern) => pattern.test(path))) found('deny_glob', path, entry.oid);
      if (entry.mode === '160000') found('gitlink', path, entry.oid);
      else if (entry.mode === '40000') {
        if (!trees.has(entry.oid)) borrowed.push({ oid: entry.oid, path, depth: node.depth });
        else if (node.depth <= MAX_DEPTH)
          stack.push({ oid: entry.oid, prefix: `${path}/`, depth: node.depth + 1 });
      } else if (entry.mode === '120000') links.push({ path, oid: entry.oid });
      else if (entry.mode !== '100644' && entry.mode !== '100755') found('mode', path, entry.oid);
      if (entry.mode !== '40000' && entry.mode !== '160000' && reached.has(entry.oid)) {
        const skipped = exempt.some((pattern) => pattern.test(path));
        if (!blobPaths.has(entry.oid) || (blobPaths.get(entry.oid) === null && !skipped))
          blobPaths.set(entry.oid, skipped ? null : path);
      }
    }
  }

  // A kept tree was examined where it then stood, and a path decides three of these rules. Put
  // higher up, a link inside it that climbed to just below the root now climbs out; put further
  // down, what was shallow enough is too deep; put under a denied directory, what is inside it
  // is denied. So every borrowed tree is read, and what a path decides is judged again.
  const keptTrees = new Map<string, { trees: string[]; links: string[]; inside: TreeEntry[] }>();
  for (let level = [...new Set(borrowed.map((item) => item.oid))]; level.length;) {
    if (keptTrees.size + level.length > MAX_TREE_VISITS) {
      found('history_size', null, null);
      break;
    }
    const below = new Set<string>();
    await read(level, (oid, content) => {
      const entries = parseTree(content, header.objectFormat) ?? [];
      const node = {
        trees: entries.filter((entry) => entry.mode === '40000').map((entry) => entry.oid),
        links: entries.filter((entry) => entry.mode === '120000').map((entry) => entry.oid),
        // Only the deny globs need the names, and a whole repository of them is not small.
        inside: deny.length
          ? entries.map((entry) => ({ ...entry, name: Buffer.from(entry.name) }))
          : [],
      };
      keptTrees.set(oid, node);
      for (const tree of node.trees) below.add(tree);
    });
    level = [...below].filter((oid) => !keptTrees.has(oid));
  }

  // A rename is not a way past a deny glob: what is inside a kept directory is matched at the
  // path it now has. The names above it were judged when the tree that holds them was admitted.
  if (deny.length) {
    const seen = new Set<string>();
    const stack = borrowed.map((item) => ({
      oid: item.oid,
      prefix: item.path === null ? '' : `${item.path}/`,
      depth: item.depth + 1,
    }));
    for (let node = stack.pop(); node; node = stack.pop()) {
      const key = `${node.oid}:${node.prefix}`;
      if (seen.has(key)) continue;
      if (seen.size >= MAX_TREE_VISITS) {
        found('history_size', null, null);
        break;
      }
      seen.add(key);
      for (const entry of keptTrees.get(node.oid)?.inside ?? []) {
        const path = node.prefix + entry.name.toString('utf8');
        if (deny.some((pattern) => pattern.test(path))) found('deny_glob', path, entry.oid);
        if (entry.mode === '40000' && node.depth <= MAX_DEPTH)
          stack.push({ oid: entry.oid, prefix: `${path}/`, depth: node.depth + 1 });
      }
    }
  }

  // A link's target is judged where the link stands, so a kept blob is read again for a new path.
  const targets = new Map<string, number>();
  const linked = new Set(links.map((link) => link.oid));
  for (const node of keptTrees.values()) for (const oid of node.links) linked.add(oid);
  for (const [oid, type, size] of await describe(joined, [...linked]))
    targets.set(oid, type === 'blob' ? Number(size) : -1);
  const linkText = new Map<string, string>();
  await read(
    [...targets].filter(([, size]) => size >= 0 && size <= MAX_SYMLINK_BYTES).map(([oid]) => oid),
    (oid, content) => linkText.set(oid, content.toString('utf8')),
  );
  for (const link of links) {
    const target = linkText.get(link.oid);
    if (target === undefined || symlinkEscapes(link.path, target))
      found('symlink_escape', link.path, link.oid);
  }
  /** How many directories a kept tree needs above it for every link inside it to stay inside. */
  const climbs = new Map<string, number>();
  const climb = (oid: string): number => {
    const known = climbs.get(oid);
    if (known !== undefined) return known;
    const node = keptTrees.get(oid);
    let most = 0;
    for (const link of node?.links ?? []) {
      const target = linkText.get(link);
      let at = 0,
        lowest = 0;
      for (const part of target?.split('/') ?? [])
        if (part === '..') lowest = Math.min(lowest, --at);
        else if (part !== '' && part !== '.') at++;
      most = Math.max(most, target === undefined ? Infinity : -lowest);
    }
    for (const tree of node?.trees ?? []) most = Math.max(most, climb(tree) - 1);
    climbs.set(oid, most);
    return most;
  };
  /** How many directories a kept tree holds below itself, so that where it stands decides depth. */
  const depths = new Map<string, number>();
  const deepest = (oid: string): number => {
    const known = depths.get(oid);
    if (known !== undefined) return known;
    let most = 0;
    for (const tree of keptTrees.get(oid)?.trees ?? []) most = Math.max(most, deepest(tree) + 1);
    depths.set(oid, most);
    return most;
  };
  for (const item of borrowed) {
    if (climb(item.oid) > item.depth) found('symlink_escape', item.path, item.oid);
    if (item.depth + 1 + deepest(item.oid) > MAX_DEPTH) found('path_depth', item.path, item.oid);
  }

  const blobs = fresh.filter(
    ([oid, object]) => object.type === 'blob' && blobPaths.get(oid) !== null,
  );
  await read(
    blobs.map(([oid]) => oid),
    (oid, content) => scan(content, blobPaths.get(oid) ?? null, oid),
  );
  return result(tree, fresh.length, bytes);
}
