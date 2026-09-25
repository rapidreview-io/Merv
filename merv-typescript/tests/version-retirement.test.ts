/**
 * The 2026-09-22 retirement on PostgreSQL, and the 2026-09-25 retirement of experiment.plan tasks:
 * a database seeded with an instance of every workflow version that can no longer start, and an
 * experiment.plan task (tests/fixtures/retired-instances.ts), is booted by the current
 * build. Every record of those instances goes, and nothing else changes: not the survivors of the
 * same shape, not the records kept on purpose, not the events log, not the pinned definitions,
 * and no no-delete guard stays off. The fifteen migrations also reach the same end state in any
 * order, because each computes the same ledger before it deletes; and a database the release
 * would leave inconsistent is refused by whichever runs first, before anything commits.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import type { Caller, Migration } from '@merv/contracts';
import {
  planRetirementLedgerSql,
  planRetirementPreconditionsSql,
  retirementLedgerSql,
  retirementPreconditionsSql,
} from '@merv/contracts/retired-instances';
import { StateStore } from '@merv/state/base';
import { createApp } from './fixtures/app.js';
import { openState, postgresUrl, schemaFor } from './fixtures/state.js';
import {
  at,
  insert,
  KEPT_TABLES,
  RETIRED,
  retiredRecipes,
  retiredVersions,
  retirementMigrations,
  seedRetirement,
  type Seed,
} from './fixtures/retired-instances.js';

const census = async () =>
  await readFile(new URL('../scripts/retirement-census.sql', import.meta.url), 'utf8');
const key = (component: string, version: number) => `${component}@${version}`;
const retiredIds = RETIRED.map((instance) => instance.id);
const namesRetired = (text: string) => retiredIds.some((id) => text.includes(id));

/** Tables whose rows a boot may legitimately rewrite, or that are compared on their own. */
const unsnapshotted = new Set([
  'events',
  'event_consumers',
  'component_migrations',
  'wf_retired_instances',
]);
/** The tables each retirement migration deletes from, and the Consolidation tables it drops. */
const deletedFrom = [
  'wf_dependencies',
  'wf_blockers',
  'wf_requests',
  'wf_system_requests',
  'wf_work_starts',
  'wf_limit_grants',
  'wf_history',
  'wf_instances',
  'worker_sessions',
  'session_tool_calls',
  'session_dispatch_receipts',
  'session_dispatch_holds',
  'session_hold_requests',
  'session_budgets',
  'session_workspaces',
  'session_usage',
  'task_leases',
  'task_checkpoints',
  'task_commands',
  'tasks',
  'review_commands',
  'reviews',
  'context_packages',
  'experiment_slots',
  'experiment_evidence',
  'experiment_submissions',
  'experiment_attempts',
  'experiment_commands',
  'experiments',
  'experiment_leases',
  'reflection_leases',
  'reflection_commands',
  'reflection_lenses',
  'reflections',
  'research_automation',
  'research_commands',
  'research_cycles',
  'knowledge_commands',
  'knowledge_snapshots',
];
const consolidationTables = [
  'consolidations',
  'consolidation_submissions',
  'consolidation_commands',
  'consolidation_leases',
];
/** Every table whose no-delete guard a retirement migration turns off and on again. */
const guarded = [
  'wf_system_requests',
  'wf_work_starts',
  'wf_limit_grants',
  'worker_sessions',
  'session_dispatch_receipts',
  'session_workspaces',
  'session_usage',
  'task_leases',
  'task_checkpoints',
  'reviews',
  'context_packages',
  'experiment_evidence',
  'experiment_submissions',
  'experiment_attempts',
  'experiment_commands',
  'experiments',
  'experiment_leases',
  'reflection_leases',
  'reflection_lenses',
  'reflections',
  'research_cycles',
  'research_automation',
];

async function connect(t: TestContext, directory: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  t.after(async () => await client.end());
  await client.query(`SET search_path TO "${schemaFor(directory)}"`);
  return client;
}

