import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createService, type Caller, type MervError } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { hostMigration, migration } from '../packages/pi/src/schema.js';
import type { PiCommand, PiHostRecord } from '../packages/pi/src/types.js';
import { openState, postgresUrl } from './fixtures/state.js';
import { code, fixture, offers, type PiFixture } from './fixtures/pi.js';
import { piModelToolName } from '../packages/pi/src/tool-names.js';

const login = (f: PiFixture, subject: string) =>
  f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
const reader = async (f: PiFixture): Promise<Caller> => {
  const issued = await f.scope.issueActor(f.operator, { name: 'Reader', role: 'reader' });
  return {
    projectId: f.operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
};
/** Fleet records what it saw of an allocation: released, with the given facts. */
const released = async (f: PiFixture, id: string, change: object = {}) => {
  const allocation = await f.allocation(id);
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE fleet_allocations SET phase='released',data_json=? WHERE id=?",
      JSON.stringify({ ...allocation, phase: 'released', intent: 'stop', ...change }),
      id,
    ),
  );
};
const command = async (f: PiFixture, { conversationId, id }: PiCommand) =>
  f.state.read(async (sql) => {
    const row = await sql.get<{ data_json: string }>(
      'SELECT data_json FROM pi_commands WHERE conversation_id=? AND id=?',
      conversationId,
      id,
    );
    return JSON.parse(row!.data_json) as PiCommand;
  });
/** The next slot's machine launches, its worker enrolls and echoes the probe: the cut-over. */
async function cutOver(f: PiFixture, host: PiHostRecord, workerId = 'worker_next') {
  await f.fleet.tick();
  await f.fleet.tick();
  const token = await f.token(host.next!.allocationId);
  const enrolled = await f.pi.next(token, { workerId });
  assert.deepEqual(Object.keys(enrolled).sort(), ['probe', 'work']);
  const { probe } = enrolled;
  return { token, probe, reply: await f.pi.next(token, { workerId, probe }) };
}

test('one machine per person per project: their conversations share it, another project has its own, and Fleet rows live only in the host project', async (t) => {
  const f = await fixture(t);
  const alice = await login(f, 'alice');
  const one = await f.scope.createProject(alice, { name: 'One', requestId: 'one' });
  const two = await f.scope.createProject(alice, { name: 'Two', requestId: 'two' });
  const inOne = await f.scope.caller(alice, one.id);
  const inTwo = await f.scope.caller(alice, two.id);
  const first = await f.create(inOne);
  const [a, b, c] = [
    await f.send(first, 'a', inOne),
    await f.send(await f.create(inOne), 'b', inOne),
    await f.send(await f.create(inTwo), 'c', inTwo),
  ];
  assert.deepEqual([b.hostId, b.runtimeId], [a.hostId, a.runtimeId]);
  assert.notEqual(c.hostId, a.hostId);
  assert.notEqual(c.runtimeId, a.runtimeId);
  assert.deepEqual(await f.fleet.list(inOne), []);
  assert.deepEqual(await f.fleet.list(inTwo), []);
  const rented = await f.fleet.list(f.hostCaller);
  assert.deepEqual(
    rented.map(({ projectId, owner }) => [projectId, owner.kind]),
    [
      [f.hostCaller.projectId, 'pi-host'],
      [f.hostCaller.projectId, 'pi-host'],
    ],
  );
});

test('keyed per person, two projects’ turns run at once on one machine, and losing one project fails only its turn', async (t) => {
  const f = await fixture(t, { pi: { runtimeKey: 'person' } });
  const alice = await login(f, 'alice');
  const bob = await login(f, 'bob');
  const one = await f.scope.createProject(alice, { name: 'One', requestId: 'one' });
  const two = await f.scope.createProject(alice, { name: 'Two', requestId: 'two' });
  for (const project of [one, two])
    await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'reader' });
  const inOne = await f.scope.caller(bob, one.id);
  const inTwo = await f.scope.caller(bob, two.id);
  const chatOne = await f.create(inOne);
  const a = await f.send(chatOne, 'a', inOne);
  const b = await f.send(await f.create(inTwo), 'b', inTwo);
  assert.deepEqual([b.hostId, b.runtimeId], [a.hostId, a.runtimeId]);
  const token = await f.token(a.runtimeId);
  await f.fleet.tick();
  await f.fleet.tick();
  const turns: { conversationId: string; commandId: string; workerId: string }[] = [];
  for (const sent of [a, b]) {
    const { work } = await f.pi.next(token, { workerId: 'worker_1' });
    assert.equal(work?.command.id, sent.id);
    const input = { conversationId: sent.conversationId, commandId: sent.id, workerId: 'worker_1' };
    await f.pi.begin(token, input);
    turns.push(input);
  }
  await f.scope.removeMember(alice, one.id, 'bob');
  const read = (input: (typeof turns)[number]) =>
    f.pi.tool(token, { ...input, name: 'project.get', input: {} });
  await assert.rejects(read(turns[0]), code('pi_authority_stale'));
  assert.equal(((await read(turns[1])) as { id: string }).id, two.id);
  await f.fleet.tick();
  assert.equal((await f.allocation(a.runtimeId)).intent, 'run');
  assert.deepEqual(await f.fleet.list(inTwo), []);
});

