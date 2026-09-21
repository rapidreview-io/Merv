# PostgreSQL and S3/R2 storage

[production.example.json](../config/production.example.json) contains the same complete plugin composition as [default.json](../config/default.json), replacing only State and Blobs configuration. State owns records and transactions in PostgreSQL; Blobs owns immutable artifact bytes in S3 or R2. No additional service plugin or external compute service is required for this storage choice.

## Configuration

Provision a PostgreSQL database and a private artifact bucket. Supply credentials through your process environment or secret manager:

| Environment variable          | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `MERV_DB_URL`                 | PostgreSQL connection URI                    |
| `MERV_BLOB_BUCKET`            | Existing artifact bucket                     |
| `MERV_BLOB_ENDPOINT_URL`      | HTTPS S3/R2 origin                           |
| `MERV_BLOB_ACCESS_KEY_ID`     | Artifact storage access key                  |
| `MERV_BLOB_SECRET_ACCESS_KEY` | Artifact storage secret                      |
| `MERV_BLOB_REGION`            | `auto` for R2; actual region for AWS         |
| `MERV_BLOB_PREFIX`            | Optional prefix for project/hash object keys |

The example selects PostgreSQL schema `merv` and verified TLS. The database account needs permission to create/use that schema and apply its tables, indexes and trigger functions. When a private certificate authority is needed, add `"caEnv": "MERV_DB_CA"` under State's `ssl` object and put its PEM certificate in that environment variable. Configure TLS through this object, not URI `ssl*` parameters. Do not disable certificate verification. Local Unix-socket test configurations omit `ssl`; the committed production example keeps it enabled.

The plugin configurations contain environment-variable names, not passwords or storage keys. State defaults to 10 pooled connections, a 5-second connection timeout, a 30-second statement timeout and a 5-second lock timeout; these are configurable in the [State configuration](../packages/state/src/index.ts). See [Blobs](PRODUCTION_BLOBS.md) for object-storage limits and timeouts. Normal uploads and inline reads remain limited to 2 MB. The trusted legacy importer can verify and copy files up to 512 MiB; authenticated short-lived downloads keep those bytes outside the JSON tool response. Heavy sandbox datasets retain their external storage owner.

After bootstrapping a new project as described below, start with the selected configuration:

```sh
npm ci
npm run build:ui
npm run build
npm start -- --config config/production.example.json --dir .merv
```

`--dir` still holds local application files. It does not become the authoritative database or blob store when PostgreSQL and S3 are configured. Keep database and bucket configuration stable across restarts. Application shutdown drains admitted work before releasing storage resources.

## Initial operator

The existing `init` and `actor` CLI commands use their local State/Scope composition and do not accept `--config`. Bootstrap a new PostgreSQL project through the selected application configuration instead. This local script starts the configured stack briefly, creates the operator, saves its credential privately, and shuts down:

```sh
node --import tsx --input-type=module <<'JS'
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createApp } from './src/app.ts';
if (existsSync('.merv/credentials.json')) throw new Error('Operator credentials already exist');
const app = await createApp({
  directory: '.merv',
  configFile: 'config/production.example.json',
  port: 0,
});
try {
  const credentials = await app.ctx.scope.bootstrap({
    projectName: 'My project',
    actorName: 'Operator',
  });
  await writeFile('.merv/credentials.json', JSON.stringify(credentials, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
} finally {
  await app.stop();
}
JS
```

Run bootstrap once for a new project and retain its credential file. Later starts reuse the existing records. Configure shared authentication and public HTTPS separately before exposing the API beyond its default loopback address.

## Durability and verification

Domain record changes, workflow transitions, review verdicts, event entries and command replay receipts commit together in State transactions. A rejected transaction must expose none of those changes. Blob uploads are separately durable before artifact metadata succeeds. Object storage and PostgreSQL do not share a distributed transaction: a later database failure may leave an unreferenced hash object. Do not delete that hash as rollback compensation because another operation may reference it.

Code keeps one Git repository per project on the server's disk, under `repositories.root` of the `code` plugin (`${directory}/code`; `/var/lib/merv-ts/code` in the deployment). It is not in PostgreSQL or the bucket, so a backup must take it together with the database, and one server writes to a volume at a time. It needs Git 2.38 or newer on the server. Quota, free-space floor and restore are in [Code operations](CODE_OPERATIONS.md#the-code-repository).

Selecting these providers does not import an existing SQLite database, disk blobs or Python deployment data. Backups must cover the selected PostgreSQL schema and artifact bucket. The current State provider serializes write transactions per schema to preserve existing workflow and event-ordering invariants; this is a compatibility foundation, not a claim of unlimited concurrent write throughput.

The existing-project migration is a separate, explicit operation described in [Legacy import](LEGACY_IMPORT.md). The Azure staging deployment uses [its deployment renderer](../deploy/README.md) to configure shared authentication and the exact public origin. The generic storage example alone is not the complete Azure release configuration.

The opt-in integration test uses `MERV_TEST_POSTGRES_URL` and unique disposable schemas. It exercises the assembled application with PostgreSQL plus Disk, and with PostgreSQL plus the real AWS SDK against a local S3 protocol fixture. It covers operator authentication, artifact/context reads, task creation, independent review, rollback of verdict/transition/events/replay receipts together, successful retry, two application restarts, authenticated HTTP reads and Blobs unload during an admitted download. Failed S3 uploads publish no artifact metadata or event. The fixture has fake credentials and an explicit constructor-only HTTP-loopback allowance; production plugin configuration still requires HTTPS.

```sh
node --import tsx --test tests/production-storage.test.ts
```

Without `MERV_TEST_POSTGRES_URL`, live PostgreSQL cases are skipped. Local tests do not establish connectivity, permissions or durability for a real deployment account.