async function rows<T = Record<string, unknown>>(
  client: pg.Client,
  sql: string,
  params?: unknown[],
) {
  return (await client.query(sql, params)).rows as T[];
}

/** Every row of every table, as canonical JSON text, sorted. */
async function snapshot(client: pg.Client, only?: string[]): Promise<Record<string, string[]>> {
  const tables = (
    await rows<{ name: string }>(
      client,
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY 1`,
    )
  )
    .map(({ name }) => name)
    .filter((name) => (only ? only.includes(name) : !unsnapshotted.has(name)));
  const result: Record<string, string[]> = {};
  for (const table of tables)
    result[table] = (
      await rows<{ row: unknown }>(client, `SELECT to_jsonb(t) AS row FROM "${table}" t`)
    )
      .map(({ row }) => JSON.stringify(row))
      .sort();
  return result;
}

/** The census script's result rows, by census number. */
async function runCensus(client: pg.Client): Promise<Record<string, Record<string, unknown>[]>> {
  let results: pg.QueryResult | pg.QueryResult[];
  try {
    results = await client.query(await census());
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const byCensus: Record<string, Record<string, unknown>[]> = {};
  for (const result of [results].flat())
    for (const row of result.rows ?? []) {
      const { census: number, ...rest } = row as { census: string };
      (byCensus[number] ??= []).push(rest);
    }
  return byCensus;
}

const disabledTriggers = (client: pg.Client) =>
  rows(
    client,
    `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())
       AND NOT t.tgisinternal AND t.tgenabled<>'O'`,
  );
const ledger = (client: pg.Client) =>
  rows(
    client,
    'SELECT id,workflow,version::int AS version,reason FROM wf_retired_instances ORDER BY id',
  );
const expectedLedger = RETIRED.map(({ id, workflow, version, reason }) => ({
  id,
  workflow,
  version,
  reason,
})).sort((a, b) => (a.id < b.id ? -1 : 1));

interface Prepared {
  directory: string;
  client: pg.Client;
  seed: Seed;
  live: Caller;
}

/**
 * A database the current build has booted once, empty, then rewound to the release before the
 * retirement and seeded. `work` runs against the booted app first, in the live project.
 */
async function prepare(
  t: TestContext,
  work?: (app: Awaited<ReturnType<typeof createApp>>, live: Caller) => Promise<string>,
  onFirstBoot?: (client: pg.Client) => Promise<void>,
): Promise<Prepared> {
  const directory = await mkdtemp(join(tmpdir(), 'merv-version-retirement-'));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  // Feed is off by default, but production's database keeps its posts: boot it to hold them.
  const app = await createApp({ directory, feed: true });
  let seed: Seed;
  let live: Caller;
  let dependentTaskId: string | undefined;
  try {
    const bootstrap = async (projectName: string) => {
      const credentials = await app.ctx.scope.bootstrap({ projectName, actorName: 'Operator' });
      return { projectId: credentials.project.id, actorId: credentials.actor.id };
    };
    const liveProject = await bootstrap('Live work');
    live = liveProject;
    seed = { live: liveProject, history: await bootstrap('Retired history') };
    if (work) dependentTaskId = await work(app, live);
  } finally {
    await app.stop();
  }
  const client = await connect(t, directory);
  if (onFirstBoot) await onFirstBoot(client);
  seed = { ...seed, ...(dependentTaskId ? { dependentTaskId } : {}) };
  await seedRetirement(client, seed);
  return { directory, client, seed, live };
}

test('the census embeds the ledger text the migrations run, and reports their refusals as rows', async () => {
  const text = await census();
  assert.ok(text.includes(retirementLedgerSql));
  assert.ok(text.includes(planRetirementLedgerSql));
  assert.ok(!text.includes(retirementPreconditionsSql));
  assert.ok(!text.includes(planRetirementPreconditionsSql));
});

/** Captures the migration texts the app runs, by `component@version`, until restored. */
function recordMigrations(t: TestContext) {
  const recorded = new Map<string, string>();
  const original = StateStore.prototype.migrate;
  StateStore.prototype.migrate = async function (component: string, migrations: Migration[]) {
    for (const migration of migrations)
      recorded.set(key(component, migration.version), migration.sql);
    return await original.call(this, component, migrations);
  };
  let restored = false;
  const restore = () => {
    if (!restored) StateStore.prototype.migrate = original;
    restored = true;
  };
  t.after(restore);
  return { recorded, restore };
}

test('retiring the versions that can no longer start deletes their records and nothing else', async (t) => {
  // The first boot runs every retirement migration on an empty database: a no-op.
  const { recorded, restore } = recordMigrations(t);
  const { directory, client, seed, live } = await prepare(
    t,
    async (app, caller) => {
      restore();
      // Live work of the live project, which the release must leave exactly as it is.
      const task = await app.ctx.tasks.create(caller, {
        title: 'Live task',
        goal: 'Keep working.',
        checks: ['It still works.'],
        requestId: 'live-task',
      });
      await app.ctx.experiments.create(caller, {
        name: 'live-experiment',
        intent: 'Keep testing.',
        requestId: 'live-experiment',
      });
      await app.ctx.research.create(caller, { name: 'Live research', requestId: 'live-research' });
      return task.id;
    },
    async (client) => {
      const applied = new Set(
        (
          await rows<{ key: string }>(
            client,
            "SELECT component || '@' || version AS key FROM component_migrations",
          )
        ).map((row) => row.key),
      );
      for (const [component, version] of retirementMigrations)
        assert.ok(applied.has(key(component, version)), `${key(component, version)} ran`);
      assert.deepEqual(await ledger(client), []);
      assert.deepEqual(await disabledTriggers(client), []);
    },
  );
  const listed = new Set(retirementMigrations.map(([c, v]) => key(c, v)));
  for (const name of listed) assert.ok(recorded.has(name), `${name} is registered`);
  assert.deepEqual(
    [...recorded]
      .filter(([name, sql]) => sql.includes('wf_retired_instances') && !listed.has(name))
      .map(([name]) => name),
    [],
    'every migration that embeds the ledger is a retirement migration this test rewinds',
  );

  const before = await snapshot(client);
  const events = await rows(client, 'SELECT count(*)::int AS n FROM events');
  const first = await runCensus(client);
  const grouped = new Map<string, number>();
  for (const { reason, workflow, version, state } of RETIRED) {
    const group = JSON.stringify([reason, workflow, String(version), state]);
    grouped.set(group, (grouped.get(group) ?? 0) + 1);
  }
  assert.deepEqual(
    first
      .C1!.map(
        (row) =>
          `${JSON.stringify([row.reason, row.workflow, String(row.version), row.state])} ${row.instances}`,
      )
      .sort(),
    [...grouped].map(([group, count]) => `${group} ${count}`).sort(),
  );
  assert.equal(first.C2, undefined, 'no live session of a retired instance');
  assert.deepEqual(
    first.C3!.map((row) => [row.source_id, row.target_id]),
    [[seed.dependentTaskId, 'r-exp3']],
  );
  assert.deepEqual(first.C4!.map((row) => [row.change, row.id, row.retired_id]).sort(), [
    ['automation root re-pointed', 'l-res6', 'r-res5'],
    ['predecessor re-linked to NULL', 'l-res6', 'r-res5'],
  ]);
  assert.deepEqual(
    first.C5!.map((row) => Number(row.must_be_0)),
    [0, 0, 0],
  );
  assert.deepEqual(
    first.C6!.map((row) => Number(row.kept)),
    [1, 1, 1, 1, 1],
    'one kept Code row of each kind names a retired instance',
  );
  assert.equal(first.C7, undefined);
  for (const row of first.C8!)
    if (row.migration !== 'kept')
      assert.ok(Number(row.row_count) > 0, `the fixture seeds ${row.selector}`);
  assert.equal(first.C10, undefined, 'the test user owns every table it alters');
  assert.deepEqual(first.C11!.map((row) => row.reflection_id).sort(), ['r-stage', 'r-wave2']);
  // Every hit is a record a migration deletes, a dropped Consolidation table or a kept record.
  const accounted = new Set([...deletedFrom, ...consolidationTables, ...KEPT_TABLES]);
  assert.deepEqual(
    first.C9!.map((row) => row.table_name).filter((table) => !accounted.has(String(table))),
    [],
  );
  // Only the history project's own budget changes: its retired sessions pushed it over.
  assert.deepEqual(
    first.C12!.map((row) => [row.scope_id, row.kind, row.exceeded_before, row.exceeded_after]),
    [[seed.history.projectId, 'project', 'wall', '']],
  );
  assert.ok(first.C13!.some((row) => row.consumer === 'sessions.lifecycle.v1'));

  // The release.
  const app = await createApp({ directory });
  t.after(async () => await app.stop());

  assert.deepEqual(await rows(client, 'SELECT count(*)::int AS n FROM events'), events);
  assert.deepEqual(await ledger(client), expectedLedger);
  const expected: Record<string, string[]> = {};
  for (const [table, contents] of Object.entries(before)) {
    if (consolidationTables.includes(table)) continue;
    expected[table] = KEPT_TABLES.includes(table)
      ? contents
      : ['knowledge_commands', 'knowledge_snapshots'].includes(table)
        ? []
        : contents
            .map((text) => {
              const row = JSON.parse(text) as Record<string, unknown>;
              // A survivor that followed a retired cycle forgets it, and its automatic run is
              // re-rooted at its earliest surviving cycle.
              if (table === 'research_cycles' && row.id === 'l-res6') row.predecessor_id = null;
              if (table === 'research_automation' && row.research_id === 'l-res6')
                row.root_id = 'l-res6';
              // reflections@3 and reviews@11 add a column after the retirement; jsonb orders keys
              // by length.
              const added = {
                reflections: { abandoned: null },
                reviews: { owner_override: false },
              }[table];
              if (added)
                return JSON.stringify(
                  Object.fromEntries(
                    Object.entries({ ...row, ...added }).sort(
                      ([a], [b]) => a.length - b.length || (a < b ? -1 : 1),
                    ),
                  ),
                );
              return JSON.stringify(row);
            })
            .filter((text) => !namesRetired(text))
            .sort();
  }
  expected.session_managed_runners = [];
  const after = await snapshot(client);
  for (const table of new Set([...Object.keys(expected), ...Object.keys(after)]))
    assert.deepEqual(after[table], expected[table], table);

  // Every consumer catches up, the one whose logged session close names a deleted session too.
  await app.ctx.domainEvents.drain();
  const [{ head }] = await rows<{ head: number }>(
    client,
    'SELECT max(id)::int AS head FROM events',
  );
  assert.deepEqual(
    (await app.ctx.domainEvents.status())
      .filter((consumer) => consumer.cursor !== head || consumer.error !== null)
      .map((consumer) => [consumer.id, consumer.error]),
    [],
  );

  const second = await runCensus(client);
  // Only the records kept on purpose still name a retired instance.
  assert.deepEqual([...new Set(second.C9!.map((row) => row.table_name))].sort(), [
    'code_edges',
    'code_proposals',
    'code_units',
    'paper_proposals',
    'session_service_work',
  ]);
  for (const row of second.C8!) {
    const count = row.row_count === null ? null : Number(row.row_count);
    if (row.selector === 'wf_retired_instances') assert.equal(count, RETIRED.length);
    else if (row.selector === 'events') assert.equal(count, events[0]!.n);
    else if (/^consolidation.* dropped$/.test(String(row.selector))) assert.equal(count, null);
    else assert.equal(count, 0, String(row.selector));
  }
  assert.deepEqual(
    [second.C2, second.C3, second.C4, second.C11, second.C12, second.C13],
    [undefined, undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(await disabledTriggers(client), []);

  // A guard raises (23514, or P0001 for a bare RAISE); a foreign key alone would say 23503.
  const refusedByGuard = (error: { code?: string }) => ['23514', 'P0001'].includes(error.code!);
  for (const table of guarded) {
    assert.ok((await rows(client, `SELECT 1 FROM ${table} LIMIT 1`)).length, `${table} survivor`);
    await client.query('BEGIN');
    await assert.rejects(client.query(`DELETE FROM ${table}`), refusedByGuard, table);
    await client.query('ROLLBACK');
  }
  // The ledger is the only record of the set once wf_instances has lost it.
  for (const statement of [
    'DELETE FROM wf_retired_instances',
    "UPDATE wf_retired_instances SET reason='changed'",
  ]) {
    await client.query('BEGIN');
    await assert.rejects(client.query(statement), refusedByGuard, statement);
    await client.query('ROLLBACK');
  }
  for (const table of ['knowledge_commands', 'knowledge_snapshots']) {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO knowledge_snapshots(id,project_id,created_by,created_at,format_version,manifest_hash,record)
       VALUES('probe','p','a','now',1,'hash','{}')`,
    );
    await client.query(
      `INSERT INTO knowledge_commands(project_id,actor_id,request_id,input_hash,snapshot_id)
       VALUES('p','a','probe','hash','probe')`,
    );
    await assert.rejects(client.query(`DELETE FROM ${table}`), refusedByGuard, table);
    await client.query('ROLLBACK');
  }

  assert.deepEqual(
    await rows(
      client,
      `SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL`,
      [consolidationTables],
    ),
    [],
  );
  assert.deepEqual(
    await rows(
      client,
      `SELECT proname FROM pg_proc
       WHERE pronamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())
         AND proname LIKE 'consolidation%'`,
    ),
    [],
  );
  assert.deepEqual(
    await rows(client, "SELECT version FROM component_migrations WHERE component='consolidation'"),
    [],
  );
  // Pinned definitions, policies and recipes are history, not records of work.
  for (const [name, version] of retiredVersions)
    assert.equal(
      (
        await rows(
          client,
          `SELECT 1 FROM wf_definitions d JOIN wf_success_states s ON s.workflow=d.name AND s.version=d.version
           WHERE d.name=$1 AND d.version=$2`,
          [name, version],
        )
      ).length,
      1,
      `${name}@${version} stays pinned`,
    );
  assert.equal(
    (
      await rows(
        client,
        "SELECT 1 FROM wf_execution_policies WHERE workflow='experiment' AND version=1",
      )
    ).length,
    1,
  );
  for (const [type, version] of retiredRecipes)
    assert.equal(
      (
        await rows(client, 'SELECT 1 FROM context_recipes WHERE type=$1 AND version=$2', [
          type,
          version,
        ])
      ).length,
      1,
      `${type}@${version} stays pinned`,
    );
  // Sessions measures the history project's budget as the census predicted (C12): 1 ms of each
  // survivor's session, and 5 of the service work kept.
  assert.deepEqual(
    (await app.ctx.sessions.usage(seed.history)).budgets.map((budget) => [
      budget.scopeId,
      budget.exceeded,
      budget.used.wallMs,
    ]),
    [[seed.history.projectId, [], 18]],
  );

  // Every flow that can start still does, and nothing left is on an unregistered version.
  const { tasks, experiments, research, reflections, workflows } = app.ctx;
  const input = { goal: 'Still works.', checks: ['It runs.'] };
  const scratch = await tasks.create(live, { ...input, title: 'Scratch', requestId: 'scratch' });
  assert.equal(scratch.workflow.version, 2);
  const git = await tasks.create(live, {
    ...input,
    title: 'Git',
    workspace: 'git',
    requestId: 'git',
  });
  assert.equal(git.workflow.version, 3);
  const work = await tasks.create(live, {
    ...input,
    title: 'Work 1',
    type: 'task.work',
    typeVersion: 1,
    requestId: 'work-1',
  });
  assert.deepEqual([work.type, work.typeVersion], ['task.work', 1]);
  const experiment = await experiments.create(live, {
    name: 'after-the-release',
    intent: 'Still testing.',
    requestId: 'experiment',
  });
  assert.equal(experiment.workflow.version, 5);
  await research.create(live, { name: 'After the release', requestId: 'research' });
  // The retired open wave held the project's only open-wave slot.
  await reflections.create(live, { requestId: 'wave' });
  assert.deepEqual((await workflows.overview(live)).unavailable, []);
  // The history project's survivors are raw rows no owner could describe; read their versions.
  assert.deepEqual(
    await rows(
      client,
      `SELECT id FROM wf_instances i JOIN unnest($1::text[], $2::int[]) AS r(workflow, version)
         ON r.workflow=i.workflow AND r.version=i.version`,
      [retiredVersions.map(([name]) => name), retiredVersions.map(([, version]) => version)],
    ),
    [],
  );
});