test('each change of the machine reaches every open page that shares it, and only those', async (t) => {
  const f = await fixture(t);
  const alice = await login(f, 'alice');
  const one = await f.scope.createProject(alice, { name: 'One', requestId: 'one' });
  const two = await f.scope.createProject(alice, { name: 'Two', requestId: 'two' });
  const inOne = await f.scope.caller(alice, one.id);
  const [a, b] = [await f.create(inOne), await f.create(inOne)];
  const elsewhere = await f.create(await f.scope.caller(alice, two.id));
  const heard = new Set<string>();
  for (const { id } of [b, elsewhere]) f.pi.streams.subscribe(id, () => heard.add(id));
  // An answer streaming in b keeps its text through the machine's changes.
  f.pi.streams.publish(b.id, { commandId: 'turn', type: 'text', text: 'Half an answer' });
  for (const change of [
    () => f.pi.warm(inOne, { requestId: 'warm', conversationId: a.id }),
    () => f.pi.setMachine(inOne, { machine: 'large' }),
    () => f.pi.stopMachine(inOne),
  ]) {
    heard.clear();
    await change();
    assert.deepEqual([...heard], [b.id]);
  }
  assert.equal(f.pi.streams.snapshot(b.id).tail[0]?.text, 'Half an answer');
  // The popover's idle wait is the configured one.
  assert.equal((await f.pi.snapshot(inOne, b.id)).host.idleSeconds, 5);
});

test('a machine runs as many turns at once as its slots; the next one waits for a free slot', async (t) => {
  const f = await fixture(t);
  const sent = [];
  for (let index = 0; index < 4; index++) sent.push(await f.send(await f.create()));
  const token = await f.token(sent[0].runtimeId);
  await f.fleet.tick();
  await f.fleet.tick();
  const claims = [];
  // A worker begins each turn before it asks again.
  for (let index = 0; index < 3; index++) {
    const { work } = await f.pi.next(token, { workerId: 'worker_1' });
    const { conversationId, id: commandId } = work!.command;
    claims.push({ conversationId, commandId, workerId: 'worker_1' });
    await f.pi.begin(token, claims[index]);
  }
  assert.deepEqual(
    claims.map(({ commandId }) => commandId),
    sent.slice(0, 3).map(({ id }) => id),
  );
  assert.equal((await f.pi.next(token, { workerId: 'worker_1' })).work, null);
  await f.pi.complete(token, f.completion(claims[0]));
  assert.equal((await f.pi.next(token, { workerId: 'worker_1' })).work?.command.id, sent[3].id);
});

test('a turn that cannot start ends alone: /next never fails the machine, and serves the next turn', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  const running = await f.claimed(await f.send(chat));
  await f.pi.begin(running.token, running.input);
  // The same person sends with a key of their own, then revokes it while that turn waits.
  const issued = await f.scope.issueActorCredential(f.operator, { actorId: f.operator.actorId });
  const key = { ...f.operator, credentialId: issued.credential.id };
  const revoked = await f.send(await f.create(key), 'hello', key);
  const served = await f.send(await f.create());
  assert.equal(revoked.hostId, served.hostId);
  await f.scope.revokeCredential(f.operator, issued.credential.id);
  const next = () => f.pi.next(running.token, { workerId: 'worker_1' });
  assert.equal((await next()).work?.command.id, served.id);
  await f.pi.begin(running.token, {
    ...running.input,
    conversationId: served.conversationId,
    commandId: served.id,
  });
  const ended = await command(f, revoked);
  assert.deepEqual([ended.status, ended.error], ['interrupted', 'worker_interrupted']);
  // Stopped between its claim and its work, or with its checkpoint unreadable: only it ends.
  await f.pi.complete(running.token, f.completion(running.input));
  const get = f.blobs.get;
  f.blobs.get = async (...read) => {
    f.blobs.get = get;
    await f.pi.stop(f.operator, chat.id);
    return get(...read);
  };
  const stopped = await f.send(chat);
  assert.deepEqual(await next(), { work: null });
  assert.equal((await command(f, stopped)).error, 'cancelled');
  f.blobs.get = async () => {
    f.blobs.get = get;
    throw new Error('blob store unavailable');
  };
  const unread = await f.send(chat);
  assert.deepEqual(await next(), { work: null });
  assert.equal((await command(f, unread)).error, 'worker_interrupted');
  const again = await f.send(chat);
  assert.equal((await next()).work?.command.id, again.id);
});

