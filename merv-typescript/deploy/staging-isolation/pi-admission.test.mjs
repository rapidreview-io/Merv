import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { admission } from './pi-admission.mjs';
import { PiService } from '../../packages/pi/src/service.ts';
import { PiHosts } from '../../packages/pi/src/hosts.ts';
const url = process.env.ISOLATION_TEST_DATABASE_URL;
test(
  'persistent admission closes the quiet/recreate race and drains without cancelling old work',
  { skip: !url },
  async () => {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
    const db = new pg.Client({ connectionString: url }),
      late = new pg.Client({ connectionString: url });
    await db.connect();
    await late.connect();
    const schema = 'pi_handoff_test_' + process.pid;
    let made = false;
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      made = true;
      await db.query(
        `CREATE TABLE ${schema}.pi_commands(id text PRIMARY KEY,status text);CREATE TABLE ${schema}.pi_hosts(id text PRIMARY KEY,status text,data_json text);CREATE TABLE ${schema}.fleet_allocations(id text PRIMARY KEY,phase text,data_json text)`,
      );
      await db.query(
        `INSERT INTO ${schema}.pi_commands VALUES('streamed','working');INSERT INTO ${schema}.pi_hosts VALUES('customer','live','{}');INSERT INTO ${schema}.fleet_allocations VALUES('customer','running','{"owner":{"kind":"pi-host"}}')`,
      );
      assert.equal((await admission(db, schema, 'inspect')).active, false);
      const gated = await admission(db, schema, 'apply');
      assert.deepEqual(gated, { active: true, commands: 1, hosts: 1, allocations: 1 });
      // Another process tries admission after the last quiet observation, including warm/move.
      await assert.rejects(
        late.query(`INSERT INTO ${schema}.pi_commands VALUES('late','starting')`),
        { code: '55000' },
      );
      await assert.rejects(
        late.query(
          `INSERT INTO ${schema}.fleet_allocations VALUES('warm','queued','{"owner":{"kind":"pi-host"}}')`,
        ),
        { code: '55000' },
      );
      assert.equal(
        (await db.query(`SELECT status FROM ${schema}.pi_commands WHERE id='streamed'`)).rows[0]
          .status,
        'working',
      );
      await db.query(
        `UPDATE ${schema}.pi_commands SET status='completed';UPDATE ${schema}.pi_hosts SET status='ended';UPDATE ${schema}.fleet_allocations SET phase='released'`,
      );
      assert.deepEqual(await admission(db, schema, 'inspect'), {
        active: true,
        commands: 0,
        hosts: 0,
        allocations: 0,
      });
      // The real Pi close implementation selects only live hosts: no customer row remains to end.
      assert.equal(
        (await db.query(`SELECT * FROM ${schema}.pi_hosts WHERE status='live'`)).rowCount,
        0,
      );
      const cancelled = [];
      const core = {
        state: {
          transaction: async (fn) =>
            fn({
              all: async () =>
                (await db.query(`SELECT data_json FROM ${schema}.pi_hosts WHERE status='live'`))
                  .rows,
            }),
        },
        fleet: { cancelOwned: async (_, id) => cancelled.push(id) },
        streams: { close() {} },
      };
      const service = Object.create(PiService.prototype);
      Object.assign(service, { core, hosts: new PiHosts(core), disposers: [], asks: new Map() });
      await service.close();
      assert.deepEqual(cancelled, [], 'actual Pi shutdown cannot cancel a naturally drained host');
      await late.end();
      await admission(db, schema, 'apply'); // process restart/replay retains gate
      assert.equal((await admission(db, schema, 'restore')).active, false);
      await db.query(`INSERT INTO ${schema}.pi_commands VALUES('resumed','starting')`);
      assert.equal((await admission(db, schema, 'restore')).active, false);
    } finally {
      if (made) await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
      await late.end().catch(() => {});
    }
  },
);
