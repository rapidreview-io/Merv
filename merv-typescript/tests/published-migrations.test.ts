import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, type Migration, type State } from '@merv/contracts';
import { StateStore } from '@merv/state/base';
import { createApp } from './fixtures/app.js';
import { initializeLegacyFoundationImports } from '../src/legacy-import.js';
import { initializeLegacyHistory } from '../src/legacy-history.js';
import { FleetService } from '../packages/fleet/src/index.js';
import { PiService } from '../packages/pi/src/index.js';

interface Row {
  component: string;
  version: number;
  /** digest() of this version's SQL, as State writes it to component_migrations.hash. */
  hash: string;
  published: boolean;
  /**
   * Deliberately no longer registered. Production still holds the row this version wrote, unless
   * the component's retirement removed it together with its tables, as the claims retirement does.
   */
  retired?: true;
}

const published = JSON.parse(
  readFileSync(new URL('./fixtures/published-migrations.json', import.meta.url), 'utf8'),
) as { note: string; migrations: Row[] };

/**
 * Every registered migration, keyed component@version, with the hash production would compare.
 *
 * State.migrate is the one chokepoint every component goes through, so recording its arguments
 * yields each migration's SQL with every template literal already resolved — which a static read
 * of the sources cannot do. State hashes exactly that string.
 */
async function registered(stop: (close: () => Promise<void>) => void) {
  const seen: { component: string; migration: Migration }[] = [];
  const record = (component: string, migrations: Migration[]) => {
    for (const migration of migrations) seen.push({ component, migration });
  };
  const original = StateStore.prototype.migrate;
  StateStore.prototype.migrate = async function (component, migrations) {
    record(component, migrations);
    return original.call(this, component, migrations);
  };
  try {
    const directory = mkdtempSync(join(tmpdir(), 'merv-migrations-'));
    const app = await createApp({ directory, api: true, port: 0 });
    stop(async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    });
  } finally {
    StateStore.prototype.migrate = original;
  }
  // The legacy tables migrate outside a normal boot, so they are driven far enough to register
  // and then abandoned. Refusing to open a database keeps this a census, not an import.
  const abandon = Symbol('census');
  const recorder = {
    async migrate(component: string, migrations: Migration[]) {
      record(component, migrations);
      throw abandon;
    },
  } as unknown as State;
  for (const start of [
    () => initializeLegacyFoundationImports(recorder),
    () => new FleetService(recorder, {} as never, undefined).initialize(),
    () => new PiService(recorder, {} as never, {} as never, {} as never, {} as never).initialize(),
    () => initializeLegacyHistory(recorder),
  ]) {
    try {
      await start();
    } catch (error) {
      if (error !== abandon) throw error;
    }
  }

  const hashes = new Map<string, string>();
  for (const { component, migration } of seen) {
    const key = `${component}@${migration.version}`;
    // The legacy migrations are recorded without reaching State, so check their shape here too.
    assert.deepEqual(
      Object.keys(migration).sort(),
      ['sql', 'version'],
      `migration ${key} must be { version, sql }; State refuses anything else with invalid_migration`,
    );
    assert.equal(typeof migration.sql, 'string', `migration ${key} has no SQL`);
    hashes.set(key, digest(migration.sql));
  }
  return hashes;
}

/**
 * Production holds one immutable row per applied migration, hash-pinned to the SQL that created
 * it. Editing a version that has already shipped takes the server down at startup with
 * migration_changed, and takes the rollback down too, because the older image is behind a
 * database the newer one advanced. Tests start from an empty database and would never notice, so
 * only a fixture of production truth can catch the edit before the release does.
 */
test('registered migrations match every version applied in production', async (t) => {
  const hashes = await registered((close) => t.after(close));
  for (const row of published.migrations) {
    const key = `${row.component}@${row.version}`;
    if (row.retired) {
      assert.equal(
        hashes.has(key),
        false,
        `migration ${key} is marked retired but is registered again. Production already applied it under hash ${row.hash}: either drop the retirement or publish the change as a new version.`,
      );
      continue;
    }
    assert.equal(
      hashes.get(key),
      row.hash,
      row.published
        ? `migration ${key} no longer matches the SQL applied in production. A migration that shipped is immutable: a mismatch refuses startup with migration_changed and the rollback with migration_ahead. Restore this version byte-identically and put the change in a NEW version.`
        : `migration ${key} changed before its first release. Confirm the change is deliberate, then update its hash in tests/fixtures/published-migrations.json to ${hashes.get(key) ?? '(it is no longer registered)'}; once released it can never change again.`,
    );
  }
  // The other direction: a registered version this file does not list would be frozen by its
  // first release with nothing here to catch a later edit.
  const listed = new Set(published.migrations.map((row) => `${row.component}@${row.version}`));
  assert.equal(
    listed.size,
    published.migrations.length,
    'Published migration entries must be unique',
  );
  assert.deepEqual(
    [...hashes].filter(([key]) => !listed.has(key)).map(([key, hash]) => `${key} ${hash}`),
    [],
    'registered but not listed in tests/fixtures/published-migrations.json; add each with the hash shown and published: false until it ships',
  );
  // State refuses a component whose versions repeat or are not positive integers; catching it
  // here names the component instead of failing the next boot with invalid_migration.
  const versions = new Map<string, number[]>();
  for (const key of hashes.keys()) {
    const [component, version] = key.split('@');
    versions.set(component, [...(versions.get(component) ?? []), Number(version)]);
  }
  for (const [component, all] of versions)
    assert.deepEqual(
      all.filter((version) => Number.isSafeInteger(version) && version > 0).sort((a, b) => a - b),
      [...new Set(all)].sort((a, b) => a - b),
      `${component} migration versions must be unique positive integers`,
    );
});
