import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createService,
  getArtifacts,
  MAX_ARTIFACT_IDS,
  type Artifact,
  type Caller,
} from '@merv/contracts';
import { DiskBlobs } from '@merv/blobs';
import { ProjectScope } from '@merv/scope';
import { ArtifactStore } from '@merv/artifacts';
import { createApp } from './fixtures/app.js';
import { openState, stateConfig } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-list-'));
  const state = await openState(directory);
  t.after(async () => {
    await state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const boot = await scope.bootstrap({ projectName: 'Pages', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const other = await scope.bootstrap({ projectName: 'Other', actorName: 'Other owner' });
  const outsider: Caller = { actorId: other.actor.id, projectId: other.project.id };
  return { state, scope, artifacts, caller, outsider };
}

/**
 * Rows art_00001..art_<count>, created ten to a second, so pages cross ties on created_at; newest
 * first is highest n first. Every third row is session_a's, the next session_b's, the rest none.
 */
async function seed(f: Awaited<ReturnType<typeof fixture>>, count: number, caller = f.caller) {
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO artifacts(id,project_id,created_by,title,media_type,hash,size,created_at,session_id)
       SELECT 'art_' || lpad(n::text, 5, '0'), ?, ?, 'Row ' || n, 'text/plain', repeat('0', 64), 1,
         to_char(timestamp '2026-09-01' + (n / 10) * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         CASE n % 3 WHEN 0 THEN 'session_a' WHEN 1 THEN 'session_b' END
       FROM generate_series(1, ?) AS n`,
      caller.projectId,
      caller.actorId,
      count,
    ),
  );
}
const id = (n: number) => `art_${String(n).padStart(5, '0')}`;
/** The ids from n down to 1, keeping those `keep` accepts. */
const newestFirst = (n: number, keep = (_: number) => true) =>
  Array.from({ length: n }, (_, i) => n - i)
    .filter(keep)
    .map(id);
const ids = (artifacts: Artifact[]) => artifacts.map((artifact) => artifact.id);

test('list pages newest first across ties with no gap or duplicate', async (t) => {
  const f = await fixture(t);
  await seed(f, 1205);
  const first = await f.artifacts.list(f.caller);
  assert.equal(first.length, 1000);
  const second = await f.artifacts.list(f.caller, { before: first.at(-1)!.id });
  assert.deepEqual([...ids(first), ...ids(second)], newestFirst(1205));
  // The boundary splits the ten rows created in one second.
  assert.equal(first.at(-1)!.createdAt, second[0].createdAt);
  assert.deepEqual(await f.artifacts.list(f.caller, { before: id(1) }), []);
  // Small pages tile the same order.
  const paged: string[] = [];
  for (let before: string | undefined; ;) {
    const page = await f.artifacts.list(f.caller, { before, limit: 7 });
    paged.push(...ids(page));
    if (page.length < 7) break;
    before = page.at(-1)!.id;
  }
  assert.deepEqual(paged, newestFirst(1205));
  // A session's own outputs page the same way.
  const session = await f.artifacts.list(f.caller, { session: 'session_a', limit: 300 });
  const rest = await f.artifacts.list(f.caller, {
    session: 'session_a',
    before: session.at(-1)!.id,
  });
  assert.deepEqual(
    [...ids(session), ...ids(rest)],
    newestFirst(1205, (n) => n % 3 === 0),
  );
  assert.deepEqual(await f.artifacts.list(f.caller, { session: 'session_c' }), []);
  // Another project's list sees none of them.
  assert.deepEqual(await f.artifacts.list(f.outsider), []);
});

test('list refuses a cursor outside the project and malformed queries', async (t) => {
  const f = await fixture(t);
  await seed(f, 3);
  const foreign = await f.artifacts.create(f.outsider, { title: 'Foreign', content: 'theirs' });
  for (const before of ['art_unknown', foreign.id])
    await assert.rejects(f.artifacts.list(f.caller, { before }), {
      code: 'not_found',
      status: 404,
    });
  for (const query of [
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { limit: '10' },
    { before: '' },
    { before: 7 },
    { session: '' },
  ])
    await assert.rejects(f.artifacts.list(f.caller, query as never), {
      code: 'invalid_artifact',
      status: 400,
    });
  // Inside a transaction the list sees that transaction's own rows.
  await f.state.transaction(async (tx) => {
    const fresh = await f.artifacts.create(f.caller, { title: 'Fresh', content: 'new' }, tx);
    assert.deepEqual(ids(await f.artifacts.list(f.caller, { limit: 1 }, tx)), [fresh.id]);
    assert.deepEqual(await f.artifacts.getMany(f.caller, [fresh.id], tx), [fresh]);
  });
});

test('list queries walk the project and session indexes', async (t) => {
  const f = await fixture(t);
  await seed(f, 50);
  const indexes = await f.state.read((sql) =>
    sql.all<{ name: string }>(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND tablename='artifacts' ORDER BY indexname",
    ),
  );
  assert.deepEqual(
    indexes.map((index) => index.name),
    [
      'artifacts_pkey',
      'artifacts_project_created',
      'artifacts_project_object',
      'artifacts_project_session',
    ],
  );
  // EXPLAIN the statements list itself sends, with and without a session and a cursor.
  const plans = await f.state.transaction(async (tx) => {
    await tx.run('SET LOCAL enable_seqscan = off');
    const all = t.mock.method(tx, 'all');
    const plan = async (query: { before?: string; session?: string }) => {
      all.mock.resetCalls();
      await f.artifacts.list(f.caller, query, tx);
      assert.equal(all.mock.callCount(), 1);
      const [sql, ...params] = all.mock.calls[0].arguments;
      return (await tx.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, ...params))
        .map((row) => row['QUERY PLAN'])
        .join('\n');
    };
    return {
      project: await plan({}),
      paged: await plan({ before: id(10) }),
      session: await plan({ session: 'session_a' }),
      sessionPaged: await plan({ session: 'session_a', before: id(10) }),
    };
  });
  for (const name of ['project', 'paged'] as const)
    assert.match(plans[name], /Index Scan Backward using artifacts_project_created/, plans[name]);
  for (const name of ['session', 'sessionPaged'] as const)
    assert.match(plans[name], /Index Scan Backward using artifacts_project_session/, plans[name]);
  for (const plan of Object.values(plans)) assert.doesNotMatch(plan, /Sort/, plan);
});

test('getMany authorises once and answers in input order, duplicates kept', async (t) => {
  const f = await fixture(t);
  await seed(f, 60);
  const require = t.mock.method(f.scope, 'require');
  const wanted = [id(7), ...newestFirst(50), id(7), id(60)];
  const many = await f.artifacts.getMany(f.caller, wanted);
  assert.equal(require.mock.callCount(), 1);
  assert.deepEqual(ids(many), wanted);
  // Each is exactly what get answers: metadata, never bytes.
  assert.deepEqual(many[0], await f.artifacts.get(f.caller, id(7)));
  assert.deepEqual(await f.artifacts.getMany(f.caller, []), []);

  const foreign = await f.artifacts.create(f.outsider, { title: 'Foreign', content: 'theirs' });
  for (const missing of ['art_unknown', foreign.id])
    await assert.rejects(f.artifacts.getMany(f.caller, [id(1), missing, id(2)]), {
      code: 'not_found',
      status: 404,
    });
  await assert.rejects(f.artifacts.getMany(f.outsider, [id(1)]), { code: 'not_found' });
  for (const bad of [Array(2001).fill(id(1)), [id(1), ''], [id(1), 5], 'art_00001'])
    await assert.rejects(f.artifacts.getMany(f.caller, bad as never), {
      code: 'invalid_artifact',
      status: 400,
    });
  assert.equal((await f.artifacts.getMany(f.caller, Array(2000).fill(id(1)))).length, 2000);
});

test('getArtifacts looks up any number of ids, MAX_ARTIFACT_IDS at a time', async (t) => {
  const f = await fixture(t);
  await seed(f, 3);
  const getMany = t.mock.method(f.artifacts, 'getMany');
  const wanted = Array.from({ length: 2 * MAX_ARTIFACT_IDS + 1 }, (_, n) => id((n % 3) + 1));
  assert.deepEqual(ids(await getArtifacts(f.artifacts, f.caller, wanted)), wanted);
  assert.deepEqual(
    getMany.mock.calls.map((call) => call.arguments[1].length),
    [MAX_ARTIFACT_IDS, MAX_ARTIFACT_IDS, 1],
  );
  assert.deepEqual(await getArtifacts(f.artifacts, f.caller, []), []);
  await assert.rejects(getArtifacts(f.artifacts, f.caller, [...wanted, 'art_unknown']), {
    code: 'not_found',
  });
});

test('artifact.list pages through the tool', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-artifact-list-tool-'));
  const app = await createApp({
    directory,
    config: {
      plugins: [
        { id: 'state', name: '@merv/state', config: stateConfig(directory) },
        { id: 'scope', name: '@merv/scope' },
        { id: 'blobs', name: '@merv/blobs', config: { root: join(directory, 'blobs') } },
        { id: 'artifacts', name: '@merv/artifacts' },
        { id: 'tools', name: '@merv/api/tools-plugin' },
        { id: 'artifact-tools', name: '@merv/artifacts/tools' },
      ],
    },
  });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Tool', actorName: 'Owner' });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  for (const n of [1, 2, 3])
    await app.ctx.artifacts.create(caller, { title: `N${n}`, content: 'x' });
  const list = async (input: object) =>
    (await app.ctx.tools.call('artifact.list', caller, input)) as (Artifact & {
      downloadAvailable: boolean;
    })[];
  const all = await list({});
  assert.deepEqual(ids(all), ids(await app.ctx.artifacts.list(caller)));
  assert.equal(all.length, 3);
  assert.equal(typeof all[0].downloadAvailable, 'boolean');
  const first = await list({ limit: 2 });
  assert.deepEqual(ids(first), ids(all).slice(0, 2));
  assert.deepEqual(ids(await list({ before: first[1].id, limit: 2 })), ids(all).slice(2));
  await assert.rejects(list({ limit: 1001 }), { code: 'invalid_input' });
  await assert.rejects(list({ session: 'session_a' }), { code: 'invalid_input' });
  await assert.rejects(list({ before: 'art_unknown' }), { code: 'not_found' });
});
