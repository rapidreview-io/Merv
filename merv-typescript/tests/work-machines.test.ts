import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { MervError, digest, type Caller, type Scope } from '@merv/contracts';
import {
  WorkMachines,
  initializeWorkMachines,
  type WorkMachinePolicy,
} from '@merv/sandboxes/work-machines';
import type { SandboxCompute, SandboxRental, SandboxRentalInput } from '@merv/sandboxes/types';
import { openState } from './fixtures/state.js';

const projectId = 'project_test';
const ownerId = 'wf_test';
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG1vY2tLZXktaW5wdXQtZm9yLXRlc3Rpbmc=';
const input = { key: 'one', provider: 'gpu', offerId: 'offer-1', minutes: 20 };
const caller = (lease: string): Caller => ({
  projectId,
  actorId: `actor_${lease}`,
  session: { id: lease },
});

async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  await initializeWorkMachines(state);
  let currentLease = 'lease-a';
  let active = true;
  let entitled = true;
  const calls = { rent: 0, find: 0, inspect: 0, release: 0, ssh: 0, offers: 0, extend: 0 };
  const rentals = new Map<string, SandboxRental>();
  const machine = (id = 'sbx_1', state = 'ready'): SandboxRental => ({
    sandboxId: id,
    state,
    leaseExpiresAt: '2026-10-01T00:00:00Z',
    hourlyPrice: { amount: '1', currency: 'USD' },
    reason: null,
  });
  let onRent: (
    idempotencyKey: string,
    request: SandboxRentalInput,
  ) => Promise<SandboxRental> = async (idempotencyKey) => {
    const result = machine();
    rentals.set(idempotencyKey, result);
    return result;
  };
  let onFind: (idempotencyKey: string) => Promise<SandboxRental | null> = async (idempotencyKey) =>
    rentals.get(idempotencyKey) ?? null;
  let onInspect: (sandboxId: string) => Promise<SandboxRental> = async (sandboxId) =>
    machine(sandboxId);
  let onRelease: (sandboxId: string) => Promise<SandboxRental> = async (sandboxId) =>
    machine(sandboxId, 'stopped');
  const scope = {
    async require(c: Caller) {
      if (c.projectId !== projectId) throw new MervError('forbidden', 'Wrong project', 403);
      return {};
    },
  } as unknown as Scope;
  const policy: WorkMachinePolicy = {
    async authorize(c, id) {
      if (c.projectId !== projectId || id !== ownerId || c.session?.id !== currentLease)
        throw new MervError('stale_lease', 'Not the current work lease', 403);
    },
    async active(p, id) {
      return p === projectId && id === ownerId && active;
    },
    async entitled(p) {
      return p === projectId && entitled;
    },
  };
  const adapter: SandboxCompute = {
    since: '2026-01-01T00:00:00Z',
    async offers() {
      calls.offers++;
      return [];
    },
    async allowance() {
      return {};
    },
    async submit() {
      throw new Error('unexpected job submit');
    },
    async get() {
      throw new Error('unexpected job get');
    },
    async cancel() {
      throw new Error('unexpected job cancel');
    },
    async rent(_, request) {
      calls.rent++;
      return onRent(request.key, request);
    },
    async findRental(_, idempotencyKey) {
      calls.find++;
      return onFind(idempotencyKey);
    },
    async inspectRental(_, sandboxId) {
      calls.inspect++;
      return onInspect(sandboxId);
    },
    async releaseRental(_, sandboxId) {
      calls.release++;
      return onRelease(sandboxId);
    },
    async extendRental(_, sandboxId, minutes) {
      calls.extend++;
      return { ...machine(sandboxId), leaseExpiresAt: '2026-10-01T01:00:00Z' };
    },
    async ssh(_, sandboxId, publicKey) {
      calls.ssh++;
      assert.equal(sandboxId, 'sbx_1');
      assert.equal(publicKey, key);
      return { certificate: 'test-certificate' };
    },
  };
  const work = new WorkMachines(state, scope, adapter, 'experiment', policy);
  t.after(async () => {
    work.close();
    await state.close();
  });
  return {
    state,
    work,
    calls,
    rentals,
    machine,
    policy,
    adapter,
    setLease(value: string) {
      currentLease = value;
    },
    setActive(value: boolean) {
      active = value;
    },
    setEntitled(value: boolean) {
      entitled = value;
    },
    onRent(value: typeof onRent) {
      onRent = value;
    },
    onFind(value: typeof onFind) {
      onFind = value;
    },
    onInspect(value: typeof onInspect) {
      onInspect = value;
    },
    onRelease(value: typeof onRelease) {
      onRelease = value;
    },
  };
}

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.work.rent(caller('lease-a'), ownerId, input)).state, 'queued');
  await f.work.tick();
  assert.equal((await row(f))?.state, 'ready');
}
async function row(f: Awaited<ReturnType<typeof fixture>>, lease = 'lease-a') {
  return (await f.work.list(caller(lease), ownerId))[0] as
    { state: string; sandboxId: string | null } | undefined;
}

