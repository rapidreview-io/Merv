import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { MervError, type Caller, type State } from '@merv/contracts';
import { personKey } from '@merv/fleet/model-ledger';
import { ProjectScope } from '@merv/scope';
import {
  MAC_LEASE_MS,
  MainThreadService,
  selectHistory,
} from '../packages/sessions/src/main-thread.js';
import { openState } from './fixtures/state.js';

/** `before` runs on the database before the main thread starts on it, as an older server left it. */
async function fixture(t: TestContext, before?: (state: State, owner: Caller) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-main-thread-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const made = await scope.credentials.bootstrap({ projectName: 'Seed study', actorName: 'Owner' });
  const owner: Caller = { actorId: made.actor.id, projectId: made.project.id };
  const other: Caller = {
    actorId: (await scope.credentials.issueActor(owner, { name: 'Other', role: 'producer' })).actor
      .id,
    projectId: owner.projectId,
  };
  await before?.(state, owner);
  const clock = { now: Date.parse('2026-11-25T00:00:00Z') };
  const main = await createService(new MainThreadService(state, scope, () => clock.now));
  const asked: string[] = [];
  main.answerWith(async (_caller, ask) => {
    asked.push(ask.text);
    const request = ask.text.split('Current request:\n').at(-1)!;
    if (/seed/i.test(request))
      return /seed 3/.test(ask.text) ? 'You said seed 3.' : 'I do not know.';
    return 'Noted.';
  });
  return { main, owner, other, clock, asked, state };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof MervError && error.code === expected;
const mac = (
  items: { localId: string; kind: 'person' | 'answer'; text: string; native?: string }[] = [],
  after = 0,
) => ({
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
  assert.match(first.thread, /^mth_/);
  assert.deepEqual(first.items, []);
  assert.equal((await f.main.page(f.owner, {})).engine, 'mac');

  // While the Mac holds the thread, the web cannot be answered here.
  await assert.rejects(
    f.main.say(f.owner, { text: 'What seed did I say?', requestId: 'w1' }),
    code('desktop_here'),
  );
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
  await assert.rejects(
    f.main.say(f.owner, { text: 'Another', requestId: 'w1' }),
    code('request_conflict'),
  );
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
  assert.equal(
    (await f.main.page(f.owner, {})).items.filter((item) => item.kind === 'ready').length,
    1,
  );
  // A retried Mac batch writes nothing twice; an older Mac's cards are accepted and dropped.
  await f.main.sync(f.owner, {
    ...mac([{ localId: 't:1', kind: 'person', text: 'Use seed 3 for everything.' }]),
    cards: [{ id: 'exp-1', body: { title: 'Baseline' } }],
  });
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
  f.main.answerWith(async () => {
    await held;
    return 'Seed 3.';
  });
  const saying = f.main.say(f.owner, { text: 'What seed?', requestId: 'w1' });
  await new Promise((done) => setTimeout(done, 50));
  const returning = f.main.sync(f.owner, mac());
  release();
  assert.equal((await saying).answer.text, 'Seed 3.');
  assert.deepEqual(
    (await returning).items.map((item) => item.kind),
    ['person', 'answer', 'ready'],
  );
});

test('an old lease cannot append: a Mac that held it is refused once the thread moved on', async (t) => {
  const f = await fixture(t);
  const held = await f.main.sync(f.owner, mac([{ localId: 'a', kind: 'person', text: 'One.' }]));
  f.clock.now += MAC_LEASE_MS + 1;
  await f.main.say(f.owner, { text: 'Two.', requestId: 'w1' });
  // The Mac wrote this turn under lease 1; Merv cloud has held the thread since.
  const late = { ...mac([{ localId: 'b', kind: 'answer', text: 'Late.' }]), lease: held.lease };
  await assert.rejects(f.main.sync(f.owner, late), (error) => {
    assert.ok(code('lease_stale')(error));
    assert.deepEqual((error as MervError).details, { lease: 2 });
    return true;
  });
  assert.equal((await f.main.page(f.owner, {})).items.length, 3, 'nothing was appended');
  // It reads what it missed under a new lease, and then its turn goes in.
  const back = await f.main.sync(f.owner, mac());
  assert.equal(back.lease, 3);
  await f.main.sync(f.owner, { ...late, lease: back.lease });
  assert.deepEqual(
    (await f.main.page(f.owner, {})).items.map((item) => item.text),
    ['One.', 'Two.', 'Noted.', 'Your desktop is ready', 'Late.'],
  );
  // Renewing keeps the number: the same Mac is not refused by its own lease.
  const renewed = { ...mac([{ localId: 'c', kind: 'person', text: 'More.' }]), lease: 3 };
  assert.equal((await f.main.sync(f.owner, renewed)).lease, 3);
  // A second Mac takes the thread over, and the first one's lease is old.
  await f.main.sync(f.owner, { ...mac(), device: 'mac-2' });
  const first = { ...mac([{ localId: 'd', kind: 'person', text: 'From mac-1.' }]), lease: 3 };
  await assert.rejects(f.main.sync(f.owner, first), code('lease_stale'));
});

test('a delta is never delivered twice to one native session, and a fact crosses engines', async (t) => {
  const f = await fixture(t);
  const sync = (
    engine: 'claude' | 'codex',
    session: string,
    items: { localId: string; kind: 'person' | 'answer'; text: string }[] = [],
    through?: number,
  ) =>
    f.main.sync(f.owner, {
      ...mac(items),
      engine,
      native: { session, ...(through !== undefined && { through }) },
    });
  const texts = (reply: { items: { text: string }[] }) => reply.items.map((item) => item.text);
  // Claude's own turn is never handed back to it.
  const said = await sync('claude', 'c1', [
    { localId: '1', kind: 'person', text: 'Use seed 3 for everything.' },
    { localId: '2', kind: 'answer', text: 'Seed 3 it is.' },
  ]);
  assert.deepEqual(texts(said), []);
  // Switched to Codex: its new native session is given what Claude said, once.
  const codex = await sync('codex', 'x1');
  assert.deepEqual(texts(codex), ['Use seed 3 for everything.', 'Seed 3 it is.']);
  assert.equal(codex.through, 2);
  assert.deepEqual(texts(await sync('codex', 'x1')), []);
  assert.deepEqual(texts(await sync('codex', 'x1', [], 0)), [], 'a receipt never goes back');
  await sync('codex', 'x1', [{ localId: '3', kind: 'answer', text: 'Fixed the loader.' }]);
  // Back on Claude, which resumes its own session: only what it missed.
  assert.deepEqual(texts(await sync('claude', 'c1')), ['Fixed the loader.']);
  // Merv cloud answers while the Mac is away; the returning session gets that and the ready line.
  f.clock.now += MAC_LEASE_MS + 1;
  await f.main.say(f.owner, { text: 'And batch size 64.', requestId: 'w1' });
  assert.deepEqual(texts(await sync('claude', 'c1')), [
    'And batch size 64.',
    'Noted.',
    'Your desktop is ready',
  ]);
  assert.deepEqual(texts(await sync('claude', 'c1')), []);
  // A fresh native session pages through the whole thread, each item exactly once.
  for (let round = 0; round < 2; round++)
    await sync(
      'codex',
      'x1',
      Array.from({ length: 6 }, (_, i) => ({
        localId: `n${round}.${i}`,
        kind: 'answer' as const,
        text: `n${round}.${i}`,
      })),
    );
  const seen: number[] = [];
  for (let more = true; more;) {
    const page = await sync('claude', 'c2');
    seen.push(...page.items.map((item) => item.seq));
    more = page.more;
  }
  const all = (await f.main.page(f.owner, {})).items.map((item) => item.seq);
  assert.equal(all.length, 18);
  assert.deepEqual(seen, all);
  assert.deepEqual(texts(await sync('claude', 'c2')), []);
});

test('a heartbeat tags its own items without a delivery; a page reads after a seq without the lease; a delivery may be larger', async (t) => {
  const f = await fixture(t);
  const texts = (reply: { items: { text: string }[] }) => reply.items.map((item) => item.text);
  await f.main.sync(f.owner, mac([{ localId: '1', kind: 'person', text: 'Use seed 3.' }]));
  f.clock.now += MAC_LEASE_MS + 1;
  await f.main.say(f.owner, { text: 'And batch size 64.', requestId: 'w1' });
  // The heartbeat sends a turn native session c1 wrote, with no delivery: nothing is marked given.
  const beat = await f.main.sync(f.owner, {
    ...mac([{ localId: '2', kind: 'answer', text: 'Both noted.', native: 'c1' }], 0),
  });
  assert.deepEqual(texts(beat), ['And batch size 64.', 'Noted.', 'Your desktop is ready']);
  // Delivered later, c1 gets everything but its own turn; codex's session gets that too.
  const delta = await f.main.sync(f.owner, { ...mac(), native: { session: 'c1' } });
  assert.deepEqual(texts(delta), [
    'Use seed 3.',
    'And batch size 64.',
    'Noted.',
    'Your desktop is ready',
  ]);
  const codex = await f.main.sync(f.owner, {
    ...mac(),
    engine: 'codex',
    native: { session: 'x1' },
  });
  assert.ok(texts(codex).includes('Both noted.'));

  // What was written after a cursor, read without taking the thread back.
  f.clock.now += MAC_LEASE_MS + 1;
  await f.main.say(f.owner, { text: 'Did the sweep finish?', requestId: 'w2' });
  const page = await f.main.page(f.owner, { after: 5, limit: 2 });
  assert.deepEqual(
    page.items.map((item) => [item.seq, item.text]),
    [
      [6, 'Did the sweep finish?'],
      [7, 'Noted.'],
    ],
  );
  assert.equal(page.more, false);
  assert.equal((await f.main.page(f.owner, {})).engine, 'cloud', 'the read took nothing');
  await f.main.say(f.owner, { text: 'Still here?', requestId: 'w3' });

  // A fresh native session asks for a larger page; 1 MiB of words caps it, always one item.
  const big = 'x'.repeat(200_000);
  for (let round = 0; round < 3; round++)
    await f.main.sync(f.owner, {
      ...mac(
        [0, 1].map((i) => ({ localId: `big${round}.${i}`, kind: 'answer' as const, text: big })),
      ),
    });
  const all = (await f.main.page(f.owner, {})).items.length;
  const first = await f.main.sync(f.owner, { ...mac(), native: { session: 'c2' }, limit: 200 });
  assert.equal(first.items.length, 10 + 5, 'every small item, then five of the six large ones');
  assert.equal(first.more, true);
  const rest = await f.main.sync(f.owner, { ...mac(), native: { session: 'c2' }, limit: 200 });
  assert.deepEqual([rest.items.length, rest.more], [all - 15, false]);
});

test('the Pi plugin’s threads move over with their numbers, leases and who they belong to', async (t) => {
  let person = '';
  const f = await fixture(t, async (state, owner) => {
    // pi-main-thread@1 as the previous server ran it, and rows it wrote.
    await state.migrate('pi-main-thread', [{ version: 1, sql: PI_MAIN_THREAD_V1 }]);
    person = personKey(null, owner);
    await state.transaction(async (tx) => {
      for (const [seq, engine, kind, words] of [
        [1, 'claude', 'person', 'Use seed 3 for everything.'],
        [2, 'pi', 'answer', 'Seed 3, noted.'],
      ] as const)
        await tx.run(
          'INSERT INTO pi_main_items VALUES (?,?,?,?,?,?,?,NULL,?,?)',
          owner.projectId,
          person,
          seq,
          `local:${seq}`,
          engine,
          kind,
          words,
          2,
          `2026-11-24T00:00:0${seq}.000Z`,
        );
      await tx.run(
        'INSERT INTO pi_main_leases VALUES (?,?,?,?,?,?)',
        owner.projectId,
        person,
        'pi',
        'cloud',
        2,
        0,
      );
      await tx.run(
        "INSERT INTO pi_main_cards VALUES (?,?,'exp-1','{}','2026-11-24','2026-11-24')",
        owner.projectId,
        person,
      );
    });
  });
  assert.deepEqual(
    (await f.main.page(f.owner, {})).items.map((item) => [item.seq, item.engine, item.text]),
    [
      [1, 'claude', 'Use seed 3 for everything.'],
      [2, 'pi', 'Seed 3, noted.'],
    ],
  );
  // The lease's number only goes up from where it stood; the Mac then hears what Pi said.
  const back = await f.main.sync(f.owner, mac([], 1));
  assert.equal(back.lease, 3);
  assert.deepEqual(
    back.items.map((item) => item.text),
    ['Seed 3, noted.', 'Your desktop is ready'],
  );
  assert.deepEqual((await f.main.page(f.other, {})).items, []);
  // Step A leaves the Pi plugin's tables, so the previous server still starts on this database.
  const left = await f.state.transaction((tx) =>
    tx.get<{ n: string }>('SELECT count(*) AS n FROM pi_main_items WHERE person=?', person),
  );
  assert.equal(Number(left!.n), 2);
});

test('history keeps whole items, the first and the newest, and names what it left out', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    seq: i + 1,
    kind: 'person' as const,
    text: 'x'.repeat(40) + i,
  }));
  const picked = selectHistory(items, 170);
  assert.deepEqual(picked.omitted, [2, 3, 4]);
  assert.match(picked.text, /Omitted item IDs: 2–4/);
  assert.match(picked.text, /x0\n\n> person: x+4\n\n> person: x+5$/);
});

/** The Pi plugin's migration, published in production, as it was. */
const PI_MAIN_THREAD_V1 = `
CREATE TABLE pi_main_items (
  project_id TEXT NOT NULL, person TEXT NOT NULL, seq BIGINT NOT NULL,
  local_id TEXT NOT NULL, engine TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person','answer','ready')),
  words TEXT NOT NULL, request_id TEXT, lease BIGINT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, person, seq), UNIQUE (project_id, person, local_id)
);
CREATE TABLE pi_main_leases (
  project_id TEXT NOT NULL, person TEXT NOT NULL,
  holder TEXT NOT NULL CHECK (holder IN ('mac','pi')), device TEXT NOT NULL,
  number BIGINT NOT NULL, expires_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, person)
);
CREATE TABLE pi_main_cards (
  project_id TEXT NOT NULL, person TEXT NOT NULL, id TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, person, id)
);`;