test('the retirement migrations reach the same end state in whichever order components run', async (t) => {
  const { recorded, restore } = recordMigrations(t);
  const prepared: Prepared[] = [];
  try {
    prepared.push(await prepare(t));
  } finally {
    restore();
  }
  prepared.push(await prepare(t), await prepare(t));
  const listed = retirementMigrations.map(([component, version]) => ({ component, version }));
  // Components migrate in any order, but each runs its own versions in ascending order.
  const components = [...new Set(listed.map(({ component }) => component))];
  const inOrder = (order: string[]) =>
    order.flatMap((component) =>
      listed
        .filter((migration) => migration.component === component)
        .sort((a, b) => a.version - b.version),
    );
  const orders = [
    // Reviews and Context Builder do not inject Workflows, so they may migrate before it.
    inOrder([
      ...components.filter((component) => ['reviews', 'context_builder'].includes(component)),
      ...components.filter((component) => !['reviews', 'context_builder'].includes(component)),
    ]),
    inOrder(components),
    inOrder([...components].reverse()),
  ];
  const states: Record<string, unknown>[] = [];
  for (const [index, order] of orders.entries()) {
    const { directory, client, seed } = prepared[index]!;
    const state = await openState(directory);
    for (const { component, version } of order)
      await state.migrate(component, [{ version, sql: recorded.get(key(component, version))! }]);
    let text = JSON.stringify({
      ...(await snapshot(client, [...deletedFrom, 'wf_retired_instances', 'component_migrations'])),
      consolidation: await rows(
        client,
        'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL',
        [consolidationTables],
      ),
    });
    // Each database bootstrapped its own projects; everything else in these tables is seeded.
    for (const [id, placeholder] of [
      [seed.live.projectId, 'LIVE_PROJECT'],
      [seed.live.actorId, 'LIVE_ACTOR'],
      [seed.history.projectId, 'HISTORY_PROJECT'],
      [seed.history.actorId, 'HISTORY_ACTOR'],
    ])
      text = text.replaceAll(id, placeholder);
    assert.deepEqual(await ledger(client), expectedLedger, `order ${index + 1}`);
    assert.deepEqual(await disabledTriggers(client), [], `order ${index + 1}`);
    states.push(
      Object.fromEntries(
        Object.entries(JSON.parse(text) as Record<string, unknown[]>).map(([table, contents]) => [
          table,
          contents.map((row) => JSON.stringify(row)).sort(),
        ]),
      ),
    );
  }
  for (const index of [1, 2])
    for (const table of Object.keys(states[0]!))
      assert.deepEqual(states[index]![table], states[0]![table], `order ${index + 1}: ${table}`);
});

