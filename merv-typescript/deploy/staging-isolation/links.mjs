/** Supported native service bootstrap, not a human identity or bearer credential.
 * ensureNativeNamespace creates an operator person that cannot sign in. Only brand-new
 * dedicated staging namespaces may be linked; archived namespaces remain unlinked.
 */
import { openDatabase } from '@sandboxes/db';
import { AccountService, ResourceLimitService, ResourceLimitSchema } from '@sandboxes/accounts';
import { BillingService, PolicySchema } from '@sandboxes/billing';
import { SystemClock } from '@sandboxes/kernel';
import { readFileSync } from 'node:fs';
import { durable, need, hash } from './history.mjs';
const PROJECTS = [
  'project_0f7c9971aa5747939e2f9a9b6e760d56',
  'project_7fb4bb69697f4ed8bf575ed5a351fa7f',
];
export async function bootstrapLinks(db, links) {
  need(
    links.length === 2 && hash(links.map((x) => x.projectId).sort()) === hash([...PROJECTS].sort()),
    'exact staging projects required',
  );
  need(
    links.every((x) => /^merv-stg-native-[a-f0-9]{16}$/.test(x.namespace)) &&
      new Set(links.map((x) => x.namespace)).size === 2,
    'fresh dedicated namespace names required',
  );
  const clock = new SystemClock(),
    accounts = new AccountService(db, clock),
    limits = new ResourceLimitService(db, clock, accounts),
    billing = new BillingService(db, clock, accounts, limits),
    receipts = [];
  for (const link of links) {
    const previous = await accounts.linked(link.projectId);
    need(!previous || previous.name === link.namespace, 'project already linked elsewhere');
    const n = await accounts.ensureNativeNamespace(link.namespace);
    // Refuse reuse of an imported account, even if someone selected a plausible namespace name.
    const owned = await accounts.namespaces(n.account_id);
    need(
      owned.length === 1 &&
        owned[0].name === link.namespace &&
        !(await accounts.get(n.account_id)).suspended,
      'namespace is not a fresh dedicated account',
    );
    const members = await accounts.members(n.account_id);
    need(
      members.length === 1 && members[0].id === n.default_member_id,
      'unexpected account membership',
    );
    const person = await db.get(
      'SELECT issuer,subject,username,password_hash FROM persons WHERE id=$1',
      [members[0].person_id],
    );
    need(
      person && Object.values(person).every((v) => v === null),
      'service bootstrap must not impersonate a human',
    );
    const priorLimit = await db.get(
      "SELECT * FROM infra_resource_limits WHERE account_id=$1 AND id='staging-smoke'",
      [n.account_id],
    );
    const priorPolicy = await db.get(
      "SELECT * FROM infra_policies WHERE account_id=$1 AND id='staging-smoke'",
      [n.account_id],
    );
    if (priorLimit)
      need(
        priorLimit.scope === 'account' &&
          priorLimit.target === n.account_id &&
          priorLimit.provider === null &&
          priorLimit.source === null &&
          (!priorLimit.max_hourly_price || priorLimit.max_hourly_price.currency === 'USD'),
        'existing limit scope differs',
      );
    if (priorPolicy)
      need(
        priorPolicy.scope === 'account' &&
          priorPolicy.target === n.account_id &&
          priorPolicy.window === 'all_time' &&
          priorPolicy.currency === 'USD' &&
          priorPolicy.provider === 'cloudflare' &&
          priorPolicy.metric === 'money',
        'existing budget scope differs',
      );
    const concurrent = Math.min(1, priorLimit?.max_concurrent ?? 1),
      lease = Math.min(900, priorLimit?.max_lifetime_seconds ?? 900),
      hourly = String(Math.min(1, Number(priorLimit?.max_hourly_price?.amount ?? 1))),
      budget = String(Math.min(5, Number(priorPolicy?.cap ?? 5)));
    await limits.set(
      n.account_id,
      'staging-smoke',
      ResourceLimitSchema.parse({
        scope: 'account',
        target: n.account_id,
        max_concurrent: concurrent,
        max_lifetime_seconds: lease,
        max_hourly_price: { currency: 'USD', amount: hourly },
      }),
    );
    await billing.setPolicy(
      n.account_id,
      'staging-smoke',
      PolicySchema.parse({
        scope: 'account',
        target: n.account_id,
        window: 'all_time',
        currency: 'USD',
        cap: budget,
        provider: 'cloudflare',
        metric: 'money',
      }),
    );
    const linked = await db.transaction(async (tx) => {
      await accounts.lock(tx, n.account_id);
      return accounts.setLink(tx, link.namespace, {
        projectId: link.projectId,
        memberId: n.default_member_id,
      });
    });
    receipts.push({
      projectId: link.projectId,
      namespace: linked.name,
      accountId: n.account_id,
      memberId: n.default_member_id,
      maxConcurrent: concurrent,
      maxLeaseSeconds: lease,
      maxHourlyUSD: hourly,
      totalBudgetUSD: budget,
      humanIdentityCreated: false,
      bearerIssued: false,
    });
  }
  return receipts;
}
if (process.argv[1]?.endsWith('/links.mjs')) {
  let db;
  try {
    need(process.env.MERV_BOOT_MAINTENANCE === '1', 'maintenance required');
    db = await openDatabase({ url: process.env.STAGING_HISTORY_DATABASE_URL, schema: 'public' });
    need(
      (await db.get('SELECT current_database() AS name')).name === 'sandboxes_staging',
      'wrong database',
    );
    durable(process.argv[3], await bootstrapLinks(db, JSON.parse(readFileSync(process.argv[2]))));
  } catch {
    console.error(
      'Staging service link bootstrap refused; inspect private plan and namespace provenance.',
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