test('the idle clock starts when the last turn in any of the machine’s conversations ends', async (t) => {
  const f = await fixture(t);
  const a = await f.claimed(await f.send(await f.create()));
  const sent = await f.send(await f.create());
  await f.pi.next(a.token, { workerId: 'worker_2' });
  const b = { conversationId: sent.conversationId, commandId: sent.id, workerId: 'worker_2' };
  await f.finish(a);
  assert.equal((await f.host(sent)).idleSince, null);
  f.advance(10_000);
  await f.fleet.tick();
  assert.equal((await f.allocation(sent.runtimeId)).intent, 'run');
  await f.pi.begin(a.token, b);
  await f.pi.complete(a.token, f.completion(b));
  assert.ok((await f.host(sent)).idleSince);
  f.advance(5_000);
  await f.fleet.tick();
  assert.equal((await f.allocation(sent.runtimeId)).intent, 'stop');
});

test('a move starts the new machine first: its worker proves ready, new turns cut over, and a turn under way finishes on the old one', async (t) => {
  const f = await fixture(t);
  const requested: unknown[] = [];
  const request = f.fleet.request.bind(f.fleet);
  f.fleet.request = (caller, input, tx) => (requested.push(input), request(caller, input, tx));
  const first = await f.create();
  const second = await f.create();
  const a = await f.claimed(await f.send(first));
  await f.pi.begin(a.token, a.input);
  const view = await f.pi.setMachine(f.operator, { machine: 'large' });
  assert.deepEqual(
    [view.machine?.key, view.moving?.to, view.moving?.by],
    ['standard', 'large', 'person'],
  );
  assert.equal((requested.at(-1) as { profile: string }).profile, 'large');
  assert.equal((await f.pi.snapshot(f.operator, second.id)).stage.name, 'moving');
  // New turns keep going to the current machine until the new one proves ready.
  const b = await f.send(second);
  assert.equal(b.runtimeId, a.work.command.runtimeId);
  const { next } = await f.host(b);
  await f.fleet.tick();
  await f.fleet.tick();
  const token = await f.token(next!.allocationId);
  const enrolled = await f.pi.next(token, { workerId: 'worker_large' });
  assert.equal(enrolled.work, null);
  assert.ok(enrolled.probe);
  // Enrolled, the machine is running: Fleet acknowledges its launch.
  await f.fleet.tick();
  assert.equal((await f.allocation(next!.allocationId)).phase, 'running');
  // Another worker, or a wrong probe, proves nothing.
  await assert.rejects(
    f.pi.next(token, { workerId: 'other', probe: enrolled.probe }),
    code('pi_worker_conflict'),
  );
  assert.deepEqual(await f.pi.next(token, { workerId: 'worker_large', probe: 'x'.repeat(43) }), {
    work: null,
    probe: enrolled.probe,
  });
  const moved = await f.pi.next(token, { workerId: 'worker_large', probe: enrolled.probe });
  assert.equal(moved.work?.command.id, b.id);
  assert.deepEqual(
    [moved.work?.command.runtimeId, moved.work?.command.epoch, moved.work?.command.machine],
    [next!.allocationId, next!.epoch, 'large'],
  );
  let host = await f.host(b);
  assert.deepEqual(
    [host.current?.allocationId, host.draining?.allocationId, host.next],
    [next!.allocationId, a.work.command.runtimeId, null],
  );
  // The old machine takes no more work and finishes the turn it began, then stops.
  assert.deepEqual(await f.pi.next(a.token, { workerId: 'worker_1' }), {
    work: null,
    retire: true,
  });
  assert.deepEqual(await f.pi.complete(a.token, f.completion(a.input)), { saved: true });
  await f.fleet.tick();
  assert.equal((await f.allocation(a.work.command.runtimeId)).intent, 'stop');
  await f.pi.tick();
  host = await f.host(b);
  assert.equal(host.draining, null);
  const { host: after } = await f.pi.snapshot(f.operator, first.id);
  assert.deepEqual(
    [after.machine?.key, after.state, after.lastMove?.outcome, after.lastMove?.by],
    ['large', 'ready', 'moved', 'person'],
  );
});

test('turns finishing on the old machine take none of the new machine’s slots', async (t) => {
  const f = await fixture(t);
  const a = await f.claimed(await f.send(await f.create()));
  // Each claim goes to a worker of its own: none begins its turn here.
  for (let index = 2; index < 4; index++) {
    await f.send(await f.create());
    assert.ok((await f.pi.next(a.token, { workerId: `worker_${index}` })).work);
  }
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const waiting = [];
  for (let index = 0; index < 4; index++) waiting.push((await f.send(await f.create())).id);
  const { token, reply } = await cutOver(f, await f.host(a.work.command));
  const claimed = [reply.work?.command.id];
  for (let index = 0; index < 3; index++)
    claimed.push((await f.pi.next(token, { workerId: `worker_next_${index}` })).work?.command.id);
  // Turns sent in the same instant are taken in id order.
  assert.deepEqual(claimed.sort(), waiting.sort());
  assert.equal((await f.host(a.work.command)).draining?.allocationId, a.work.command.runtimeId);
});

