import { setTimeout } from 'node:timers/promises';
import { loadSettings, validateRuntimeRelease } from '@sandboxes/kernel/settings';
import { releaseId } from '@sandboxes/runtimes/releases';
import { CloudflarePlugin } from '@sandboxes/providers/plugins/cloudflare';

export async function applicationStatus(
  provider,
  credential,
  { fetcher = fetch, signal = AbortSignal.timeout(45000), sleep = setTimeout } = {},
) {
  const { account_id: account, application_id: application } = provider.settings;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications/${application}`,
      {
        headers: { Authorization: `Bearer ${credential.cloudflare_api_token}` },
        signal,
      },
    );
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      await response.body?.cancel();
      if (attempt < 3) {
        await sleep(attempt * 1000, undefined, { signal });
        continue;
      }
    }
    if (!response.ok)
      throw new Error(
        `Cloudflare application status GET: HTTP ${response.status}, attempt ${attempt}/3`,
      );
    const body = await response.json();
    const a = body.result,
      g = a?.configuration;
    if (body.success !== true || a?.id !== application || typeof g?.image !== 'string')
      throw new Error('Cloudflare application identity is unverified');
    return {
      id: a.id,
      name: a.name,
      version: a.version,
      image: g.image,
      maxInstances: a.max_instances,
      ssh: Boolean(g.wrangler_ssh?.enabled),
      keys: (g.authorized_keys?.length ?? 0) + (g.trusted_user_ca_keys?.length ?? 0),
      rollout: a.active_rollout_id,
      health: a.health,
    };
  }
}

// The application's health.instances.healthy is not an ownership census: live staging returned
// healthy=5/2 while this native inventory contained no instances or Durable Object bindings.
// Enumerate the same paginated endpoint used by CloudflarePlugin.verifyRuntimeImage. Never infer
// emptiness from an application summary or a partial/malformed inventory.
export async function applicationInventory(
  provider,
  credential,
  { fetcher = fetch, signal = AbortSignal.timeout(45000), sleep = setTimeout } = {},
) {
  const { account_id: account, application_id: application } = provider.settings;
  let token,
    instances = 0,
    durableObjects = 0;
  const tokens = new Set(),
    ids = new Set(),
    names = new Set();
  for (let page = 1; page <= 100; page++) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/containers/dash/applications/${application}/instances`,
    );
    url.searchParams.set('per_page', '100');
    if (token) url.searchParams.set('page_token', token);
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await fetcher(url.toString(), {
        method: 'GET',
        signal,
        headers: { Authorization: `Bearer ${credential.cloudflare_api_token}` },
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await sleep(attempt * 1000, undefined, { signal });
        continue;
      }
      break;
    }
    if (!response.ok) throw new Error(`Cloudflare instance inventory GET: HTTP ${response.status}`);
    const body = await response.json(),
      result = body.result,
      info = body.result_info;
    if (
      body.success !== true ||
      !result ||
      !Array.isArray(result.instances) ||
      !Array.isArray(result.durable_objects) ||
      !info ||
      typeof info !== 'object' ||
      Array.isArray(info)
    )
      throw new Error('Cloudflare instance inventory is incomplete');
    if (
      Object.keys(result).some((key) => !['instances', 'durable_objects'].includes(key)) ||
      Object.keys(info).some((key) => !['per_page', 'next_page_token'].includes(key)) ||
      (info.per_page !== undefined &&
        (!Number.isInteger(info.per_page) || info.per_page < 1 || info.per_page > 100))
    )
      throw new Error('Cloudflare instance inventory has unknown or invalid pagination fields');
    for (const [rows, key, seen] of [
      [result.instances, 'id', ids],
      [result.durable_objects, 'name', names],
    ]) {
      for (const row of rows) {
        if (!row || typeof row[key] !== 'string' || !row[key] || seen.has(row[key]))
          throw new Error('Cloudflare instance inventory is invalid or ambiguous');
        seen.add(row[key]);
      }
    }
    instances += result.instances.length;
    durableObjects += result.durable_objects.length;
    const next = info.next_page_token;
    if (next === undefined || next === null)
      return {
        empty: instances === 0 && durableObjects === 0,
        instances,
        durableObjects,
        pages: page,
      };
    if (typeof next !== 'string' || !next || tokens.has(next))
      throw new Error('Cloudflare instance pagination is invalid');
    tokens.add(next);
    token = next;
  }
  throw new Error('Cloudflare instance inventory exceeded the page limit');
}

export async function probe(env = process.env) {
  if (env.MERV_RELEASES)
    return JSON.parse(env.MERV_RELEASES).map((entry) => releaseId(validateRuntimeRelease(entry)));
  const settings = loadSettings({ env, configFile: '/dev/null' });
  const provider = settings.providers.find(
    (p) => p.name === env.MERV_PROVIDER && p.enabled && p.plugin === 'cloudflare',
  );
  if (!provider) throw new Error('No enabled Cloudflare provider');
  const credential = new CloudflarePlugin().auth.resolve(provider.credential, {
    environ: env,
    instanceName: provider.name,
  });
  return env.MERV_INVENTORY === '1'
    ? applicationInventory(provider, credential)
    : applicationStatus(provider, credential);
}

if (process.argv[1] === '-') {
  try {
    console.log(JSON.stringify(await probe()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
