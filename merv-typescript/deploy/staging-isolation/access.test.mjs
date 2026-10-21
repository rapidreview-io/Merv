import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { historicalEvidenceDownloads } from '../../packages/sandboxes/src/historical-evidence.ts';
const url = process.env.ISOLATION_TEST_DATABASE_URL;
test(
  'retained native and bare references enforce actual project SQL before object access',
  { skip: !url },
  async () => {
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    let reads = 0;
    try {
      await db.query('BEGIN');
      await db.query(
        'CREATE TEMP TABLE sandbox_native_connections(id text,project_id text);CREATE TEMP TABLE sandbox_native_projects(project_id text);CREATE TEMP TABLE artifacts(project_id text,file_refs_json jsonb,files_json jsonb)',
      );
      await db.query(
        "INSERT INTO sandbox_native_connections VALUES('c','owner');INSERT INTO sandbox_native_projects VALUES('owner')",
      );
      const digest = 'a'.repeat(64),
        ref = JSON.stringify([1, 'c', 'history', 'task', 'w', 'flow', 'node', 'o', digest, 4]);
      await db.query('INSERT INTO artifacts VALUES($1,$2,$3)', [
        'owner',
        JSON.stringify([{ provider: 'sandboxes', reference: 'o', name: 'x' }]),
        JSON.stringify([{ provider: 'sandboxes', name: 'x', hash: digest, size: 4 }]),
      ]);
      const sql = {
        get: async (query, ...args) => {
          let n = 0;
          return (
            await db.query(
              query.replaceAll('?', () => `$${++n}`),
              args,
            )
          ).rows[0];
        },
        all: async (query, ...args) => {
          let n = 0;
          return (
            await db.query(
              query.replaceAll('?', () => `$${++n}`),
              args,
            )
          ).rows;
        },
      };
      const object = {
        id: 'o',
        namespace: 'history',
        kind: 'file',
        state: 'available',
        sha256: digest,
        size_bytes: 4,
      };
      const provider = historicalEvidenceDownloads(
        { read: (fn) => fn(sql) },
        {
          get: async () => {
            reads++;
            return object;
          },
          download: async () => {
            reads++;
            return { object, url: 'https://isolated.example/object' };
          },
        },
        'history',
      );
      for (const value of [ref, 'o']) {
        assert.equal(
          (await provider.download('owner', value)).url,
          'https://isolated.example/object',
        );
        const before = reads;
        for (const project of ['other-staging', 'unrelated'])
          await assert.rejects(provider.download(project, value), /does not belong/);
        assert.equal(reads, before, 'wrong project must obtain zero object bytes');
      }
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  },
);