test('a worker that lost the reply to its claim is given the same turn again: as claimed, at cut-over, and before its machine retires', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const a = await f.claimed(await f.send(await f.create()));
  const next = (workerId = 'worker_1', token = a.token, probe?: string) =>
    f.pi.next(token, probe ? { workerId, probe } : { workerId });
  assert.deepEqual(await next(), { work: a.work });
  assert.deepEqual(await next('worker_2'), { work: null });
  await f.pi.begin(a.token, a.input);
  assert.deepEqual(await next(), { work: null });
  // A claim whose reply is lost while the machine moves, and the cut-over's own reply lost too.
  const b = await f.send(await f.create());
  assert.equal((await next()).work?.command.id, b.id);
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const c = await f.send(await f.create());
  const { token, probe, reply } = await cutOver(f, await f.host(c));
  assert.equal(reply.work?.command.id, c.id);
  assert.deepEqual(await next('worker_next', token, probe), reply);
  // On the draining machine, the turn is told the machine it runs on.
  const again = await next();
  assert.deepEqual(
    [again.work?.command.id, again.work?.notes.filter((note) => /^(Model|Machine):/.test(note))],
    [
      b.id,
      [
        'Model: you are GPT-6 Luna (gpt-6-luna). Earlier answers in this conversation may come from other models the person picked; if asked which model you are, say GPT-6 Luna.',
        'Machine: Standard (½ vCPU, 4 GiB, 8 GB disk).',
      ],
    ],
  );
  await f.pi.begin(a.token, { ...a.input, conversationId: b.conversationId, commandId: b.id });
  assert.deepEqual(await next(), { work: null, retire: true });
});

test('a new machine that never proves ready fails the move, and the current one serves on', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const conversation = await f.create();
  const bound = await f.claimed(await f.send(conversation));
  await f.finish(bound);
  const lastMove = async () => (await f.pi.snapshot(f.operator, conversation.id)).host;
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const late = (await f.host(bound.work.command)).next!;
  await f.fleet.tick();
  await f.fleet.tick();
  const token = await f.token(late.allocationId);
  const { probe } = await f.pi.next(token, { workerId: 'worker_late' });
  // A probe echoed after its time proves nothing.
  f.advance(180_000);
  await assert.rejects(
    f.pi.next(token, { workerId: 'worker_late', probe }),
    code('pi_runtime_stale'),
  );
  assert.equal((await f.host(bound.work.command)).current?.machine, 'standard');
  await f.fleet.tick();
  await f.pi.tick();
  assert.equal((await f.allocation(late.allocationId)).intent, 'stop');
  let view = await lastMove();
  assert.deepEqual(
    [view.machine?.key, view.moving, view.lastMove?.outcome, view.lastMove?.reason],
    ['standard', null, 'failed', 'not ready in time'],
  );
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const refused = (await f.host(bound.work.command)).next!;
  await released(f, refused.allocationId, { error: 'runtime_refused' });
  await f.pi.tick();
  view = await lastMove();
  assert.deepEqual([view.moving, view.lastMove?.reason], [null, 'no free machine']);
  // A move holds two machines, so without room for a third it does not start.
  f.fleet.free = async () => 2;
  view = await f.pi.setMachine(f.operator, { machine: 'large' });
  assert.deepEqual([view.moving, view.lastMove?.reason], [null, 'no free machine']);
  assert.equal((await f.send(conversation)).runtimeId, bound.work.command.runtimeId);
});

test('when the current machine is lost during a move, a turn that wrote ends and the rest follow the new one', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const a = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(a.token, a.input);
  await f.pi.progress(a.token, { ...a.input, events: [{ type: 'text', text: 'Partly' }] });
  const quiet = await f.send(await f.create());
  const { work } = await f.pi.next(a.token, { workerId: 'worker_1' });
  await f.pi.begin(a.token, {
    ...a.input,
    conversationId: quiet.conversationId,
    commandId: work!.command.id,
  });
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const b = await f.send(await f.create());
  const { next } = await f.host(b);
  const failed = { sandboxId: 'sbx_1', state: 'failed', ready: false, launch: null };
  await released(f, a.work.command.runtimeId, { runtime: failed });
  await f.pi.tick();
  const ended = await command(f, a.work.command);
  assert.deepEqual([ended.status, ended.error], ['interrupted', 'runtime_lost']);
  for (const turn of [quiet, b]) {
    const followed = await command(f, turn);
    assert.deepEqual(
      [followed.status, followed.runtimeId, followed.machine],
      ['waiting', next!.allocationId, 'large'],
    );
  }
  const host = await f.host(b);
  assert.deepEqual([host.current?.allocationId, host.next], [next!.allocationId, null]);
});

