import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, type Fiber } from 'cordis';
import { MervError, type Caller } from '@merv/contracts';
import { createMervHostPlugin } from '@sandboxes/merv-host';
import { migrate, openDatabase } from '@sandboxes/db';
import { OfferSchema } from '@sandboxes/kernel';
import { createSandboxRequest } from '@sandboxes/registry';
import { sandboxesRunning } from '../packages/sandboxes/src/sandboxes-running.js';
import type { RunningRead } from '@merv/ui/types';
import { postgresUrl, schemaFor } from './fixtures/state.js';

const caller: Caller = {
  actorId: 'person',
  projectId: 'project',
  human: {
    issuer: 'https://identity.example/auth/v1',
    subject: 'person',
    expiresAt: '2030-01-01T00:00:00Z',
    membershipId: 'member',
  },
};
const read = (person = caller): RunningRead => {
  const values = new Map();
  return {
    caller: person,
    include: new Set(),
    route: () => undefined,
    once: (name, fn) => {
      if (!values.has(name)) values.set(name, fn());
      return values.get(name);
    },
  };
};

test('Running caches linked machines, hides protected rentals and keeps scoped controls', async (t) => {
  const schema = schemaFor();
  const dataDir = mkdtempSync(join(tmpdir(), 'merv-m5-'));
  const db = await openDatabase({ url: postgresUrl, schema });
  const ctx = new Context();
  let fiber: Fiber | undefined;
  t.after(async () => {
    await fiber?.dispose();
    await db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await migrate(db, { schemaExplicit: true });
  ctx.provide('scope', {
    require: async (person: Caller, need: string) => {
      if (person.actorId === 'denied' || (need !== 'read' && person.actorId === 'reader'))
        throw new MervError('forbidden', 'Denied', 403);
    },
  } as never);
  const host = createMervHostPlugin({
    MervError,
    env: { M5_DB: postgresUrl, M5_VAULT: Buffer.alloc(32, 7).toString('base64url') },
  });
  fiber = ctx.plugin(
    host,
    host.Config.parse({
      databaseUrlEnv: 'M5_DB',
      vaultKeyEnv: 'M5_VAULT',
      schema,
      publicOrigin: 'https://sandboxes.example',
      dataDir,
      relayEvents: false,
      settings: { providers: [{ name: 'fake', plugin: 'fake' }] },
    }),
  );
  await fiber.await();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const running = sandboxesRunning(ctx);
  assert.deepEqual(await running.nodes!(read()), { nodes: [], pending: true });
  const ns = await ctx.sbxAccounts.ensureNativeNamespace('m5-project');
  await ctx.sbxDb.transaction(async (tx) => {
    await ctx.sbxAccounts.lock(tx, ns.account_id);
    await ctx.sbxAccounts.setLink(tx, ns.name, {
      projectId: caller.projectId,
      memberId: ns.default_member_id,
    });
  });
  const offer = OfferSchema.parse({
    provider: 'fake',
    plugin: 'fake',
    offer_id: 'tiny:east',
    instance_type: 'tiny',
    region: 'east',
    resources: { cpu: 2, memory_mb: 4096 },
    hourly_price: { amount: '0', currency: 'USD' },
  });
  const machine = await ctx.sbxRegistry.create(ns.name, {
    request: createSandboxRequest({
      provider: 'fake',
      offer_id: 'tiny:east',
      name: 'machine',
      lease_seconds: 3600,
    }),
    offer,
    loginUser: 'sandbox',
  });
  await ctx.sbxRegistry.transition(machine.id, { to: 'ready' });
  const protectedMachine = await ctx.sbxRegistry.create(ns.name, {
    request: createSandboxRequest({
      provider: 'fake',
      offer_id: 'tiny:east',
      name: 'agent',
      protected_runtime: true,
    }),
    offer,
    loginUser: 'sandbox',
  });
  t.mock.timers.tick(15_000);
  for (let attempt = 0; !(await running.nodes!(read())).asOf && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = read();
  const nodes = await running.nodes!(snapshot);
  assert.deepEqual(
    nodes.nodes.map((n) => n.key),
    [`sandbox:${machine.id}`],
  );
  assert.ok(nodes.asOf);
  assert.equal(nodes.freshForMs, 30_000);
  assert.equal(nodes.nodes[0]!.lane, 'hardware');
  assert.equal(nodes.nodes[0]!.title, 'CPU · 2 vCPU');
  assert.equal((await running.summary!(snapshot))?.lane, 'hardware');
  const panel = await running.panel!(read(), `sandbox:${machine.id}`);
  assert.equal(panel?.route, `/sandboxes/machines/${machine.id}`);
  const [extend, release] = panel!.actions;
  assert.deepEqual(
    panel?.actions.map((a) => [a.tool, a.input.action, a.input.sandbox_id, a.allowed]),
    [
      ['sandboxes.sandbox', 'renew', machine.id, true],
      ['sandboxes.sandbox', 'delete', machine.id, true],
    ],
  );
  // Renew sets the lease from now, so Extend asks for an hour more than is left.
  const left = (Date.parse(machine.lease_expires_at!.toJSON()) - Date.now()) / 1000;
  assert.ok(Math.abs(Number(extend!.input.lease_seconds) - (left + 3600)) <= 2);
  assert.deepEqual(Object.keys(release!.input).sort(), ['action', 'sandbox_id']);
  assert.equal(await running.panel!(read(), `sandbox:${protectedMachine.id}`), null);
  const readerPanel = await running.panel!(
    read({ ...caller, actorId: 'reader' }),
    `sandbox:${machine.id}`,
  );
  assert.ok(readerPanel?.actions.every((a) => !a.allowed));
  const absorbed = await running.panel!(read(), `sandbox:${machine.id}`, 'check:one');
  assert.deepEqual(absorbed?.actions, []);
  await assert.rejects(running.nodes!(read({ ...caller, actorId: 'denied' })), {
    code: 'forbidden',
  });
  assert.equal(
    await running.panel!(read({ ...caller, projectId: 'elsewhere' }), `sandbox:${machine.id}`),
    null,
  );
});
