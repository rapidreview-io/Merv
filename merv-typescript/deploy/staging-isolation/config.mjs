/** Build private candidate files; never installs them or copies an entire production env. */
import { need, hash, durable } from './history.mjs';
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
export const APPS = {
  'cloudflare-fleet-staging': 'a03c1f13-92c1-46c7-a246-17c9304c0f21',
  'cloudflare-fleet-staging-large': 'a03d8ea0-6914-4a7c-9f45-08e25da4a6ab',
};
const SECRETS = ['FLEET_CLOUDFLARE_BRIDGE_STAGING', 'FLEET_CLOUDFLARE_BRIDGE_STAGING_LARGE'];
export function parseEnv(raw) {
  const out = {};
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    need(m && !(m[1] in out), 'invalid/duplicate env line');
    out[m[1]] = m[2];
  }
  return out;
}
export function candidates(sourceRaw, mainRaw, spec) {
  const source = parseEnv(sourceRaw),
    main = parseEnv(mainRaw);
  const origin = new URL(spec.publicOrigin),
    mainOrigin = new URL(spec.mainOrigin);
  need(
    origin.protocol === 'https:' &&
      origin.origin === spec.publicOrigin &&
      origin.hostname === 'dev-experiments.rapidreview.io' &&
      origin.port === '8443',
    'standalone staging TLS endpoint required',
  );
  need(
    mainOrigin.origin === spec.mainOrigin &&
      mainOrigin.hostname === origin.hostname &&
      mainOrigin.port !== origin.port,
    'staging Main callback authority required',
  );
  need(
    new URL(spec.databaseUrl).pathname === '/sandboxes_staging' &&
      spec.databaseUrl !== main.MERV_DB_URL,
    'dedicated database required',
  );
  need(spec.vaultKey && spec.vaultKey !== source.SANDBOXES_VAULT_KEY, 'fresh vault key required');
  need(
    spec.namespaces.length === 2 &&
      spec.namespaces.every((n) => /^merv-stg-native-[a-f0-9]{16}$/.test(n)) &&
      new Set(spec.namespaces).size === 2,
    'exact fresh namespace allowlist required',
  );
  need(
    source.SANDBOXES_STORAGE__BUCKET &&
      spec.storage.bucket !== source.SANDBOXES_STORAGE__BUCKET &&
      !spec.storage.sessionToken,
    'dedicated staging bucket and durable bucket-scoped credential required',
  );
  const providers = JSON.parse(source.SANDBOXES_PROVIDERS).filter((p) => p.name in APPS);
  need(
    providers.length === 2 && new Set(providers.map((p) => p.name)).size === 2,
    'two source providers required',
  );
  for (const p of providers) {
    need(
      p.settings.application_id === APPS[p.name] &&
        p.settings.account_id === 'ac27350cd4a42855004ab960c906b6d5' &&
        p.access === 'tunnel' &&
        SECRETS.some((s) => p.credential === `env:${s}`),
      'provider identity/access/credential changed',
    );
    p.namespaces = [...spec.namespaces];
    p.namespace_prefixes = [];
  }
  const catalog = spec.catalog;
  need(
    catalog.length === 2 &&
      catalog.every((e) => e.provider in APPS && e.image_digest === spec.runnerImage.split('@')[1]),
    'accepted staging catalog required',
  );
  const shared = {
    SANDBOXES_DATABASE_URL: spec.databaseUrl,
    SANDBOXES_DATABASE_SCHEMA: 'public',
    SANDBOXES_VAULT_KEY: spec.vaultKey,
    SANDBOXES_DATA_DIR: '/data',
    SANDBOXES_API_HOST: '0.0.0.0',
    SANDBOXES_API_PORT: '8000',
    SANDBOXES_PUBLIC_API_URL: spec.publicOrigin,
    SANDBOXES_AUTH_PUBLIC_URL: spec.publicOrigin,
    SANDBOXES_AUTH_MERV_ORIGIN: spec.mainOrigin,
    SANDBOXES_AGENT_BINARY_URL: spec.publicOrigin + '/agent',
    SANDBOXES_GATEWAY__PUBLIC_HOST: origin.hostname,
    SANDBOXES_GATEWAY__PUBLIC_PORT: '2222',
    SANDBOXES_ALLOW_SIGNUP: 'false',
    SANDBOXES_RUNTIME_LAUNCH_GRANTS: JSON.stringify(spec.namespaces),
    SANDBOXES_RUNTIME_RELEASES: JSON.stringify(catalog),
    SANDBOXES_SUPABASE: source.SANDBOXES_SUPABASE,
    SANDBOXES_STORAGE__ENDPOINT: spec.storage.endpoint,
    SANDBOXES_STORAGE__REGION: spec.storage.region ?? 'auto',
    SANDBOXES_STORAGE__BUCKET: spec.storage.bucket,
    SANDBOXES_STORAGE__ACCESS_KEY: spec.storage.accessKey,
    SANDBOXES_STORAGE__SECRET_KEY: spec.storage.secretKey,
    SANDBOXES_STORAGE__PREFIX: 'staging-native/live',
  };
  for (const secret of SECRETS) {
    need(source[secret], 'missing designated bridge secret');
    const c = JSON.parse(source[secret]);
    need(c.bridge_url && c.bridge_token && c.cloudflare_api_token, 'incomplete bridge credential');
    shared[secret] = source[secret];
  }
  const encode = (o) =>
    Object.entries(o)
      .map(([k, v]) => {
        need(typeof v === 'string' && !/[\r\n]/.test(v), 'invalid config value');
        return k + '=' + v;
      })
      .join('\n') + '\n';
  const disabled = encode({
      ...shared,
      SANDBOXES_PROVIDERS: JSON.stringify(providers.map((p) => ({ ...p, enabled: false }))),
    }),
    enabled = encode({
      ...shared,
      SANDBOXES_PROVIDERS: JSON.stringify(providers.map((p) => ({ ...p, enabled: true }))),
    });
  const delta = {
    MERV_BOOT_MAINTENANCE: '1',
    MERV_SANDBOXES_PUBLIC_ORIGIN: spec.publicOrigin,
    MERV_SANDBOXES_PROXY_URL: 'http://sbx-control:8000',
  };
  let candidate = mainRaw;
  for (const [k, v] of Object.entries(delta)) {
    candidate = candidate.replace(new RegExp(`^${k}=.*\\n?`, 'm'), '');
    candidate += (candidate.endsWith('\n') ? '' : '\n') + k + '=' + v + '\n';
  }
  need(main.MERV_TS_DB_SCHEMA === 'merv_ts_staging', 'wrong Main schema');
  return {
    disabled,
    enabled,
    main: candidate,
    hashes: {
      disabled: hash(disabled),
      enabled: hash(enabled),
      main: hash(candidate),
      mainOriginal: hash(mainRaw),
    },
  };
}
if (process.argv[1]?.endsWith('/config.mjs')) {
  try {
    const [source, main, spec, dir] = process.argv.slice(2),
      out = candidates(
        readFileSync(source, 'utf8'),
        readFileSync(main, 'utf8'),
        JSON.parse(readFileSync(spec)),
      );
    if (existsSync(dir + '/intent.json'))
      need(
        hash(JSON.parse(readFileSync(dir + '/intent.json'))) === hash(out.hashes),
        'candidate intent changed',
      );
    else durable(dir + '/intent.json', out.hashes);
    for (const [name, value] of [
      ['shared.disabled.env', out.disabled],
      ['shared.enabled.env', out.enabled],
      ['main.candidate.env', out.main],
    ]) {
      if (existsSync(dir + '/' + name)) {
        need(readFileSync(dir + '/' + name, 'utf8') === value, 'candidate file changed');
        continue;
      }
      const fd = openSync(dir + '/' + name, 'wx', 0o600);
      try {
        writeFileSync(fd, value);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    console.error(
      'Candidate rendering refused; inspect private provenance and exact input identities.',
    );
    process.exitCode = 1;
  }
}