test('a turn whose machine a rollout takes before it shows anything waits for a fresh one, across the restart too, once', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const sent = await f.send(await f.create());
  const placed = async (from: string) => {
    const turn = await command(f, sent);
    assert.deepEqual([turn.status, turn.error], ['waiting', null]);
    assert.notEqual(turn.runtimeId, from);
    assert.equal((await f.host(sent)).current?.allocationId, turn.runtimeId);
    return turn;
  };
  // The rollout deletes the machine; Fleet saw it go while the turn was still Pi's to run.
  await released(f, sent.runtimeId, { intent: 'run' });
  await f.pi.tick();
  const second = await placed(sent.runtimeId);
  // Main is recreated at the switch: the turn waits through it for another fresh machine.
  await f.restart();
  const third = await placed(second.runtimeId);
  assert.equal((await f.allocation(second.runtimeId)).intent, 'stop');
  const bound = await f.claimed(third);
  await f.pi.begin(bound.token, bound.input);
  await released(f, third.runtimeId, { intent: 'run' });
  await f.pi.tick();
  const ended = await command(f, sent);
  assert.deepEqual([ended.status, ended.error], ['interrupted', 'runtime_lost']);
});

test('a lost machine’s turn that began starts again elsewhere; one that wrote or called a tool ends', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const sent = [];
  for (let index = 0; index < 3; index++) sent.push(await f.send(await f.create()));
  const token = await f.token(sent[0].runtimeId);
  await f.fleet.tick();
  await f.fleet.tick();
  const [quiet, wrote, called] = sent.map(({ conversationId, id }) => ({
    conversationId,
    commandId: id,
    workerId: 'worker_1',
  }));
  const { work } = await f.pi.next(token, { workerId: 'worker_1' });
  for (const turn of [quiet, wrote, called]) {
    if (turn !== quiet) await f.pi.next(token, { workerId: 'worker_1' });
    await f.pi.begin(token, turn);
  }
  const grant = await f.pi.authorizeModel(work!.modelToken);
  await f.pi.progress(token, { ...wrote, events: [{ type: 'text', text: 'Partly' }] });
  await f.pi.tool(token, { ...called, name: 'project.get', input: {} });
  await released(f, sent[0].runtimeId, { intent: 'run' });
  await f.pi.tick();
  for (const turn of [sent[1], sent[2]]) {
    const ended = await command(f, turn);
    assert.deepEqual([ended.status, ended.error], ['interrupted', 'runtime_lost']);
  }
  const moved = await command(f, sent[0]);
  assert.deepEqual([moved.status, moved.error], ['waiting', null]);
  assert.notEqual(moved.runtimeId, sent[0].runtimeId);
  // Its old worker can do nothing more with it; a worker on the fresh machine answers it.
  await assert.rejects(
    f.pi.tool(token, { ...quiet, name: 'project.get', input: {} }),
    code('pi_unauthorized'),
  );
  const again = await f.claimed(moved, 'worker_2');
  assert.equal(again.work.command.id, sent[0].id);
  await f.pi.begin(again.token, again.input);
  // A new grant: the relay counts and binds this machine's calls afresh.
  assert.notEqual((await f.pi.authorizeModel(again.work.modelToken)).id, grant.id);
  await f.pi.complete(again.token, f.completion(again.input));
  assert.equal((await command(f, sent[0])).status, 'completed');
});

