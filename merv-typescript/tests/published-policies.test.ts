import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';

interface Row {
  fingerprint: string;
  published: boolean;
}
interface Published {
  note: string;
  definitions: (Row & { name: string; version: number })[];
  policies: (Row & { workflow: string; version: number; state: string })[];
}

const published = JSON.parse(
  readFileSync(new URL('./fixtures/published-policies.json', import.meta.url), 'utf8'),
) as Published;

const remedy = (key: string, kind: string, row: Row) =>
  row.published
    ? `${kind} ${key} no longer matches the fingerprint published in production. A published ${kind} is immutable: re-registration fails with workflow_version_conflict and the server exits. Restore this version byte-identically and publish the change as a new version instead.`
    : `${kind} ${key} changed before its first release. Confirm the change is deliberate, then update its fingerprint in tests/fixtures/published-policies.json; once released it can never change again.`;

/**
 * Production holds one immutable row per published workflow definition and per (workflow, version,
 * state) execution policy. Tests start from empty state, so only a fixture of production truth can
 * catch an edit to a published version before it takes the server down at startup.
 */
test('registered workflow definitions and execution policies match every version published in production', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-published-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const { definitions, policies } = await app.ctx.state.read(async (sql) => ({
    definitions: await sql.all<{ name: string; version: number; fingerprint: string }>(
      'SELECT name,version,fingerprint FROM wf_definitions',
    ),
    policies: await sql.all<{
      workflow: string;
      version: number;
      state: string;
      fingerprint: string;
    }>('SELECT workflow,version,state,fingerprint FROM wf_execution_policies'),
  }));
  const registeredDefinitions = new Map(
    definitions.map((row) => [`${row.name}@${row.version}`, row.fingerprint]),
  );
  const registeredPolicies = new Map(
    policies.map((row) => [`${row.workflow}@${row.version}/${row.state}`, row.fingerprint]),
  );
  for (const row of published.definitions) {
    const key = `${row.name}@${row.version}`;
    assert.equal(registeredDefinitions.get(key), row.fingerprint, remedy(key, 'definition', row));
  }
  for (const row of published.policies) {
    const key = `${row.workflow}@${row.version}/${row.state}`;
    assert.equal(
      registeredPolicies.get(key),
      row.fingerprint,
      remedy(key, 'execution policy', row),
    );
  }
});
