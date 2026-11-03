import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeConfig } from '@merv/board-app/compute';
import { surface } from '@merv/board-app/words';
import { profileGrants } from '@merv/pi/profile-tools';
import { PolicySchema } from '@sandboxes/billing';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { hostConfig } from './fixtures/admin.js';
import { stateConfig } from './fixtures/state.js';

const composition = JSON.parse(
  readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'),
) as ApplicationConfig;

/** Half an hour at the fake's $0.036 an hour passes the person's cap; a quarter does not. */
const PERSON_CAP = 0.012;

async function fixture(t: test.TestContext) {
  process.env.MERV_PI_MODEL_API_KEY = 'unused';
  process.env.SANDBOXES_PROVIDERS = JSON.stringify([
    {
      name: 'fake',
      plugin: 'fake',
      credential: null,
      namespace_prefixes: ['mp-'],
    },
  ]);
  process.env.BOARD_COMPUTE_TEST_VAULT = Buffer.alloc(32, 7).toString('base64url');
  const { dataDir, config } = await hostConfig('BOARD_COMPUTE_TEST_VAULT', { registerTools: true });
  const directory = mkdtempSync(join(tmpdir(), 'merv-board-compute-'));
  t.after(() => {
    delete process.env.SANDBOXES_PROVIDERS;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  const plugins = [
    { id: 'sandboxes-host', name: '@merv/sandboxes/host', config: config },
    ...composition.plugins.map((entry) => {
      if (entry.id === 'state') return { ...entry, config: stateConfig(directory) };
      if (entry.id === 'board-app')
        return {
          ...entry,
          config: {
            ...(entry.config as object),
            compute: { dailyUsdPerPerson: PERSON_CAP, maxHourlyUsd: 0.5 },
          },
        };
      return entry;
    }),
  ];
  const app = await createApp({ directory, config: { plugins }, port: 0 });
  t.after(() => app.stop());
  const { ctx } = app;
  const person = async (subject: string) => {
    const principal = await ctx.scope.members.acceptVerifiedIdentity({
      issuer: 'https://issuer.example.test',
      subject,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const project = async (name: string) => {
      const { id } = await ctx.scope.members.createProject(principal, {
        name,
        requestId: `${subject}-${name}`,
      });
      return ctx.scope.caller(principal, id);
    };
    return { project };
  };
  const call = (caller: never, name: string, input: object) => ctx.tools.call(name, caller, input);
  return { ctx, person, call };
}

test('limits cannot be configured past the half hour', () => {
  assert.equal(computeConfig.parse({}).dailyUsdPerPerson, 1);
  assert.equal(computeConfig.parse({}).dailyUsdTotal, 20);
  assert.throws(() => computeConfig.parse({ maxLeaseSeconds: 1801 }));
  assert.throws(() => computeConfig.parse({ maxHourlyUsd: 0.51 }));
  const grants = profileGrants(surface.tools);
  assert.equal(grants.get('sandboxes.sandbox'), null);
  for (const gone of ['access', 'spend', 'snapshot', 'storage', 'workflow'])
    assert.ok(!grants.has(`sandboxes.${gone}`), gone);
  assert.deepEqual([...grants.get('artifact.write')!].sort(), [
    'create',
    'upload_begin',
    'upload_complete',
    'upload_resume',
  ]);
});

test('each person rents one computer, under their caps, and reaches only their own', async (t) => {
  const { ctx, person, call } = await fixture(t);
  const ada = await person('ada');
  const adaHome = (await ada.project('home')) as never;
  const adaOther = (await ada.project('other')) as never;
  const bob = (await (await person('bob')).project('home')) as never;

  const rent = (caller: never, more: object = {}) =>
    call(caller, 'sandboxes.sandbox', {
      action: 'create',
      provider: 'fake',
      offer_id: 'small:east',
      lease_seconds: 900,
      ...more,
    });
  const made = (await rent(adaHome)) as { id: string };

  // CPU only: the fake's GPU is over the price ceiling. A machine cannot pass the half hour.
  const gpu = { offer_id: 'gpu-a10:east', lease_seconds: 60 };
  await assert.rejects(rent(bob, gpu), { code: 'sandbox_validation' });
  await assert.rejects(rent(bob, { lease_seconds: 1860 }), { code: 'sandbox_validation' });

  // One at a time, and a second project of the same person shares it.
  const running = { code: 'sandbox_concurrency_exceeded' };
  await assert.rejects(rent(adaHome), running);
  await assert.rejects(rent(adaOther), running);

  // Someone else sees nothing of it and can do nothing to it.
  const other = (await call(bob, 'sandboxes.sandbox', { action: 'list' })) as {
    sandboxes: unknown[];
  };
  assert.deepEqual(other.sandboxes, []);
  const unknown = { status: 404 };
  const id = { sandbox_id: made.id };
  await assert.rejects(call(bob, 'sandboxes.sandbox', { action: 'get', ...id }), unknown);
  await assert.rejects(call(bob, 'sandboxes.sandbox', { action: 'delete', ...id }), unknown);
  await assert.rejects(
    call(bob, 'sandboxes.job', { action: 'run', command: 'id', ...id }),
    unknown,
  );

  // A lease the person's daily money cannot cover is refused, in words.
  await assert.rejects(rent(bob, { lease_seconds: 1800 }), { code: 'sandbox_budget_exceeded' });

  // The deployment's own cap stops everyone, plainly.
  const { account_id: account } = (await ctx.sbxAccounts.linked(
    (bob as { projectId: string }).projectId,
  ))!;
  await ctx.sbxBilling.setPolicy(
    account,
    'board-total',
    PolicySchema.parse({
      scope: 'account',
      target: account,
      window: 'day',
      metric: 'money',
      currency: 'USD',
      cap: '0.001',
    }),
  );
  await assert.rejects(rent(bob), { code: 'sandbox_budget_exceeded' });
});
