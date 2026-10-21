// Network-none packaged-image dependency/entrypoint preflight. Never opens a DB or provider.
for (const dependency of [
  'pg',
  '@aws-sdk/client-s3',
  '@sandboxes/db',
  '@sandboxes/accounts',
  '@sandboxes/billing',
  '@sandboxes/merv-host/relay',
])
  await import(dependency);
for (const name of [
  'history',
  'selection',
  'blobs',
  'relay',
  'links',
  'provision',
  'config',
  'source-fence',
  'pi-admission',
])
  await import(`./${name}.mjs`);
console.log(JSON.stringify({ operatorRuntimeReady: true, networkUsed: false }));
