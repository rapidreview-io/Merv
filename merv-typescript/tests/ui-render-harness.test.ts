/**
 * The render harness itself: a view a test forgets to wait for unmounting must still go, and
 * must not take the next view with it. A view left mounted keeps polling, and its timer keeps
 * the test file's process alive after its last test: a CI shard once hung that way for twenty
 * minutes after tests/ui-threads.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, requests, serve, settle, unmount } from './ui-render.js';

const { createElement, useEffect } = await import('react');

/** What each poll was answered, by path. */
const answered: string[] = [];
/** Asks its fixture every 20 ms while it is mounted, as a polled view does. */
function Polling({ path }: { path: string }) {
  useEffect(() => {
    const timer = setInterval(
      () => void fetch(path).then((response) => answered.push(`${path} ${response.status}`)),
      20,
    );
    return () => clearInterval(timer);
  }, [path]);
  return createElement('p', null, path);
}

test('an unmount nobody waited for still unmounts, and leaves the next view mounted', async (t) => {
  t.after(unmount);
  serve('/first', { body: {} });
  await mount(createElement(Polling, { path: '/first' }));
  // Not awaited, as a test once did, before the next view mounts.
  void unmount();
  serve('/second', { body: {} });
  await mount(createElement(Polling, { path: '/second' }));
  await settle(60);
  assert.equal(document.body.textContent, '/second');
  assert.ok(answered.includes('/second 200'), 'the next view kept its fixtures');
  assert.ok(!answered.includes('/second 404'), 'the next view kept its fixtures');
  await unmount();
  // Nothing is left mounted, so nothing polls once the file's tests are done.
  assert.equal(document.body.textContent, '');
  const after = requests.length;
  await settle(60);
  assert.equal(requests.length, after);
});
