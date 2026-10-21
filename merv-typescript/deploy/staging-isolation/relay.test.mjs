import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { openDatabase, migrate } from '@sandboxes/db';
import { DurableEvents } from '@sandboxes/db/events';
import { relayConsumer } from '@sandboxes/merv-host/relay';
import { ManualClock } from '@sandboxes/kernel';
import { bootstrapLinks } from './links.mjs';
import { initializeRelay } from './relay.mjs';
const url = process.env.ISOLATION_TEST_DATABASE_URL;
test(
  'pinned schema offline relay boundary never dispatches and refuses cursor drift',
  { skip: !url },
  async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    let db,
      created = false;
    try {
      await admin.query('CREATE DATABASE isolation_relay');
      created = true;
      const u = new URL(url);
      u.pathname = '/isolation_relay';
      db = await openDatabase({ url: u.href, schema: 'public' });
      await migrate(db, { schemaExplicit: true });
      await db.run(
        "INSERT INTO domain_events(type,subject_id,namespace,data,at) VALUES('sandbox.state','old','historical-unlinked','{}',now())",
      );
      const first = await initializeRelay(db, 1);
      assert.equal(first.deliveryEnabled, false);
      assert.deepEqual(await initializeRelay(db, 1), first);
      const links = [
        {
          projectId: 'project_0f7c9971aa5747939e2f9a9b6e760d56',
          namespace: 'merv-stg-native-1111111111111111',
        },
        {
          projectId: 'project_7fb4bb69697f4ed8bf575ed5a351fa7f',
          namespace: 'merv-stg-native-2222222222222222',
        },
      ];
      const linked = await bootstrapLinks(db, links);
      assert.deepEqual(await bootstrapLinks(db, links), linked);
      assert.equal((await db.get('SELECT count(*) AS n FROM api_tokens')).n, 0);
      assert.equal(
        (
          await db.get(
            'SELECT count(*) AS n FROM infra_resource_limits WHERE max_concurrent=1 AND max_lifetime_seconds=900',
          )
        ).n,
        2,
      );
      await db.run(
        "INSERT INTO domain_events(type,subject_id,namespace,data,at) VALUES('sandbox.state','s','merv-stg-native-1111111111111111','{}',now())",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        (await db.get("SELECT cursor FROM domain_event_consumers WHERE id='merv-relay'")).cursor,
        1,
      );
      await assert.rejects(initializeRelay(db, 1), /boundary drift/);
      await assert.rejects(initializeRelay(db, 2), /already consumed/);
      const clock = new ManualClock(),
        events = new DurableEvents(db, clock, { pollMs: 100000 }),
        raw = [],
        effective = new Map();
      let crash = true;
      try {
        const consumer = relayConsumer({
          scope: { serviceActor: async (_service, projectId) => ({ actorId: projectId }) },
          state: {
            transaction: async (fn) => {
              await fn({});
              if (crash) {
                crash = false;
                throw Error('crash after Merv commit before cursor commit');
              }
            },
            appendEvent: async (_tx, event) => {
              raw.push(event);
              effective.set(event.data.sbx_event_id, event);
            },
          },
        });
        await events.subscribe(consumer);
        await events.drain();
        assert.equal(
          (await db.get("SELECT cursor FROM domain_event_consumers WHERE id='merv-relay'")).cursor,
          1,
        );
        clock.advance(1);
        await events.drain();
        assert.equal(
          (await db.get("SELECT cursor FROM domain_event_consumers WHERE id='merv-relay'")).cursor,
          2,
        );
        assert.equal(raw.length, 2);
        assert.equal(effective.size, 1);
        assert.ok(raw.every((e) => e.projectId === links[0].projectId && e.subjectId === 's'));
      } finally {
        await events.close();
      }
    } finally {
      await db?.close();
      if (created) await admin.query('DROP DATABASE isolation_relay');
      await admin.end();
    }
  },
);
