import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonical, createService, digest, type Migration } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { managedNoncePostgresMigration } from '../packages/sessions/src/managed-nonce.postgres.js';
import { ManagedRunnerBindings } from '../packages/sessions/src/managed.js';
import { postgresMigrations } from '../packages/sessions/src/index.postgres.js';
import { openState } from './fixtures/state.js';

const published = JSON.parse(
  readFileSync(new URL('./fixtures/published-migrations.json', import.meta.url), 'utf8'),
) as { migrations: { component: string; version: number; hash: string; published: boolean }[] };
const oldImageMigrations: Migration[] = Array.from({ length: 7 }, (_, index) => ({
  version: index + 1,
  sql: postgresMigrations[index + 1],
}));
const bridgeMigrations: Migration[] = [
  ...oldImageMigrations,
  { version: 8, sql: managedNoncePostgresMigration },
];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const errorCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test('sessions v8 keeps v7 data; exact migration-only rollback boots while the v7 image refuses', async () => {
  const directory = `pi-rollback-${randomBytes(8).toString('hex')}`;
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  await createService(new WorkflowsService(state, scope));
  const boot = await scope.bootstrap({ projectName: 'Rollback', actorName: 'Owner' });
  const source = await scope.delegationSource({
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  });
  for (const migration of bridgeMigrations) {
    const ledger = published.migrations.find(
      (entry) => entry.component === 'sessions' && entry.version === migration.version,
    );
    assert.ok(ledger, `missing ledger entry for sessions@${migration.version}`);
    assert.equal(digest(migration.sql), ledger.hash);
    if (migration.version === 7) assert.equal(ledger.published, true);
    if (migration.version === 8) assert.equal(ledger.published, true);
  }

  await state.migrate('sessions', oldImageMigrations);
  const secret = randomBytes(48).toString('hex');
  const env = `MERV_ROLLBACK_${randomBytes(8).toString('hex')}`;
  process.env[env] = secret;
  try {
    const allocationId = `rollback-${randomBytes(8).toString('hex')}`;
    const epoch = 1;
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const enrollmentToken = `me_${createHmac('sha256', secret)
      .update(canonical({ domain: 'merv-managed-me-v1', allocationId, epoch }))
      .digest('hex')}`;
    const oldControl = `mr_${randomBytes(32).toString('hex')}`;
    const platform = {
      name: 'codex',
      harness: 'codex' as const,
      model: 'gpt-6-luna',
      enabled: true,
      parallelism: 1,
    };
    await state.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO session_managed_runners(allocation_id,epoch,project_id,source_json,source_hash,runtime_profile_id,platform_json,capabilities_json,enrollment_hash,enrollment_expires_at,control_hash,control_expires_at,runner_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        allocationId,
        epoch,
        boot.project.id,
        canonical(source),
        digest(source),
        'old-profile',
        canonical(platform),
        canonical([]),
        sha(enrollmentToken),
        expiresAt,
        sha(oldControl),
        expiresAt,
        'preserved-runner',
        new Date().toISOString(),
      );
    });
    const before = await state.transaction((tx) =>
      tx.get<{ allocation_id: string; runner_id: string; control_hash: string }>(
        'SELECT allocation_id,runner_id,control_hash FROM session_managed_runners WHERE allocation_id=?',
        allocationId,
      ),
    );
    await state.migrate('sessions', bridgeMigrations);
    const row = () =>
      state.transaction((tx) =>
        tx.get<{
          allocation_id: string;
          runner_id: string;
          control_hash: string;
          worker_nonce_hash: string | null;
        }>(
          'SELECT allocation_id,runner_id,control_hash,worker_nonce_hash FROM session_managed_runners WHERE allocation_id=?',
          allocationId,
        ),
      );
    assert.deepEqual(await row(), { ...before, worker_nonce_hash: null });
    const bindings = new ManagedRunnerBindings(state, scope, Date.now, env);
    bindings.registerValidator({
      current: async () => true,
      admits: async () => true,
    });
    await assert.rejects(bindings.authenticate(oldControl), errorCode('unauthorized'));
    await assert.rejects(
      bindings.enroll(enrollmentToken, {}),
      errorCode('invalid_managed_enrollment'),
    );
    assert.deepEqual(await row(), { ...before, worker_nonce_hash: null });
    const workerNonce = randomBytes(32).toString('hex');
    const enrolled = await bindings.enroll(enrollmentToken, { workerNonce });
    assert.equal(
      (await bindings.enroll(enrollmentToken, { workerNonce })).controlToken,
      enrolled.controlToken,
    );
    assert.equal(
      (await bindings.authenticate(enrolled.controlToken)).managed?.allocationId,
      allocationId,
    );
    await assert.rejects(
      bindings.enroll(enrollmentToken, { workerNonce: randomBytes(32).toString('hex') }),
      errorCode('managed_binding_conflict'),
    );
    assert.deepEqual(await row(), {
      ...before,
      control_hash: sha(enrolled.controlToken),
      worker_nonce_hash: sha(workerNonce),
    });
    await assert.rejects(
      state.migrate('sessions', oldImageMigrations),
      errorCode('migration_ahead'),
    );
    await assert.rejects(
      state.migrate('sessions', [
        ...oldImageMigrations,
        { version: 8, sql: `${managedNoncePostgresMigration} ` },
      ]),
      errorCode('migration_changed'),
    );
    const reopened = await openState(directory);
    await reopened.migrate('sessions', bridgeMigrations);
    assert.equal((await row())?.control_hash, sha(enrolled.controlToken));
    assert.equal(
      (await bindings.authenticate(enrolled.controlToken)).managed?.allocationId,
      allocationId,
    );
    assert.deepEqual(
      await reopened.transaction((tx) =>
        tx.all<{ version: number; hash: string }>(
          'SELECT version,hash FROM component_migrations WHERE component=? ORDER BY version',
          'sessions',
        ),
      ),
      bridgeMigrations.map(({ version, sql }) => ({ version, hash: digest(sql) })),
    );
  } finally {
    delete process.env[env];
  }
});
