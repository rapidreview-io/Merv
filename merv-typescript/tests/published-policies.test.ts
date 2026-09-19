import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';

interface Row {
  fingerprint: string;
  published: boolean;
  /** Deliberately no longer registered: the records written under it are unreadable now. */
  retired?: boolean;
}
interface Published {
  note: string;
  definitions: (Row & { name: string; version: number })[];
  policies: (Row & { workflow: string; version: number; state: string })[];
  recipes: (Row & { type: string; version: number; hash: string })[];
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
  const { definitions, policies, recipes } = await app.ctx.state.read(async (sql) => ({
    recipes: await sql.all<{ type: string; version: number; hash: string }>(
      'SELECT type,version,hash FROM context_recipes',
    ),
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
  // A version marked retired is one the code has deliberately stopped registering, so the
  // records written under it are no longer readable. Its row stays here as history: production
  // still holds it, and it must never come back under a different fingerprint.
  for (const row of published.definitions) {
    const key = `${row.name}@${row.version}`;
    if (row.retired) {
      assert.equal(
        registeredDefinitions.has(key),
        false,
        `definition ${key} is marked retired but is registered again. Either drop the retirement or publish it as a new version.`,
      );
      continue;
    }
    assert.equal(registeredDefinitions.get(key), row.fingerprint, remedy(key, 'definition', row));
  }
  const registeredRecipes = new Map(recipes.map((row) => [`${row.type}@${row.version}`, row.hash]));
  // Only the current recipe version registers, so a published older version is not rechecked;
  // every registered version must be listed, and a listed published version must be unchanged.
  const listedRecipes = new Map(
    published.recipes.map((row) => [`${row.type}@${row.version}`, row]),
  );
  for (const [key, hash] of registeredRecipes) {
    const row = listedRecipes.get(key);
    assert.ok(
      row,
      `context recipe ${key} is not listed in tests/fixtures/published-policies.json; add it with its hash ${hash} and published: false until it ships`,
    );
    assert.equal(hash, row.hash, remedy(key, 'context recipe', row));
  }
  for (const row of published.policies) {
    const key = `${row.workflow}@${row.version}/${row.state}`;
    if (row.retired) {
      assert.equal(
        registeredPolicies.has(key),
        false,
        `execution policy ${key} is marked retired but is registered again.`,
      );
      continue;
    }
    assert.equal(
      registeredPolicies.get(key),
      row.fingerprint,
      remedy(key, 'execution policy', row),
    );
  }
});
