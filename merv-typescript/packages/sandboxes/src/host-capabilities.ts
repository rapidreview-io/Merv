// @merv/sandboxes/host (loader entry sandboxes-host) installs these through Cordis
// children. Keep the static inventory and boundary policy aligned without booting the host.
export const sandboxesHostCapabilities = [
  'sbxMerv',
  'sbxPipelines',
  'sbxObjects',
  'sbxAccounts',
  'sbxRegistry',
  'sbxJobs',
  'sbxSnapshots',
  'sbxDb',
  'sbxClock',
  'sbxSettings',
] as const;
