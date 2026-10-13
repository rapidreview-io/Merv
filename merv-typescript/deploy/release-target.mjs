// Which VM a release reaches and which log it writes, shared by release.mjs and ui-release.mjs.
import { spawnSync } from 'node:child_process';

export const PRODUCTION = 'https://experiments.rapidreview.io';
// Each known origin is served by exactly one VM, so a release can never reach one VM while
// checking and logging against the other's origin.
const HOSTS = {
  [PRODUCTION]: 'ResearchSuite_Control',
  'https://rp-control-dev.eastus2.cloudapp.azure.com': 'azureuser@dev-experiments.rapidreview.io',
};
/** Where the served UI bundle lives on a VM; the container reads it at /ui (deploy/compose.yml). */
export const UI_DIR = '/var/lib/merv-ts-ui';

export function releaseTarget({ public: value = PRODUCTION, host: named }) {
  // The origin is interpolated into the remote job's approved-origin check, so it is an origin
  // and nothing else: no path, no credentials, no shell metacharacters. `https://x:443/` is `https://x`.
  const url = URL.canParse(value) ? new URL(value) : null;
  const origin = url?.origin ?? '';
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin) || `${origin}/` !== url.href)
    throw new Error(`--public must be an https origin without a path, got ${value}`);
  const known = HOSTS[origin];
  if (known && (named ?? known) !== known)
    throw new Error(`--public ${origin} is served by --host ${known}, not ${named}`);
  if (!known && (!named || Object.values(HOSTS).includes(named)))
    throw new Error(`--public ${origin} needs its own --host, not one serving another origin`);
  const host = known ?? named;
  return {
    PUBLIC: origin,
    host,
    production: origin === PRODUCTION,
    // A staging deploy never appends to the production release log.
    RELEASES: origin === PRODUCTION ? 'deploy/RELEASES.md' : 'deploy/STAGING_RELEASES.md',
    ssh: (script, opts = {}) =>
      spawnSync('ssh', ['-o', 'BatchMode=yes', host, 'sudo', 'bash', '-s'], {
        input: script,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
        ...opts,
      }),
  };
}
