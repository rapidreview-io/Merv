/**
 * The queue that keeps a member's text off the page's thread (off-thread.ts), held with a
 * worker the test answers for: how much it remembers, what it does where no worker runs, and
 * how long it waits on a download.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

const { offThread } = await import('../packages/ui/web/off-thread.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A worker the test speaks for: once loaded, as a real one says first, it says back what each
 * job it is sent says, or nothing. It speaks a turn later, as a real one does.
 */
function fakeWorker(t: TestContext, answer: (worker: FakeWorker, message: unknown) => void) {
  const started: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    terminated = false;
    constructor() {
      started.push(this);
      queueMicrotask(() => this.say('loaded'));
    }
    say(data: unknown) {
      if (!this.terminated) this.onmessage?.({ data });
    }
    postMessage(message: unknown) {
      queueMicrotask(() => answer(this, message));
    }
    terminate() {
      this.terminated = true;
    }
  }
  Object.assign(globalThis, { Worker: FakeWorker });
  t.after(() => void delete (globalThis as { Worker?: unknown }).Worker);
  return started;
}
type FakeWorker = {
  say(data: unknown): void;
  onerror?: () => void;
  terminated: boolean;
};

test('what was done is remembered by its size, not only by how many: a streamed block’s every length is not kept', () => {
  const jobs = offThread<string, string>(async (text) => text);
  const big = (letter: string) => letter.repeat(800_000);
  jobs.keep(big('a'), 'a');
  jobs.keep(big('b'), 'b');
  jobs.keep(big('c'), 'c');
  assert.equal(jobs.known(big('a')), undefined, 'the oldest goes once the whole passes its size');
  assert.equal(jobs.known(big('b')), 'b');
  assert.equal(jobs.known(big('c')), 'c');
  // One text larger than the whole is still kept, so whoever waits for it is answered.
  jobs.keep(big('d').repeat(3), 'd');
  assert.equal(jobs.known(big('d').repeat(3)), 'd');
  assert.equal(jobs.known(big('c')), undefined);
});

test('where the worker fails, a job that may only be done off the page stands undone', async (t) => {
  let here = 0;
  const started = fakeWorker(t, (worker) => queueMicrotask(() => worker.onerror?.()));
  const jobs = offThread<string, string>(async (text) => (here++, text), { fallback: false });
  let woken = 0;
  jobs.want('one', 'one', () => woken++);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started.length, 1);
  assert.equal(woken, 1);
  assert.equal(jobs.known('one'), null, 'left plain');
  jobs.want('two', 'two', () => woken++);
  assert.equal(jobs.known('two'), null, 'and so is every job after it');
  assert.equal(here, 0, 'nothing was done on the page’s thread');
});

test('a worker that cannot start leaves such a job undone too', (t) => {
  let here = 0;
  Object.assign(globalThis, {
    Worker: class {
      constructor() {
        throw new Error('blocked');
      }
    },
  });
  t.after(() => void delete (globalThis as { Worker?: unknown }).Worker);
  const jobs = offThread<string, string>(async (text) => (here++, text), { fallback: false });
  jobs.want('one', 'one', () => {});
  assert.equal(jobs.known('one'), null);
  assert.equal(here, 0);
});

test('a download that stalls is waited on generously, then its job stands undone and the next is done', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = fakeWorker(t, (worker, message) => {
    if (message === 'stalls') worker.say('loading');
    else worker.say(`done ${message}`);
  });
  const jobs = offThread<string, string>(async () => 'page', { fallback: false });
  jobs.want('stalls', 'stalls', () => {});
  jobs.want('next', 'next', () => {});
  await flush();
  // The read's own clock does not run while the grammar downloads.
  t.mock.timers.tick(10_000);
  assert.equal(jobs.known('stalls'), undefined);
  t.mock.timers.tick(5_000);
  assert.equal(jobs.known('stalls'), null, 'given up after fifteen seconds');
  assert.equal(started[0]!.terminated, true);
  // A fresh worker takes the next job.
  await flush();
  assert.equal(started.length, 2);
  assert.equal(jobs.known('next'), 'done next');
});
