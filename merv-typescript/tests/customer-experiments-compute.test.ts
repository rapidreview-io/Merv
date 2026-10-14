import assert from 'node:assert/strict';
import test from 'node:test';
import type { Caller, Json } from '@merv/contracts';
import type { NativeConnectionStatus } from '@merv/sandboxes/native-types';
import { ManagedCustomerCompute } from '../packages/customer-experiments/src/compute.js';

const caller: Caller = { projectId: 'customer_project', actorId: 'sponsor' };
const offer = {
  provider: 'configured-provider',
  offer_id: 'gpu-shape-1',
  instance_type: 'gpu-shape',
  region: 'region-a',
  resources: {
    cpu: 16,
    memory_mb: 65536,
    gpu: 'A100',
    gpu_count: 1,
    gpu_memory_mb: 81920,
    disk_gb: 100,
  },
  hourly_price: { currency: 'USD', amount: '1.25' },
  available: true,
};
const budget = {
  scope: 'member',
  target: 'sponsor-member',
  window: 'month',
  metric: 'money',
  currency: 'USD',
  provider: null,
  source: null,
  cap: '500',
  available: '430.50',
  accounting_complete: true,
};
const status = (): NativeConnectionStatus => ({
  url: 'https://sandboxes.example/ui',
  available: true,
  connected: true,
  connectionId: 'server-private-connection',
  accountId: 'server-private-account',
  memberId: 'sponsor-member',
  connectedAt: new Date().toISOString(),
  funding: 'managed',
  managedAvailable: true,
  allowance: { budgets: [budget] },
});

test('intake sees refreshed provider facts and prices without funding, credentials, or rental authority', async () => {
  let reads = 0;
  let enables = 0;
  const service = new ManagedCustomerCompute({
    managedCompute: {
      async options(bound) {
        assert.equal(bound, caller);
        reads++;
        return {
          offers: [
            {
              ...offer,
              hourly_price: { currency: 'USD', amount: String(reads) },
              credentials: 'never-send-this',
              resources: { ...offer.resources, secret: 'hidden' },
            },
            { ...offer, offer_id: 'unavailable', available: false },
          ],
          token: 'hidden',
          accountId: 'hidden',
        };
      },
      async enable() {
        enables++;
        return status();
      },
    },
  });
  const first = await service.options(caller);
  const second = await service.options(caller);
  assert.equal(reads, 2);
  assert.equal(enables, 0, 'inventory reads must not enable project compute');
  assert.equal(first.offers.length, 1);
  assert.equal(first.offers[0]!.resources.gpu, 'A100');
  assert.equal(first.offers[0]!.hourly_price?.amount, '1');
  assert.equal(second.offers[0]!.hourly_price?.amount, '2');
  assert.equal(first.source, 'sandboxes');
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
  assert.match(first.notice, /not a reservation/);
  assert.match(first.notice, /internal execution choice/);
  assert.doesNotMatch(JSON.stringify(first), /never-send-this|hidden|credential|accountId/);
});

test('an empty current catalog is distinct from an unreadable or malformed catalog', async () => {
  let response: Json = { offers: [] };
  const service = new ManagedCustomerCompute({
    managedCompute: {
      async options() {
        return response;
      },
      async enable() {
        return status();
      },
    },
  });
  assert.deepEqual((await service.options(caller)).offers, []);
  const invalidResponses: Json[] = [
    { offers: [{ ...offer, available: 'yes' }] },
    {},
    { offers: [{ ...offer, hourly_price: { currency: 'USD', amount: '-2' } }] },
  ];
  for (const invalid of invalidResponses) {
    response = invalid;
    await assert.rejects(service.options(caller), { code: 'customer_compute_unavailable' });
  }
  const failed = new ManagedCustomerCompute({
    managedCompute: {
      async options() {
        throw new Error('upstream-secret');
      },
      async enable() {
        return status();
      },
    },
  });
  await assert.rejects(failed.options(caller), (error: unknown) => {
    assert.doesNotMatch(String(error), /upstream-secret/);
    assert.match(String(error), /could not be verified/);
    return true;
  });
});

test('execution preflight uses the native connection owner and requires verifiable managed headroom', async () => {
  let result = status();
  let enables = 0;
  const service = new ManagedCustomerCompute({
    managedCompute: {
      async options() {
        throw new Error('catalog not needed for funding check');
      },
      async enable(bound) {
        assert.equal(bound, caller);
        enables++;
        return result;
      },
    },
  });
  assert.equal(
    await service.prepareExecution(caller),
    undefined,
    'funding receipts stay server-side',
  );
  assert.equal(enables, 1);
  const invalidFunding: Partial<NativeConnectionStatus>[] = [
    { funding: 'personal' as const },
    { connected: false },
    { allowance: {} },
    { allowance: { budgets: [{ ...budget, target: 'another-member' }] } },
    { allowance: { budgets: [{ ...budget, cap: null }] } },
    { allowance: { budgets: [{ ...budget, cap: '0', available: '0' }] } },
    { allowance: { budgets: [{ ...budget, available: '0.000' }] } },
    { allowance: { budgets: [{ ...budget, accounting_complete: false }] } },
    {
      allowance: {
        budgets: [budget, { ...budget, scope: 'account', target: 'parent', available: '0' }],
      },
    },
  ];
  for (const changed of invalidFunding) {
    result = { ...status(), ...changed };
    await assert.rejects(service.prepareExecution(caller), {
      code: 'customer_compute_unavailable',
    });
  }
  result = {
    ...status(),
    allowance: {
      budgets: [
        budget,
        { ...budget, scope: 'account', target: 'parent', cap: null, available: null },
        { ...budget, provider: 'depleted-provider', available: '0' },
      ],
    },
  };
  await service.prepareExecution(caller);
});

test('missing native managed setup fails closed without inventing GPU availability', async () => {
  const service = new ManagedCustomerCompute({});
  await assert.rejects(service.options(caller), { code: 'customer_compute_unavailable' });
  await assert.rejects(service.prepareExecution(caller), { code: 'customer_compute_unavailable' });
});