test('handoff preserves rental and project reads; only current work lease can rent, access or release', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.setLease('lease-b');
  assert.equal((await row(f, 'lease-b'))?.sandboxId, 'sbx_1');
  assert.equal((await f.work.list(caller('lease-a'), ownerId)).length, 1);
  assert.equal((await f.work.list({ projectId, actorId: 'operator' }, ownerId)).length, 1);
  await assert.rejects(f.work.list({ projectId: 'project_other', actorId: 'operator' }, ownerId), {
    code: 'forbidden',
  });
  await assert.rejects(f.work.rent(caller('lease-a'), ownerId, input), { code: 'stale_lease' });
  await assert.rejects(f.work.rent(caller('lease-b'), 'wf_other', input), { code: 'stale_lease' });
  assert.deepEqual(await f.work.access(caller('lease-b'), ownerId, 'sbx_1', key), {
    certificate: 'test-certificate',
  });
  await assert.rejects(f.work.access(caller('lease-a'), ownerId, 'sbx_1', key), {
    code: 'stale_lease',
  });
  await assert.rejects(f.work.access(caller('lease-b'), 'wf_other', 'sbx_1', key), {
    code: 'stale_lease',
  });
  await assert.rejects(f.work.release(caller('lease-a'), ownerId, 'sbx_1'), {
    code: 'stale_lease',
  });
  await assert.rejects(f.work.release(caller('lease-b'), 'wf_other', 'sbx_1'), {
    code: 'stale_lease',
  });
  await assert.rejects(
    f.work.access({ ...caller('lease-b'), projectId: 'project_other' }, ownerId, 'sbx_1', key),
    { code: 'forbidden' },
  );
  assert.equal(f.calls.ssh, 1);
  assert.equal(f.calls.rent, 1);
  assert.equal(f.calls.release, 0);
});

test('same rental key is idempotent and mismatched input is refused', async (t) => {
  const f = await fixture(t);
  await ready(f);
  const again = await f.work.rent(caller('lease-a'), ownerId, input);
  assert.equal(again.sandboxId, 'sbx_1');
  await assert.rejects(f.work.rent(caller('lease-a'), ownerId, { ...input, offerId: 'offer-2' }), {
    code: 'compute_key_conflict',
  });
  assert.equal(f.calls.rent, 1);
  assert.equal((await f.work.list(caller('lease-a'), ownerId)).length, 1);
});

test('lost create response recovers by provider key without requiring the old offer', async (t) => {
  const f = await fixture(t);
  const providerKey = digest([projectId, 'experiment', ownerId, input.key]);
  f.onRent(async (idempotencyKey) => {
    assert.equal(idempotencyKey, providerKey);
    f.rentals.set(idempotencyKey, f.machine());
    throw new MervError('compute_unavailable', 'Reply lost', 503);
  });
  await f.work.rent(caller('lease-a'), ownerId, input);
  await f.work.tick();
  assert.equal(f.calls.rent, 1);
  assert.equal((await row(f))?.state, 'queued');
  await f.work.tick();
  assert.equal((await row(f))?.sandboxId, 'sbx_1');
  assert.equal(f.calls.rent, 1);
  assert.equal(f.calls.offers, 0);
  assert.ok(f.calls.find >= 1);
});

test('terminal owner releases ready machine; provider failed state is also released', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.setActive(false);
  await f.work.tick();
  assert.equal(f.calls.release, 1);
  assert.equal((await row(f))?.state, 'stopped');
  const failed = await fixture(t);
  failed.onInspect(async (sandboxId) => failed.machine(sandboxId, 'failed'));
  await failed.work.rent(caller('lease-a'), ownerId, input);
  await failed.work.tick();
  assert.equal((await row(failed))?.state, 'failed');
  await failed.work.tick();
  assert.equal(failed.calls.release, 1);
  assert.equal((await row(failed))?.state, 'stopped');
});

test('stop during uncertain creation never sends a new provider create', async (t) => {
  const f = await fixture(t);
  f.onRent(async () => {
    throw new MervError('compute_unavailable', 'Reply lost', 503);
  });
  await f.work.rent(caller('lease-a'), ownerId, input);
  await f.work.tick();
  f.setActive(false);
  f.onFind(async () => null);
  await f.work.tick();
  await f.work.tick();
  assert.equal(f.calls.rent, 1);
  assert.equal((await row(f))?.state, 'releasing');
  f.onFind(async () => f.machine());
  await f.work.tick();
  assert.equal(f.calls.rent, 1);
  assert.equal(f.calls.release, 1);
  assert.equal((await row(f))?.state, 'stopped');
});

test('only the current owner assignment may extend its discovered rental', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.setLease('lease-b');
  await assert.rejects(f.work.extend(caller('lease-a'), ownerId, 'sbx_1', 5), {
    code: 'stale_lease',
  });
  await assert.rejects(f.work.extend(caller('lease-b'), ownerId, 'sbx_other', 5), {
    code: 'compute_not_found',
  });
  assert.equal(f.calls.extend, 0);
  const extended = await f.work.extend(caller('lease-b'), ownerId, 'sbx_1', 5);
  assert.equal(extended.leaseExpiresAt, '2026-10-01T01:00:00Z');
  assert.equal(f.calls.extend, 1);
  assert.equal(f.calls.release, 0);
});

test('an extension reply reflects a concurrent release instead of reporting ready', async (t) => {
  const f = await fixture(t);
  await ready(f);
  f.adapter.extendRental = async () => {
    await f.work.release(caller('lease-a'), ownerId, 'sbx_1');
    return f.machine();
  };
  assert.equal((await f.work.extend(caller('lease-a'), ownerId, 'sbx_1', 5)).state, 'releasing');
});
