import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import { hostedCustomerCompute } from '@merv/customer-experiments/hosted-compute';
import { Decimal } from '@sandboxes/kernel';

function fixture() {
  const calls: string[] = [];
  const owner = { projectId: 'request', actorId: 'owner' };
  const source = { projectId: 'sponsor', actorId: 'owner' };
  let prepaid = false;
  let linked: string | null = null;
  let policy: Record<string, unknown> | undefined;
  const provider = {
    name: 'lambda',
    enabled: true,
    credential: 'env:UNREAD_FIXTURE',
    settings: {},
  };
  const ctx = {
    scope: { caller: async () => source, require: async () => {} },
    sbxMerv: {
      linked: async () => ({ namespace: 'source', account_id: 'account', member_id: 'payer' }),
      principal: async () => ({}),
    },
    sbxDb: { transaction: async (fn: (q: unknown) => Promise<void>) => fn({}) },
    sbxAccounts: {
      lock: async () => {},
      validateTargetsIn: async () => {},
      addNamespace: async () => ({ merv_project_id: linked }),
      setLink: async (_q: unknown, _namespace: string, value: { projectId: string }) => {
        linked = value.projectId;
      },
    },
    sbxBilling: {
      setPolicy: async (_account: string, _id: string, p: Record<string, unknown>) => {
        policy = p;
      },
      usage: async () => ({
        budgets: [{ ...policy, available: Decimal.fromInt(5), accounting_complete: true }],
      }),
    },
    sbxResourceLimits: {
      set: async () => {
        calls.push('limits');
      },
    },
    sbxVault: {
      list: async () => [],
      fields: async () => {
        throw Error('no user credentials');
      },
    },
    sbxSettings: { providers: [provider] },
    sbxProviders: {
      resolve: async () => ({
        connectionId: prepaid ? 'prepaid' : null,
        source: 'host',
        access: 'inbound',
        plugin: {
          name: 'lambda',
          auth: { resolve: () => ({ api_key: 'private-fixture' }) },
        },
      }),
      hostVisible: () => true,
      connect: async (namespace: string, input: { fields: unknown }) => {
        assert.match(namespace, /^customer-/);
        assert.deepEqual(input.fields, { api_key: 'private-fixture' });
        calls.push('connect');
      },
    },
    tools: {
      call: async (_name: string, caller: unknown, input: unknown) => {
        assert.equal(caller, source);
        assert.deepEqual(input, { all_options: true, provider: 'lambda' });
        calls.push('catalog');
        return { offers: [] };
      },
    },
  } as unknown as Context;
  return {
    compute: hostedCustomerCompute(ctx, {
      sponsor: { issuer: 'issuer', subject: 'subject' },
      computeProjectId: 'sponsor',
      computeProviders: ['lambda'],
    }),
    owner,
    calls,
    prepaid: () => {
      prepaid = true;
    },
    foreign: () => {
      linked = 'another-request';
    },
    policy: () => policy,
  };
}

test('intake inventory stays read-only; payment preflight links private bounded compute', async () => {
  const f = fixture();
  assert.deepEqual((await f.compute.options(f.owner)).offers, []);
  assert.deepEqual(f.calls, ['catalog']);
  await f.compute.prepareExecution(f.owner);
  assert.deepEqual(f.calls, ['catalog', 'limits', 'connect']);
  assert.equal(f.policy()?.window, 'all_time');
  assert.equal(String(f.policy()?.cap), '5');
});

test('customer funding never bypasses prepaid provider admission by copying its credential', async () => {
  const f = fixture();
  f.prepaid();
  await assert.rejects(f.compute.prepareExecution(f.owner), {
    code: 'customer_compute_unavailable',
  });
  assert.ok(!f.calls.includes('connect'));
});

test('customer funding cannot take over another request namespace', async () => {
  const f = fixture();
  f.foreign();
  await assert.rejects(f.compute.prepareExecution(f.owner), {
    code: 'customer_compute_unavailable',
  });
  assert.equal(f.policy(), undefined);
  assert.ok(!f.calls.includes('connect'));
});
