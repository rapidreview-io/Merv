import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { ServerGit, type GitOptions } from '@merv/code/git';
import { CodeRepositories } from '@merv/code/store/repository';
import { CodeStore, type CodeStoreHooks } from '@merv/code/store/operations';
import { codeStoreFixture, gitSource } from './fixtures/code-store.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A real Git child waits for stdin until its owning client is unloaded. */
class HeldGit extends ServerGit {
  blocked?: string;
  entered = deferred();
  input?: PassThrough;
  override run(args: string[], options: GitOptions = {}) {
    if (this.signal && args.includes(this.blocked ?? '\0')) {
      this.blocked = undefined;
      this.input = new PassThrough();
      const result = super.run(['hash-object', '--stdin'], { ...options, input: this.input });
      this.entered.resolve();
      return result;
    }
    return super.run(args, options);
  }
}
const hooks: CodeStoreHooks = {
  imported: async () => {},
  workspaces: async () => [],
  frozen: async () => [],
  fenced: async () => {},
  advanced: async () => {},
  quarantined: async () => {},
};

test(
  'adapter unload cancels its active exports and admissions, retains shared Git and resumes journals',
  { timeout: 15_000 },
  async (t) => {
    const source = gitSource(t);
    const first = source.commit({ 'notes.md': 'first' });
    const f = await codeStoreFixture(t, {}, first);
    assert.equal((await f.deliver(source.bundle(first))).status, 'completed');
    await f.code.close();
    const git = new HeldGit(join(f.root, 'tmp'));
    const repositories = new CodeRepositories(
      { root: f.root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 },
      git,
    );
    await repositories.open();
    const stores: CodeStore[] = [];
    const open = async () => {
      const store = new CodeStore(
        f.state,
        f.scope,
        { root: f.root, drainSeconds: 0.03, settleMs: 5000 },
        hooks,
        undefined,
        undefined,
        repositories,
      );
      stores.push(store);
      await store.initialize();
      return store;
    };
    const peerInput = new PassThrough();
    try {
      let store = await open();
      let peerFinished = false;
      const peer = git.run(['hash-object', '--stdin'], { input: peerInput }).then((value) => {
        peerFinished = true;
        return value;
      });
      git.blocked = 'cat-file';
      const exporting = assert.rejects(
        store.export(f.admin, { sessionId: 'session-export', head: first, haves: [] }),
        { code: 'code_git_aborted' },
      );
      await git.entered.promise;
      const closing = store.close();
      assert.equal(store.close(), closing, 'concurrent unloads join the same drain');
      await closing;
      await exporting;
      git.input?.destroy();
      assert.equal(peerFinished, false, 'another client’s Git child must remain alive');
      peerInput.end('independent client');
      assert.equal((await peer).code, 0);
      assert.match((await git.ok(['--version'])).toString(), /^git version/);

      store = await open();
      const download = await store.export(f.admin, {
        sessionId: 'session-export',
        head: first,
        haves: [],
      });
      assert.ok('exportId' in download, 'reloaded adapter can export the same repository');
      const next = source.commit({ 'notes.md': 'second' });
      const bundle = source.bundle(next, [first]);
      const begun = await store.importRepository(f.admin, {
        source: 'bundle',
        tip: next,
        bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
        requestId: 'interrupted-admission',
      });
      await store.putPart(f.admin, begun.id, 0, bundle.content);
      git.blocked = 'index-pack';
      git.entered = deferred();
      const admission = assert.rejects(store.complete(f.admin, begun.id), {
        code: 'code_git_aborted',
      });
      await git.entered.promise;
      await store.close();
      await admission;
      git.input?.destroy();
      assert.equal(
        (await f.operationRow(begun.id))?.status,
        'prepared',
        'cancellation leaves admission retryable',
      );
      store = await open();
      assert.equal((await store.complete(f.admin, begun.id)).status, 'completed');
      assert.equal(await store.contains(f.admin.projectId, next), true);
    } finally {
      peerInput.destroy();
      git.input?.destroy();
      for (const store of stores) await store.close();
      await repositories.close(1000);
    }
  },
);

test(
  'cancelled repository waiters neither overtake a live client nor consume transfer capacity',
  { timeout: 5000 },
  async () => {
    const repositories = new CodeRepositories({
      root: '/unused',
      quotaBytes: 1,
      reservedFreeBytes: 0,
    });
    const first = deferred();
    const blocker = repositories.run('project', () => first.promise);
    const cancellation = new AbortController();
    let cancelledRan = false;
    const waiting = assert.rejects(
      repositories.git.scoped(cancellation.signal, () =>
        repositories.run('project', async () => {
          cancelledRan = true;
        }),
      ),
      { code: 'code_git_aborted' },
    );
    cancellation.abort();
    await waiting;
    let successorRan = false;
    const successor = repositories.run('project', async () => {
      successorRan = true;
    });
    await Promise.resolve();
    assert.equal(successorRan, false);
    first.resolve();
    await Promise.all([blocker, successor]);
    assert.equal(cancelledRan, false);

    const held = deferred();
    const transfers = [
      repositories.transfer(() => held.promise),
      repositories.transfer(() => held.promise),
    ];
    const stop = new AbortController();
    const queued = assert.rejects(
      repositories.git.scoped(stop.signal, () =>
        repositories.transfer(async () => {
          cancelledRan = true;
        }),
      ),
      { code: 'code_git_aborted' },
    );
    stop.abort();
    await queued;
    held.resolve();
    await Promise.all(transfers);
    await Promise.all([
      repositories.transfer(async () => {}),
      repositories.transfer(async () => {}),
    ]);
    assert.equal(cancelledRan, false);
    await repositories.close(0);
  },
);
