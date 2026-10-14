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
  return applicationStatus(provider, credential);
}

if (process.argv[1] === '-') {
  try {
    console.log(JSON.stringify(await probe()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
