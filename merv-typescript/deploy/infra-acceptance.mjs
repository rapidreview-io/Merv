/** Compiled infrastructure acceptance against an empty, precreated production smoke schema. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createService, sha256Hex } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { S3Blobs } from '@merv/blobs';
import { DurableEvents } from '@merv/domain-events';
import { codexModelRelay, modelMigrations } from '@merv/fleet/codex-relay';
import { PiService } from '@merv/pi/service';

let stage = 'preflight';
const checkpoint = (name) => {
  stage = name;
  console.log(JSON.stringify({ acceptance: 'running', stage }));
};
const schema = process.env.MERV_TS_DB_SCHEMA;
const prefix = `merv-ts/${schema}`;
const states = [];
const dispatchers = [];
let blobs;
let guard;
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ acceptance: 'failed', stage, code: 'deadline' }));
  process.exit(1);
}, 120_000);

try {
  // Deliberately refuse an existing populated schema and any production object prefix.
  assert.match(schema ?? '', /^merv_ts_infra_[0-9]{8}_[a-z0-9_]{1,24}$/);
  assert.equal(process.env.MERV_BLOB_PREFIX, prefix);
  assert.ok(process.env.MERV_DB_URL);
  guard = new Client({ connectionString: process.env.MERV_DB_URL, connectionTimeoutMillis: 5000 });
  await guard.connect();
  assert.equal(
    (await guard.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [schema]))
      .rows[0].ok,
    true,
  );
  const ns = await guard.query(
    'SELECT oid,nspowner::regrole::text=current_user AS owned FROM pg_namespace WHERE nspname=$1',
    [schema],
  );
  assert.equal(ns.rowCount, 1);
  assert.equal(ns.rows[0].owned, true);
  const contents = await guard.query(
    `SELECT (SELECT COUNT(*) FROM pg_class WHERE relnamespace=$1)
     +(SELECT COUNT(*) FROM pg_proc WHERE pronamespace=$1)
     +(SELECT COUNT(*) FROM pg_type WHERE typnamespace=$1) AS n`,
    [ns.rows[0].oid],
  );
  assert.equal(Number(contents.rows[0].n), 0);
  const open = async () => {
    const state = await PostgresState.open({
      connectionString: process.env.MERV_DB_URL,
      schema,
      maxConnections: 3,
      readConnections: 2,
      connectionTimeoutMs: 5000,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5000,
    });
    states.push(state);
    return state;
  };
  let state = await open();
  const other = await open();
  let scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({
    projectName: 'Infrastructure acceptance',
    actorName: 'Probe',
  });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(caller, { name: 'Revocation probe', role: 'producer' });
  const delegated = {
    projectId: caller.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  blobs = new S3Blobs({
    bucket: process.env.MERV_BLOB_BUCKET,
    endpoint: process.env.MERV_BLOB_ENDPOINT_URL,
    accessKeyId: process.env.MERV_BLOB_ACCESS_KEY_ID,
    secretAccessKey: process.env.MERV_BLOB_SECRET_ACCESS_KEY,
    region: process.env.MERV_BLOB_REGION || 'auto',
    prefix,
    timeoutMs: 15_000,
  });
  let artifacts = await createService(new ArtifactStore(state, scope, blobs));
  checkpoint('remote-storage-and-retry');
  const bytes = Buffer.from(`infra acceptance ${schema}\n`);
  const hash = sha256Hex(bytes);
  const input = {
    title: 'Probe bytes',
    mediaType: 'text/plain',
    sha256: hash,
    size: bytes.length,
    requestId: 'probe-upload',
  };
  const upload = await artifacts.uploadBegin(delegated, input);
  assert.equal((await artifacts.uploadBegin(delegated, input)).uploadId, upload.uploadId);
  // Exercise the production object's conditional write and checksum path, including replay.
  await blobs.put(caller.projectId, bytes);
  await blobs.put(caller.projectId, bytes);
  const artifact = await artifacts.uploadComplete(delegated, upload.uploadId);
  assert.equal((await artifacts.uploadComplete(delegated, upload.uploadId)).id, artifact.id);
  assert.deepEqual(await blobs.get(caller.projectId, hash), bytes);
  assert.equal((await artifacts.read(delegated, artifact.id)).content, bytes.toString());
  const signed = await artifacts.download(delegated, artifact.id);
  const download = await fetch(signed.download.url, { signal: AbortSignal.timeout(15_000) });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  await assert.rejects(artifacts.get({ ...delegated, projectId: 'project_other' }, artifact.id));

  checkpoint('durable-accounting');
  // No upstream request, provider credential or rented machine: exercise the real accounting owners.
  const grant = { person: 'infra-probe', userId: 'infra-probe' };
  const usage = { inputTokens: 23, outputTokens: 11 };
  await state.migrate('fleet_workflow', modelMigrations);
  const fleetAccounting = (owner) =>
    codexModelRelay({}, owner, {
      providerKey: () => 'unused',
      dailyTokensPerPerson: 1_000_000,
    });
  const fleetCharge = await fleetAccounting(state).reserve(grant, { input: 'probe' });
  const pi = await createService(new PiService(state, scope, {}, {}, {}));
  const piCharge = await pi.reserveModel(grant, { input: 'probe' });
  await fleetAccounting(state).onUsage(usage, grant, fleetCharge);
  await pi.settleModel(usage, grant, piCharge);

  checkpoint('event-rollback-and-independent-writer');
  await state.migrate('infra_probe', [
    {
      version: 1,
      sql: 'CREATE TABLE infra_probe_effects(event BIGINT); CREATE TABLE infra_probe_rows(event BIGINT);',
    },
  ]);
  const publish = async (owner, abort = false) =>
    owner.transaction(async (tx) => {
      const event = await owner.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'infra.probe',
        subjectId: artifact.id,
        data: {},
      });
      await tx.run('INSERT INTO infra_probe_rows VALUES(?)', event.id);
      if (abort) throw new Error('deliberate rollback');
      return event.id;
    });
  await assert.rejects(publish(state, true), /deliberate rollback/);
  const startEvents = async () => {
    const events = await createService(new DurableEvents(state));
    dispatchers.push(events);
    await events.subscribe({
      id: 'infra.probe',
      types: ['infra.probe'],
      from: 'beginning',
      handle: async (event, tx) => {
        await tx.run('INSERT INTO infra_probe_effects VALUES(?)', event.id);
      },
    });
    return events;
  };
  let events = await startEvents();
  await events.drain();
  // This plain read used to poison later safety-poll callbacks with its retired context.
  await state.read(() => events.drain());
  const id = await publish(other);
  const count = () =>
    state.read((sql) => sql.get('SELECT COUNT(*)::int AS n FROM infra_probe_effects'));
  const end = Date.now() + 7000;
  while ((await count()).n !== 1 && Date.now() < end) await delay(25);
  assert.equal((await count()).n, 1);
  assert.deepEqual(await state.read((sql) => sql.all('SELECT event FROM infra_probe_rows')), [
    { event: id },
  ]);

  checkpoint('service-reopen-and-revocation');
  await events.close();
  await state.close();
  state = await open();
  scope = await createService(new ProjectScope(state));
  artifacts = await createService(new ArtifactStore(state, scope, blobs));
  // A lost reply followed by a reopened owner must not apply the accounting delta twice.
  await fleetAccounting(state).onUsage(usage, grant, fleetCharge);
  const reopenedPi = await createService(new PiService(state, scope, {}, {}, {}));
  await reopenedPi.settleModel(usage, grant, piCharge);
  for (const [owner, charge] of [
    ['fleet', fleetCharge],
    ['pi', piCharge],
  ]) {
    const row = await state.read((sql) =>
      sql.get(
        `SELECT u.tokens,r.settled_tokens FROM ${owner}_model_usage u JOIN ${owner}_model_requests r ON u.person=r.person AND u.day=r.day WHERE r.id=?`,
        charge.requestId,
      ),
    );
    assert.equal(Number(row.tokens), 34);
    assert.equal(Number(row.settled_tokens), 34);
  }
  events = await startEvents();
  await events.drain();
  assert.equal((await count()).n, 1);
  assert.equal((await artifacts.read(delegated, artifact.id)).content, bytes.toString());
  await scope.revokeCredential(caller, issued.credential.id);
  await assert.rejects(scope.authenticate(issued.token));
  await assert.rejects(artifacts.read(delegated, artifact.id));
  assert.equal((await artifacts.read(caller, artifact.id)).content, bytes.toString());
  console.log(
    JSON.stringify({
      acceptance: 'passed',
      schema,
      prefix,
      projectId: caller.projectId,
      objectHash: hash,
      checks: [
        'remote-write-replay',
        'remote-read-checksum',
        'signed-download',
        'upload-idempotency',
        'wrong-project-denial',
        'publisher-rollback',
        'cross-connection-event-delivery',
        'consumer-reopen-no-duplicate',
        'artifact-reopen',
        'current-revocation',
        'fleet-settlement-replay-after-reopen',
        'pi-settlement-replay-after-reopen',
      ],
      retained: 'Only this synthetic schema and prefix; no production records were selected.',
    }),
  );
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : 'acceptance_failure';
  console.error(JSON.stringify({ acceptance: 'failed', stage, schema, code }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(dispatchers.map((events) => events.close()));
  await Promise.allSettled(states.map((state) => state.close()));
  await blobs?.close();
  await guard?.end();
  clearTimeout(deadline);
}
