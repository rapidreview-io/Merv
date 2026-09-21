import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CodeWorkspaceManifest } from '@merv/contracts';
import type { CodeExport } from '@merv/code/store/operations';
import { diskBytes } from '@merv/code/store/repository';
import { git } from './fixtures/code-store.js';
import { refused, writerFixture } from './fixtures/code-writers.js';

type Fixture = Awaited<ReturnType<typeof writerFixture>>;
const control = (sessionId: string) => ({
  sessionId,
  runnerId: 'runner-1',
  hostRef: `launch-${sessionId}`,
});
const manifest = async (f: Fixture, sessionId: string) =>
  (await f.code.v2!.call(f.admin, 'workspace', control(sessionId))) as CodeWorkspaceManifest;
const download = async (f: Fixture, sessionId: string, haves: string[]) =>
  (
    (await f.code.v2!.call(f.admin, 'downloads', { ...control(sessionId), haves })) as {
      download: CodeExport;
    }
  ).download;
/** Read an export in small parts, as a machine does, and check it against its promise. */
async function read(f: Fixture, sessionId: string, found: Exclude<CodeExport, { upToDate: true }>) {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < found.bytes; offset += 700)
    parts.push(
      await f.code.v2!.readPart!(f.admin, found.exportId, {
        ...control(sessionId),
        offset,
        length: 700,
      }),
    );
  const content = Buffer.concat(parts);
  assert.equal(content.length, found.bytes);
  assert.equal(createHash('sha256').update(content).digest('hex'), found.sha256);
  return content;
}
/** Another machine: an empty repository that holds only what it unbundles. */
function machine(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-machine-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '--quiet', '--bare', 'cache.git']);
  const cache = join(directory, 'cache.git');
  return {
    unbundle(content: Buffer) {
      const file = join(directory, 'download.bundle');
      writeFileSync(file, content);
      git(cache, ['bundle', 'unbundle', file]);
    },
    has: (oid: string) => {
      try {
        git(cache, ['cat-file', '-e', `${oid}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

test('a writer is given exactly the canonical head and a reviewer exactly the referenced commit, on any machine', async (t) => {
  const f = await writerFixture(t, 'sqlite');
  await f.lease('ses_1');
  const started = await manifest(f, 'ses_1');
  assert.deepEqual(
    { ...started, projectRef: undefined },
    {
      projectRef: undefined,
      repositoryId: 'fixture-repository',
      objectFormat: 'sha1',
      unitId: f.unitId,
      generation: 1,
      mode: 'write',
      head: f.root,
      base: f.root,
      branch: `merv/work/${f.unitId}`,
      prerequisites: [],
    },
  );
  await f.event('session.workspace_attached', 'ses_1');
  const first = f.source.commit({ 'a.txt': 'one\n' }, 'first');
  await f.upload('checkpoint', 'ses_1', 1, f.root, f.source.bundle(first, [f.root]));
  const wip = f.source.commit({ 'a.txt': 'wip\n' }, 'merv: capture ses_1');
  await f.event('session.closed', 'ses_1');
  await f.upload('final', 'ses_1', 1, first, f.source.bundle(wip, [first]));
  f.end('ses_1');
  await assert.rejects(manifest(f, 'ses_1'), refused('session_closed'));

  // Review on another machine: the delivered commit, not the trailing work after it.
  f.reviewer('ses_r', first);
  const review = await manifest(f, 'ses_r');
  assert.deepEqual(
    [review.mode, review.head, review.generation, review.branch],
    ['read', first, null, null],
  );
  const reviewer = machine(t);
  const whole = await download(f, 'ses_r', []);
  assert.ok(!('upToDate' in whole));
  assert.deepEqual(whole.prerequisites, []);
  reviewer.unbundle(await read(f, 'ses_r', whole));
  assert.ok(reviewer.has(first) && !reviewer.has(wip));

  // Resume on another machine: generation 2 starts from the head that includes the WIP.
  assert.equal((await f.lease('ses_2')).generation, 2);
  assert.equal((await manifest(f, 'ses_2')).head, wip);
  const other = 'f'.repeat(40);
  const thin = await download(f, 'ses_2', [first, other]);
  assert.ok(!('upToDate' in thin));
  assert.deepEqual(thin.prerequisites, [first], 'a commit this repository lacks is no have');
  assert.ok(thin.bytes < whole.bytes + 1024);
  reviewer.unbundle(await read(f, 'ses_2', thin));
  assert.ok(reviewer.has(wip));
  // Asking again for the same finds the same export; a head that is a have needs nothing.
  assert.equal(((await download(f, 'ses_2', [other, first])) as typeof thin).sha256, thin.sha256);
  assert.deepEqual(await download(f, 'ses_2', [wip]), { upToDate: true, head: wip });

  // Lying haves hurt only the liar: its import fails, the whole bundle works, nothing moved.
  const liar = machine(t);
  const lied = await download(f, 'ses_2', [first]);
  assert.ok(!('upToDate' in lied));
  const content = await read(f, 'ses_2', lied);
  assert.throws(() => liar.unbundle(content));
  const honest = await download(f, 'ses_2', []);
  assert.ok(!('upToDate' in honest));
  liar.unbundle(await read(f, 'ses_2', honest));
  assert.ok(liar.has(wip));
  assert.equal((await f.unit()).canonicalHead, wip);

  // An export belongs to the session it was made for.
  await assert.rejects(
    f.code.v2!.readPart!(f.admin, honest.exportId, { ...control('ses_r'), offset: 0, length: 10 }),
    refused('code_export_not_found'),
  );
  assert.ok(!f.refs().some((ref) => ref.includes(' ') && ref.split(' ')[1] === other));
});

test('a quarantined capture is never part of what a successor is given, and an export expires', async (t) => {
  const f = await writerFixture(t, 'sqlite');
  await f.lease('ses_1');
  await f.event('session.workspace_attached', 'ses_1');
  await f.event('session.closed', 'ses_1');
  const secret = f.source.commit(
    { 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' },
    'merv: capture',
  );
  const final = await f.upload('final', 'ses_1', 1, f.root, f.source.bundle(secret, [f.root]));
  assert.equal(final.error, 'code_capture_quarantined');
  f.end('ses_1');
  await f.code.fenceUnit(await f.human(), { unitId: f.unitId, requestId: 'fence' });
  await f.lease('ses_2');
  assert.equal((await manifest(f, 'ses_2')).head, f.root);
  const found = await download(f, 'ses_2', []);
  assert.ok(!('upToDate' in found));
  const successor = machine(t);
  successor.unbundle(await read(f, 'ses_2', found));
  assert.ok(successor.has(f.root) && !successor.has(secret));
  // A reviewer cannot name the quarantined commit either: the repository does not hold it.
  f.reviewer('ses_r', secret);
  await assert.rejects(manifest(f, 'ses_r'), refused('code_base_pending'));

  // The sweep removes an export that is past its time, with its ref.
  assert.ok(f.refs().some((ref) => ref.startsWith(`refs/merv/exports/${found.exportId} `)));
  const old = new Date(Date.now() - 3600_000);
  const { utimesSync } = await import('node:fs');
  utimesSync(join(f.paths.exports, `${found.exportId}.bundle`), old, old);
  await f.code.maintainStore();
  assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/exports/')));
  await assert.rejects(
    f.code.v2!.readPart!(f.admin, found.exportId, { ...control('ses_2'), offset: 0, length: 10 }),
    refused('code_export_not_found'),
  );
});

test('a download is weighed against the project quota before it takes a byte of the disk', async (t) => {
  const f = await writerFixture(t, 'sqlite');
  await f.lease('ses_1');
  // The bundle is written under the project's directory and counts against its quota, so with
  // only room for what is already kept the download is refused outright, rather than written
  // and leaving every upload of the project refused until the sweep takes the export away.
  await f.open({ config: { quotaBytes: await diskBytes(f.paths.directory) } });
  await assert.rejects(download(f, 'ses_1', []), refused('code_store_full'));
  assert.deepEqual(existsSync(f.paths.exports) ? readdirSync(f.paths.exports) : [], []);
  assert.ok(!f.refs().some((ref) => ref.startsWith('refs/merv/exports/')));

  await f.open({ config: { quotaBytes: 1e9 } });
  const found = await download(f, 'ses_1', []);
  assert.ok(!('upToDate' in found));
  assert.ok(f.refs().some((ref) => ref.startsWith(`refs/merv/exports/${found.exportId} `)));
});
