# Same-image synthetic acceptance

Run `runtime-acceptance.mjs` inside the exact reviewed candidate image. It uses the
compiled application, real PostgreSQL, and the configured remote object provider.
It creates one synthetic project in an otherwise empty smoke schema and a separate
object prefix. It never selects imported records, enables dispatch, connects external
mounts, or changes public routing.

Before running, use the existing protected database administration channel to create
one new schema owned by `merv_ts_app`, for example:

```sql
CREATE SCHEMA merv_ts_smoke_20260916_01 AUTHORIZATION merv_ts_app;
```

Keep the application role's existing privileges. The script requires direct ownership,
refuses any existing relations/functions/types, and takes an advisory lock to prevent
two copies from using the same schema. Never reuse a partially populated smoke schema.

Set `MERV_TS_IMAGE` to the final immutable candidate image/tag and `RELEASE_DIR` to
its absolute, root-owned release directory. The script can be mounted into an already
built image; it does not need to be compiled or included in a new image layer.
Keep the non-secret script readable by the image's `node` user (mode 0644).

```sh
SMOKE_SCHEMA=merv_ts_smoke_20260916_01
sudo python3 - "$MERV_TS_IMAGE" "$RELEASE_DIR" "$SMOKE_SCHEMA" <<'PY'
import os, pathlib, shlex, subprocess, sys
image, release, schema = sys.argv[1:]
names = (
    'MERV_DB_URL', 'MERV_BLOB_BUCKET', 'MERV_BLOB_ENDPOINT_URL',
    'MERV_BLOB_ACCESS_KEY_ID', 'MERV_BLOB_SECRET_ACCESS_KEY', 'MERV_BLOB_REGION',
)
environment = os.environ.copy()
for name in names:
    environment.pop(name, None)
for line in pathlib.Path('/etc/merv/typescript.env').read_text().splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    name, separator, value = line.partition('=')
    name = name.strip()
    if name not in names:
        continue
    # Existing Compose dotenv values are quoted. Docker --env-file preserves
    # those quotes, so parse values privately before passing environment names.
    parsed = shlex.split(value, comments=True)
    if not separator or len(parsed) != 1:
        raise SystemExit('Invalid private storage configuration')
    environment[name] = parsed[0]
if any(not environment.get(name) for name in names[:-1]):
    raise SystemExit('Missing private storage configuration')
environment['MERV_TS_DB_SCHEMA'] = schema
environment['MERV_BLOB_PREFIX'] = 'merv-ts/' + schema
script = pathlib.Path(release).resolve() / 'deploy/runtime-acceptance.mjs'
command = ['docker', 'run', '--rm', '--network', 'deploy_default']
for name in (*names, 'MERV_TS_DB_SCHEMA', 'MERV_BLOB_PREFIX'):
    if name in environment:
        command.extend(['--env', name])
command.extend([
    '--mount', f'type=bind,src={script},dst=/app/deploy/runtime-acceptance.mjs,readonly',
    '--entrypoint', 'node', image, 'deploy/runtime-acceptance.mjs',
])
raise SystemExit(subprocess.call(command, env=environment))
PY
```

No host port or production data-directory mount is needed. Its API binds an ephemeral
container-loopback port. The script has a ten-minute deadline and logs only stages,
sanitized failures, synthetic identifiers, and aggregate results. Record its SHA-256,
the exact image ID, and the successful final JSON alongside the release evidence.

The check exercises all default plugins, compiled UI assets, actual MCP artifact and
task calls, an independent review and idempotent verdict replay, one continuing agent
across two assignments, five tool-call observations with numeric token estimates, a
signed private file download, research advancing into a five-lens reflection wave,
and persistence after a full application stop/restart. The second task and reflection
wave intentionally remain unfinished in the isolated smoke project. Token counts are
payload estimates, not model billing. Shared Supabase login and public HTTPS routing
require their separate acceptance checks; this script uses synthetic actor/session
credentials only.

The container and temporary local directory are removed after completion. PostgreSQL
records and remote objects are deliberately retained for inspection, including on
failure. After review, the database administrator may drop **only the exact smoke
schema** (with its contents), and the storage administrator may delete **only the
matching `merv-ts/<smoke-schema>/` prefix**. Never delete the bucket, `merv-ts/`, the
import prefix, `merv_ts`, or an import/rehearsal schema. This script performs no cleanup
of durable storage and never prints credentials or signed URLs.