test('the hosted drain releases each machine once it idles, and counts it until Main has', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  await f.pi.warm(f.operator, { requestId: 'warm' });
  const [idle] = await f.hosts();
  const alice = await login(f, 'alice');
  const project = await f.scope.createProject(alice, { name: 'One', requestId: 'one' });
  const inOne = await f.scope.caller(alice, project.id);
  const busy = await f.send(await f.create(inOne), 'hello', inOne);
  const bound = await f.claimed(busy);
  const { s: schema } = (await f.state.read((sql) =>
    sql.get<{ s: string }>('SELECT current_schema() AS s'),
  ))!;
  // One poll of deploy/hosted-release-vm.py's drain on this database, through its own runner.
  const vm = new URL('../deploy/hosted-release-vm.py', import.meta.url).pathname;
  const poll = () =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import importlib.util,json,os,subprocess
s=importlib.util.spec_from_file_location('vm',${JSON.stringify(vm)});vm=importlib.util.module_from_spec(s);s.loader.exec_module(vm)
def main_read(q,*p,write=False):
    env=dict(os.environ,MERV_Q=q,MERV_P=json.dumps(p),**({'MERV_W':'1'} if write else {}))
    return json.loads(subprocess.run(['node','--input-type=module','-e',vm.MAIN_READ],env=env,capture_output=True,check=True).stdout)
vm.main_read=main_read;vm.sbx=lambda **e:'[]'
print(json.dumps(vm.busy(True)))`,
        ],
        { env: { ...process.env, MERV_DB_URL: postgresUrl, MERV_TS_DB_SCHEMA: schema } },
      ).toString(),
    ) as Record<string, string[]>;
  const first = poll();
  assert.deepEqual(first.turns, [`${busy.conversationId}/${busy.id}`]);
  assert.deepEqual(first.warm.sort(), [idle.current!.allocationId, busy.runtimeId].sort());
  await f.pi.tick();
  assert.equal((await f.host({ hostId: idle.id })).ended?.reason, 'idle');
  assert.equal((await f.host(busy)).status, 'live');
  // The turn ends while the drain waits: its machine goes too.
  await f.finish(bound);
  assert.deepEqual(poll().warm, [busy.runtimeId]);
  await f.pi.tick();
  assert.equal((await f.host(busy)).ended?.reason, 'idle');
  // So does one a page warms meanwhile.
  await f.pi.warm(inOne, { requestId: 'again' });
  const [page] = await f.hosts();
  assert.deepEqual(poll().warm, [page.current!.allocationId]);
  await f.pi.tick();
  assert.equal((await f.host({ hostId: page.id })).ended?.reason, 'idle');
  await f.fleet.tick();
  assert.deepEqual(poll(), {});
});

test('an idle machine ends, with any move it was starting, and forgets where the agent moved it', async (t) => {
  const f = await fixture(t);
  await f.pi.warm(f.operator, { requestId: 'warm' });
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const [host] = await f.hosts();
  const person = (await f.person(host.key))!;
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE pi_people SET data_json=? WHERE key=?',
      JSON.stringify({ ...person, sticky: 'large' }),
      host.key,
    ),
  );
  f.advance(5_000);
  await f.pi.tick();
  assert.equal((await f.host({ hostId: host.id })).ended?.reason, 'idle');
  for (const slot of [host.current!, host.next!])
    assert.equal((await f.allocation(slot.allocationId)).intent, 'stop');
  const after = (await f.person(host.key))!;
  assert.deepEqual([after.sticky, after.moves.at(-1)?.outcome], [null, 'cancelled']);
});

test('stopping the machine ends every turn on it and releases every slot', async (t) => {
  const f = await fixture(t);
  const a = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(a.token, a.input);
  const b = await f.send(await f.create());
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const host = await f.host(b);
  // The move it was starting counts as cancelled, as every move counts for the agent's rules.
  const view = await f.pi.stopMachine(f.operator);
  assert.deepEqual(
    [view.state, view.moving, view.lastMove?.outcome, view.lastMove?.by],
    ['none', null, 'cancelled', 'person'],
  );
  for (const sent of [a.work.command, b]) {
    const ended = await command(f, sent);
    assert.deepEqual([ended.status, ended.error], ['interrupted', 'cancelled']);
  }
  for (const slot of [host.current!, host.next!])
    assert.equal((await f.allocation(slot.allocationId)).intent, 'stop');
  assert.equal((await f.host(b)).ended?.reason, 'stopped');
  await assert.rejects(f.pi.next(a.token, { workerId: 'worker_1' }), code('pi_unauthorized'));
});

test('a machine in use near its deadline hands over to a fresh one of its kind, or the default once its person may not choose it', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 3600 } });
  const conversation = await f.create();
  const other = await f.create();
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const bound = await f.claimed(await f.send(conversation));
  await f.finish(bound);
  const nearDeadline = async () => {
    f.advance(3_600_000 - 15 * 60_000 + 1000);
    await f.pi.tick();
    // An idle machine is not renewed: it idles out, or ends at its deadline.
    assert.equal((await f.host(bound.work.command)).next, null);
    const sent = await f.send(conversation);
    await f.pi.tick();
    return { sent, host: await f.host(sent) };
  };
  const { sent, host } = await nearDeadline();
  assert.deepEqual([host.next?.machine, host.next?.by], ['large', 'deadline']);
  const { stage, host: view } = await f.pi.snapshot(f.operator, other.id);
  assert.deepEqual([stage.name, view.moving?.by], ['ready', 'deadline']);
  const { token, reply } = await cutOver(f, host);
  assert.equal((await f.host(sent)).current?.allocationId, host.next!.allocationId);
  assert.equal((await f.allocation(bound.work.command.runtimeId)).intent, 'stop');
  await f.finish({
    token,
    work: reply.work!,
    input: { ...bound.input, commandId: sent.id, workerId: 'worker_next' },
  });
  f.runtimes.connected = (projectId) => projectId !== f.operator.projectId;
  assert.equal((await nearDeadline()).host.next?.machine, 'standard');
});

test('picking the current machine while a move starts cancels the move', async (t) => {
  const f = await fixture(t);
  const bound = await f.claimed(await f.send(await f.create()));
  await f.pi.begin(bound.token, bound.input);
  await f.pi.setMachine(f.operator, { machine: 'large' });
  const { next } = await f.host(bound.work.command);
  const view = await f.pi.setMachine(f.operator, { machine: 'standard' });
  assert.deepEqual(
    [view.moving, view.lastMove?.outcome, view.preferred],
    [null, 'cancelled', 'standard'],
  );
  assert.equal((await f.allocation(next!.allocationId)).intent, 'stop');
  assert.equal((await f.host(bound.work.command)).next, null);
});

test('only a person who could rent sandboxes in the project may choose a larger machine', async (t) => {
  const f = await fixture(t);
  const large = async (caller: Caller, id: string) =>
    (await f.pi.snapshot(caller, id)).host.catalog.find(({ key }) => key === 'large');
  const readOnly = await reader(f);
  const readerChat = await f.create(readOnly);
  assert.deepEqual(await large(readOnly, readerChat.id), {
    ...offers.large,
    label: 'Large',
    available: false,
    reason: 'needs write access in this project',
  });
  await assert.rejects(
    f.pi.setMachine(readOnly, { machine: 'large' }),
    (error: MervError) =>
      error.code === 'pi_machine_unavailable' &&
      error.message === 'Large needs write access in this project',
  );
  const chat = await f.create();
  assert.equal((await large(f.operator, chat.id))?.available, true);
  const unconnected = (projectId: string) => projectId !== f.operator.projectId;
  f.runtimes.connected = unconnected;
  assert.equal((await large(f.operator, chat.id))?.reason, 'needs Sandboxes in this project');
  // A pick that is no longer allowed starts the machine on the default.
  f.runtimes.connected = () => true;
  await f.pi.setMachine(f.operator, { machine: 'large' });
  assert.deepEqual(await f.fleet.list(f.hostCaller), []);
  f.runtimes.connected = unconnected;
  assert.equal((await f.send(chat)).machine, 'standard');
  await f.pi.stopMachine(f.operator);
  f.runtimes.connected = () => true;
  assert.equal((await f.send(chat)).machine, 'large');
  // An offer Sandboxes no longer describes is hidden.
  f.runtimes.describe = async (_projectId, key) => (key === 'large' ? null : offers[key]);
  assert.deepEqual(
    (await f.pi.snapshot(f.operator, chat.id)).host.catalog.map(({ key }) => key),
    ['standard'],
  );
});

test('switch_machine is never offered, granted or accepted where its person could not pick a larger machine', async (t) => {
  const f = await fixture(t);
  const readOnly = await reader(f);
  const bound = await f.claimed(await f.send(await f.create(readOnly), 'hello', readOnly));
  assert.ok(!bound.work.tools.some(({ name }) => name === 'machine.switch'));
  await f.pi.begin(bound.token, bound.input);
  assert.ok(
    !(await f.pi.authorizeModel(bound.work.modelToken)).toolNames.includes('switch_machine'),
  );
  const move = { machine: 'large', reason: 'The build ran out of memory' };
  await assert.rejects(
    f.pi.tool(bound.token, { ...bound.input, name: 'machine.switch', input: move }),
    code('pi_tool_forbidden'),
  );
  const result = f.completion(bound.input);
  result.outcomes = [
    { callId: 'move_1', name: 'machine.switch', input: move, output: { status: 'starting' } },
  ];
  await assert.rejects(f.pi.complete(bound.token, result), code('pi_result_invalid'));
  assert.equal((await f.host(bound.work.command)).next, null);
});

test('a person who loses write is off Large from their next turn: it waits for, and runs on, Standard', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const alice = await login(f, 'alice');
  const project = await f.scope.createProject(alice, { name: 'One', requestId: 'one' });
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'producer' });
  const bob = async () => f.scope.caller(await login(f, 'bob'), project.id);
  const producer = await bob();
  await f.pi.setMachine(producer, { machine: 'large' });
  const large = await f.claimed(await f.send(await f.create(producer), 'hello', producer));
  assert.equal(large.work.command.machine, 'large');
  await f.finish(large);
  await f.scope.changeMemberRole(alice, project.id, { subject: 'bob', role: 'reader' });
  const reader = await bob();
  const held = await f.send(await f.create(reader), 'hello', reader);
  // Large takes none of their turns; the host moves to Standard first, unannounced.
  assert.deepEqual(await f.pi.next(large.token, { workerId: 'worker_1' }), { work: null });
  await f.pi.tick();
  const host = await f.host(held);
  assert.deepEqual([host.next?.machine, host.next?.by], ['standard', 'deadline']);
  const { reply } = await cutOver(f, host);
  assert.deepEqual([reply.work?.command.id, reply.work?.command.machine], [held.id, 'standard']);
  assert.equal((await f.allocation(large.work.command.runtimeId)).intent, 'stop');
});

test('a Pi host key that is not accepted is a server fault, never a 401 that signs the person out', async (t) => {
  const f = await fixture(t);
  const chat = await f.create();
  process.env[f.pi.config.host!.credentialEnv] = 'x'.repeat(40);
  await f.restart();
  const fault = (error: MervError) => error.code === 'pi_configuration' && error.status === 503;
  await assert.rejects(f.send(chat), fault);
  await assert.rejects(
    f.pi.warm(f.operator, { requestId: 'warm', conversationId: chat.id }),
    fault,
  );
  await assert.rejects(f.pi.setMachine(f.operator, { machine: 'large' }), fault);
});

test('the agent moves up without asking where its person may, within capacity, and the move sticks', async (t) => {
  const f = await fixture(t, { pi: { idleTimeoutSeconds: 600 } });
  const refused = await f.claimed(await f.send(await f.create()));
  const sent = await f.send(await f.create());
  const { work } = await f.pi.next(refused.token, { workerId: 'worker_2' });
  const bound = {
    token: refused.token,
    work: work!,
    input: { conversationId: sent.conversationId, commandId: sent.id, workerId: 'worker_2' },
  };
  for (const turn of [refused, bound]) {
    assert.ok(turn.work.tools.some(({ name }) => name === 'machine.switch'));
    await f.pi.begin(turn.token, turn.input);
  }
  // The grant names exactly the tools the turn was offered, switch_machine among them.
  assert.deepEqual(
    (await f.pi.authorizeModel(bound.work.modelToken)).toolNames.sort(),
    bound.work.tools.map(({ name }) => piModelToolName(name)).sort(),
  );
  assert.ok(bound.work.tools.some(({ name }) => name === 'machine.switch'));
  const call = (turn: typeof bound, machine: string) =>
    f.pi.tool(turn.token, {
      ...turn.input,
      name: 'machine.switch',
      input: { machine, reason: 'The build ran out of memory' },
    });
  const free = f.fleet.free;
  f.fleet.free = async () => 2;
  assert.deepEqual(await call(refused, 'large'), { error: { code: 'machine_unavailable' } });
  f.fleet.free = free;
  assert.deepEqual(await call(bound, 'standard'), { status: 'already' });
  assert.deepEqual(await call(bound, 'large'), { status: 'starting' });
  const host = await f.host(sent);
  assert.deepEqual(
    [host.next?.machine, host.next?.by, host.next?.conversationId],
    ['large', 'agent', sent.conversationId],
  );
  assert.deepEqual(await call(bound, 'large'), { error: { code: 'move_in_progress' } });
  const result = f.completion(bound.input);
  result.outcomes = [
    {
      callId: 'move_1',
      name: 'machine.switch',
      input: { machine: 'large', reason: 'The build ran out of memory' },
      output: { status: 'starting' },
    },
  ];
  assert.deepEqual(await f.pi.complete(bound.token, result), { saved: true });
  await cutOver(f, host);
  const person = (await f.person(host.key))!;
  assert.equal(person.sticky, 'large');
  assert.deepEqual(
    person.moves.map(({ by, outcome, reason }) => [by, outcome, reason]),
    [
      ['agent', 'failed', 'no free machine'],
      ['agent', 'moved', undefined],
    ],
  );
});

test('pi@2 ends turns begun on a conversation’s machine, and the pi@1 image refuses the migrated ledger', async (t) => {
  const state = await openState();
  t.after(() => state.close());
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Pi ledger', actorName: 'Owner' });
  await state.migrate('pi', [migration]);
  const conversation = {
    id: 'pic_old',
    projectId: boot.project.id,
    userId: 'user',
    title: 'Old',
    revision: 3,
    epoch: 2,
    runtimeId: 'flt_old',
    runtimeEpoch: 1,
    runtimeExpiresAt: '2026-09-24T00:00:00.000Z',
    activeCommandId: 'turn',
    idleSince: null,
  };
  await state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO pi_conversations(id,project_id,user_id,request_id,input_hash,runtime_id,data_json) VALUES(?,?,?,?,?,?,?)',
      conversation.id,
      boot.project.id,
      'user',
      'request',
      'hash',
      'flt_old',
      JSON.stringify(conversation),
    );
    await tx.run(
      'INSERT INTO pi_commands(id,conversation_id,status,relay_hash,created_at,data_json) VALUES(?,?,?,?,?,?)',
      'turn',
      conversation.id,
      'working',
      'relay',
      '2026-09-23T00:00:00.000Z',
      JSON.stringify({ id: 'turn', status: 'working', error: null }),
    );
  });
  await state.migrate('pi', [migration, hostMigration]);
  const [kept, turn, column] = await state.read((sql) =>
    Promise.all([
      sql.get<{ data_json: string }>('SELECT data_json FROM pi_conversations'),
      sql.get<{ status: string; data_json: string }>('SELECT status,data_json FROM pi_commands'),
      sql.get(
        "SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='pi_conversations' AND column_name='runtime_id'",
      ),
    ]),
  );
  assert.deepEqual(JSON.parse(kept!.data_json), {
    id: 'pic_old',
    projectId: boot.project.id,
    userId: 'user',
    title: 'Old',
    revision: 3,
    activeCommandId: null,
  });
  assert.equal(turn!.status, 'interrupted');
  assert.equal(JSON.parse(turn!.data_json).error, 'service_unavailable');
  assert.equal(column, undefined);
  await assert.rejects(state.migrate('pi', [migration]), code('migration_ahead'));
});
