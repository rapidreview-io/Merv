import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { MAC_LEASE_MS, MainThreadService, selectHistory } from '../packages/pi/src/main-thread.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-main-thread-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const clock = { now: Date.parse('2026-11-25T00:00:00Z') };
  const main = await createService(new MainThreadService(state, scope, () => clock.now));
  const asked: string[] = [];
  main.turn = async (_caller, ask) => {
    asked.push(ask.text);
    const request = ask.text.split('Current request:\n').at(-1)!;
    if (/seed/i.test(request)) return /seed 3/.test(ask.text) ? 'You said seed 3.' : 'I do not know.';
    return 'Noted.';
  };
  const made = await scope.credentials.bootstrap({ projectName: 'Seed study', actorName: 'Owner' });
  const owner: Caller = { actorId: made.actor.id, projectId: made.project.id };
  const other: Caller = {
    actorId: (await scope.credentials.issueActor(owner, { name: 'Other', role: 'producer' })).actor.id,
    projectId: owner.projectId,
  };
  return { main, owner, other, clock, asked };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;
const mac = (items: { localId: string; kind: 'person' | 'answer'; text: string }[] = [], after = 0) => ({
  device: 'mac-1',
  engine: 'claude' as const,
  items,
  after,
});

test('a fact told on the Mac is known in the cloud, and a fact told in the cloud comes back to the Mac', async (t) => {
  const f = await fixture(t);
  const first = await f.main.sync(
    f.owner,
    mac([
      { localId: 't:1', kind: 'person', text: 'Use seed 3 for everything.' },
      { localId: 't:2', kind: 'answer', text: 'Seed 3 it is.' },
    ]),
  );
  assert.equal(first.lease, 1);
  assert.deepEqual(first.items, []);
  assert.equal((await f.main.page(f.owner, {})).engine, 'mac');

  // While the Mac holds the thread, the web cannot be answered here.
  await assert.rejects(f.main.say(f.owner, { text: 'What seed did I say?', requestId: 'w1' }), code('desktop_here'));
  assert.equal(f.asked.length, 0);

  // The Mac goes away: its lease runs out, and Merv cloud answers from the thread.
  f.clock.now += MAC_LEASE_MS + 1;
  assert.equal((await f.main.page(f.owner, {})).engine, 'cloud');
  const a = await f.main.say(f.owner, { text: 'What seed did I say?', requestId: 'w1' });
  assert.equal(a.answer.text, 'You said seed 3.');
  assert.equal(a.answer.engine, 'pi');
  assert.match(f.asked[0]!, /> person: Use seed 3 for everything\./);
  // The same message again is the same answer, and no second model call.
  assert.deepEqual(await f.main.say(f.owner, { text: 'What seed did I say?', requestId: 'w1' }), a);
  assert.equal(f.asked.length, 1);
  await assert.rejects(f.main.say(f.owner, { text: 'Another', requestId: 'w1' }), code('request_conflict'));
  await f.main.say(f.owner, { text: 'And batch size 64.', requestId: 'w2' });

  // The Mac returns: one ready line, and exactly what it missed, once.
  const back = await f.main.sync(f.owner, mac());
  assert.equal(back.lease, 3);
  assert.deepEqual(
    back.items.map((item) => [item.kind, item.engine, item.text]),
    [
      ['person', 'pi', 'What seed did I say?'],
      ['answer', 'pi', 'You said seed 3.'],
      ['person', 'pi', 'And batch size 64.'],
      ['answer', 'pi', 'Noted.'],
      ['ready', 'claude', 'Your desktop is ready'],
    ],
  );
  const again = await f.main.sync(f.owner, mac([], back.items.at(-1)!.seq));
  assert.deepEqual(again.items, []);
  assert.equal(again.lease, 3);
  assert.equal((await f.main.page(f.owner, {})).items.filter((item) => item.kind === 'ready').length, 1);
  // A retried Mac batch writes nothing twice.
  await f.main.sync(f.owner, mac([{ localId: 't:1', kind: 'person', text: 'Use seed 3 for everything.' }]));
  assert.equal((await f.main.page(f.owner, {})).items.length, 7);
});

test('each person has their own thread, and workers have none', async (t) => {
  const f = await fixture(t);
  await f.main.sync(f.owner, mac([{ localId: 'a', kind: 'person', text: 'Mine.' }]));
  assert.deepEqual((await f.main.page(f.other, {})).items, []);
  await assert.rejects(
    f.main.page({ ...f.owner, conversation: { id: 'c' } } as Caller, {}),
    code('forbidden'),
  );
});

test('a Mac that returns while an answer is being written waits, and the answer is kept', async (t) => {
  const f = await fixture(t);
  await f.main.sync(f.owner, mac([{ localId: 'a', kind: 'person', text: 'Use seed 3.' }]));
  f.clock.now += MAC_LEASE_MS + 1;
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  f.main.turn = async () => {
    await held;
    return 'Seed 3.';
  };
  const saying = f.main.say(f.owner, { text: 'What seed?', requestId: 'w1' });
  await new Promise((done) => setTimeout(done, 50));
  const returning = f.main.sync(f.owner, mac());
  release();
  assert.equal((await saying).answer.text, 'Seed 3.');
  assert.deepEqual((await returning).items.map((item) => item.kind), ['person', 'answer', 'ready']);
});

test('history keeps whole items, the first and the newest, and names what it left out', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, kind: 'person' as const, text: 'x'.repeat(40) + i }));
  const picked = selectHistory(items, 170);
  assert.deepEqual(picked.omitted, [2, 3, 4]);
  assert.match(picked.text, /Omitted item IDs: 2–4/);
  assert.match(picked.text, /x0\n\n> person: x+4\n\n> person: x+5$/);
});
