import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeRepositories } from '@merv/code/store/repository';
import { browse, treePath } from '../packages/code/src/browse.js';

/** A project repository holding one commit: README.md, src/train.py, data/blob.bin. */
async function project(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-browse-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repositories = new CodeRepositories({
    root: join(directory, 'code'),
    quotaBytes: 1 << 30,
    reservedFreeBytes: 1,
  });
  t.after(() => repositories.close(1000));
  await repositories.open();
  await repositories.ensure('p', 'r', 'sha1');
  const env = { ...process.env, ...repositories.environment('p') };
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync('git', args, { env, input }).toString('utf8').trim();
  const blob = (content: string | Buffer) => git(['hash-object', '-w', '--stdin'], content);
  const src = git(['mktree'], `100644 blob ${blob('print("hi")\n')}\ttrain.py\n`);
  const data = git(['mktree'], `100644 blob ${blob(Buffer.from([0, 1, 2, 3]))}\tblob.bin\n`);
  const root = git(
    ['mktree'],
    `100644 blob ${blob('# Laya\n')}\tREADME.md\n040000 tree ${src}\tsrc\n040000 tree ${data}\tdata\n`,
  );
  const commit = git([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit-tree',
    root,
    '-m',
    'one',
  ]);
  return { repositories, commit };
}

test("a commit's code reads as folders and files: folders first, text shown, binary withheld", async (t) => {
  const { repositories, commit } = await project(t);
  const top = await browse(repositories, 'p', commit, '');
  assert.equal(top.kind, 'folder');
  assert.deepEqual(top.kind === 'folder' && top.entries.map((e) => [e.name, e.kind]), [
    ['data', 'folder'],
    ['src', 'folder'],
    ['README.md', 'file'],
  ]);
  const file = await browse(repositories, 'p', commit, '/src/train.py');
  assert.deepEqual(file, {
    kind: 'file',
    commit,
    path: 'src/train.py',
    size: 12,
    text: 'print("hi")\n',
  });
  const bin = await browse(repositories, 'p', commit, 'data/blob.bin');
  assert.equal(bin.kind === 'file' && bin.withheld, 'binary');
  await assert.rejects(browse(repositories, 'p', commit, 'src/missing.py'), /No "src\/missing.py"/);
  await assert.rejects(browse(repositories, 'p', '0'.repeat(40), ''), /does not hold that commit/);
  await assert.rejects(browse(repositories, 'p', 'main', ''), /full object id/);
});

test('a path never steps outside the tree it names', () => {
  assert.equal(treePath('/src/a.py/'), 'src/a.py');
  for (const bad of ['../etc', 'src/../x', 'a//b', 'a\0b'])
    assert.throws(() => treePath(bad), /segment by segment/);
});
