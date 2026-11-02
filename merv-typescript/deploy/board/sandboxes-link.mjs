// Links the board's host project to its namespace, with the deployment's ceilings. Run inside the
// control container, from /opt/sandboxes/typescript, with BOARD_HOST_PROJECT set.
import { openDatabase } from '@sandboxes/db';
import { AccountService, ResourceLimitService, ResourceLimitSchema } from '@sandboxes/accounts';
import { BillingService, PolicySchema } from '@sandboxes/billing';
import { SystemClock } from '@sandboxes/kernel';

const namespace = 'merv-board-host';
const db = await openDatabase({ url: process.env.SANDBOXES_DATABASE_URL, schema: 'public' });
const clock = new SystemClock();
const accounts = new AccountService(db, clock);
const limits = new ResourceLimitService(db, clock, accounts);
const billing = new BillingService(db, clock, accounts, limits);
const n = await accounts.ensureNativeNamespace(namespace);
const target = { scope: 'account', target: n.account_id };
await limits.set(
  n.account_id,
  'board',
  ResourceLimitSchema.parse({
    ...target,
    max_concurrent: 10,
    max_lifetime_seconds: 86400,
    max_hourly_price: { currency: 'USD', amount: '1' },
  }),
);
// Ten standard-1 machines for a whole month is about $533: the most this app can rent at all.
await billing.setPolicy(
  n.account_id,
  'board-monthly',
  PolicySchema.parse({
    ...target,
    window: 'month',
    currency: 'USD',
    cap: '600',
    provider: 'cloudflare',
    metric: 'money',
  }),
);
const linked = await db.transaction(async (tx) => {
  await accounts.lock(tx, n.account_id);
  return accounts.setLink(tx, namespace, {
    projectId: process.env.BOARD_HOST_PROJECT,
    memberId: n.default_member_id,
  });
});
console.log(JSON.stringify({ namespace: linked.name, account: n.account_id }));
await db.close();