test('a database the release would leave inconsistent is refused before any component commits', async (t) => {
  const { recorded, restore } = recordMigrations(t);
  try {
    await prepare(t);
  } finally {
    restore();
  }
  const scenarios: [
    label: string,
    refusal: RegExp,
    seed: (client: pg.Client, seed: Seed) => Promise<unknown>,
  ][] = [
    [
      'a live session of a retired instance',
      /a live session serves a retired instance/,
      async (client, { history }) =>
        await insert(client, 'worker_sessions', {
          id: 's-live-r-task1',
          project_id: history.projectId,
          actor_id: history.actorId,
          instance_id: 'r-task1',
          revision: 1,
          owner_hash: 'fixture-owner',
          runner_id: 'fixture-runner',
          request_id: 's-live-r-task1',
          token_hash: 'token-live-r-task1',
          fingerprint: 'hash',
          status: 'active',
          session_json: {},
        }),
    ],
    [
      'a surviving research cycle staged on a retired wave',
      /a surviving research cycle is staged on a retired reflection/,
      async (client, { history }) => {
        await insert(client, 'wf_instances', {
          id: 'l-res6b',
          project_id: history.projectId,
          workflow: 'research',
          version: 6,
          state: 'reflecting',
          revision: 1,
          data_json: {},
          created_at: at,
          updated_at: at,
        });
        await insert(client, 'research_cycles', {
          id: 'l-res6b',
          project_id: history.projectId,
          record: {},
          reflection_id: 'r-wave1',
        });
      },
    ],
    [
      'a format 1 review of a surviving task',
      /a format 1 review has a surviving subject/,
      async (client, { history }) =>
        await insert(client, 'reviews', {
          id: 'v1-l-task2',
          project_id: history.projectId,
          subject_id: 'l-task2',
          subject_revision: 1,
          producer_id: history.actorId,
          artifact_ids: [],
          criteria: ['The work is complete.'],
          manifest: {},
          snapshot_hash: 'hash-v1-l-task2',
          status: 'requested',
          created_at: at,
          format_version: 1,
          administrative_actor_id: history.actorId,
          pinned_input_ids: [],
        }),
    ],
    [
      'graph evidence of a surviving experiment',
      /graph evidence belongs to a surviving experiment/,
      async (client) =>
        await insert(client, 'experiment_evidence', {
          id: 'e-graph-l-exp5',
          experiment_id: 'l-exp5',
          attempt_index: 1,
          role: 'graph',
          path: 'graph.json',
          sequence: 2,
          record: { role: 'graph', experimentId: 'l-exp5' },
        }),
    ],
  ];
  const { directory, client, seed } = await prepare(t);
  // Whichever retirement migration the plugin order runs first refuses on its own. State
  // reports any constraint alike, so the texts run here directly, to read which one refused.
  // Each scenario is added and taken back in one transaction on the same prepared database.
  for (const [label, refusal, extra] of scenarios) {
    await client.query('BEGIN');
    await extra(client, seed);
    for (const [component, version] of retirementMigrations) {
      await client.query('SAVEPOINT migration');
      await assert.rejects(
        client.query(recorded.get(key(component, version))!),
        (error: Error) => refusal.test(error.message),
        `${label}: ${key(component, version)}`,
      );
      await client.query('ROLLBACK TO SAVEPOINT migration');
    }
    await client.query('ROLLBACK');
  }
  // So the release fails to boot, and leaves the database as the previous image left it. Every
  // scenario is refused by every migration above, so one of them stands for all at boot.
  const [label, , extra] = scenarios[0]!;
  await extra(client, seed);
  const before = await snapshot(client);
  const events = await rows(client, 'SELECT count(*)::int AS n FROM events');
  await assert.rejects(createApp({ directory }), { code: 'plugin_unavailable' }, label);
  const applied = await rows<{ key: string }>(
    client,
    "SELECT component || '@' || version AS key FROM component_migrations",
  );
  assert.deepEqual(
    retirementMigrations
      .map(([component, version]) => key(component, version))
      .filter((name) => applied.some((row) => row.key === name)),
    [],
    label,
  );
  assert.deepEqual(
    await rows(client, "SELECT to_regclass('wf_retired_instances') AS ledger"),
    [{ ledger: null }],
    label,
  );
  assert.deepEqual(await snapshot(client), before, label);
  assert.deepEqual(await rows(client, 'SELECT count(*)::int AS n FROM events'), events, label);
  assert.deepEqual(await disabledTriggers(client), [], label);
});
