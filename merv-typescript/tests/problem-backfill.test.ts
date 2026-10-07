import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService, type Caller, type MigrationRecord } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { PaperService } from '@merv/paper';
import { postgresMigrations as projectContext } from '../packages/scope/src/project-context.postgres.js';
import { openState } from './fixtures/state.js';
import { backfill, problemFromSummary, type BackfillLine } from '../deploy/problem-backfill.mjs';

// The owner's decision (2026-10-07): before scope@10 drops projects.summary, every project whose
// summary is its only description gets it as a draft Paper Problem, through Paper's own service.

const issuer = 'https://identity.example/auth/v1';
const summaryOf = (heading: string) => `Intro sentence about the work.

## Problem
Models forget ${heading}.

## Background
Earlier work tried X.

## Scope
Only small models.

## Goals
### Primary
Reduce forgetting.

## Constraints:
Two GPUs.`;

/** A database at the release before scope@10, with each kind of project production holds. */
async function fixture() {
  const state = await openState();
  // The running release's Scope does not know scope@10 yet.
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'scope'
        ? Object.fromEntries(
            Object.entries(migrations as MigrationRecord).filter(([version]) => version !== '10'),
          )
        : migrations,
    );
  const scope = await createService(new ProjectScope(state));
  const paper = await createService(new PaperService(state, scope, {} as never));
  const login = async (subject: string) =>
    await scope.members.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  const owned = async (subject: string) => {
    const principal = await login(subject);
    const project = await scope.members.createProject(principal, {
      name: subject,
      requestId: `create-${subject}`,
    });
    return await scope.caller(principal, project.id);
  };
  const withSections = await owned('alice');
  const withExisting = await owned('carol');
  const blank = await owned('dave');
  const boot = await scope.credentials.bootstrap({ projectName: 'Bootstrapped', actorName: 'Op' });
  const unowned: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  // The project whose Problem was already written keeps it.
  await paper.patch(withExisting, {
    kind: 'problem',
    expectedRevision: 0,
    changes: [{ id: 'problem', content: 'Already written.' }],
    requestId: 'existing',
  });
  await state.transaction(async (tx) => {
    for (const [caller, summary] of [
      [withSections, summaryOf('alice')],
      [withExisting, 'Carol’s old summary.'],
      [blank, '   '],
      [unowned, 'A plain description with no headings.'],
    ] as const)
      await tx.run('UPDATE projects SET summary=? WHERE id=?', summary, caller.projectId);
    // An immutable receipt of the old project-context command, as production holds 38.
    await tx.run(
      'INSERT INTO project_context_commands(project_id,actor_id,request_id,input_hash,result_json) VALUES(?,?,?,?,?)',
      withSections.projectId,
      withSections.actorId,
      'old',
      'hash',
      '{}',
    );
  });
  const dropSummaries = async () => await migrate('scope', { 10: projectContext[10]! });
  return {
    state,
    scope,
    paper,
    withSections,
    withExisting,
    unowned,
    dropSummaries,
  };
}

test('a summary’s recognised headings become the Problem’s sections, and the rest its first', () => {
  const { sections, mapping } = problemFromSummary(summaryOf('alice'));
  assert.deepEqual(sections, {
    problem:
      'Intro sentence about the work.\n\nModels forget alice.\n\n### Background\nEarlier work tried X.',
    scope: 'Only small models.',
    goals: '### Primary\nReduce forgetting.',
    constraints: 'Two GPUs.',
  });
  assert.deepEqual(
    mapping.map(({ heading, to }) => [heading, to]),
    [
      ['(text before any heading)', 'problem'],
      ['Problem', 'problem'],
      ['Background', 'problem'],
      ['Scope', 'scope'],
      ['Goals', 'goals'],
      ['Constraints:', 'constraints'],
    ],
  );
  assert.deepEqual(problemFromSummary('# Notes\n```\n## Scope\n```'), {
    sections: { problem: '### Notes\n```\n## Scope\n```', scope: '', goals: '', constraints: '' },
    mapping: [{ heading: 'Notes', to: 'problem', chars: 26 }],
  });
});

test('the backfill copies orphan summaries into draft Problems once, and only then may scope@10 drop them', async (t) => {
  const f = await fixture();
  t.after(async () => await f.state.close());
  const problem = async (caller: Caller) => (await f.paper.document(caller, 'problem')).current;
  const columns = async () =>
    (
      await f.state.read(
        async (sql) =>
          await sql.all<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects' ORDER BY column_name",
          ),
      )
    ).map((row) => row.column_name);
  assert.ok((await columns()).includes('summary'));

  // scope@10 refuses while a project's summary is its only description.
  await assert.rejects(f.dropSummaries(), /Migration scope\/10 failed/);
  assert.ok((await columns()).includes('summary'));

  // A dry run rehearses every write and keeps none; it never prints a summary's text.
  const rehearsed: (BackfillLine | { totals: unknown })[] = [];
  const dry = await backfill({ ...f, dryRun: true, log: (line) => rehearsed.push(line) });
  assert.deepEqual(dry, { projects: 3, written: 2, skipped: 1, failed: 0, dryRun: true });
  assert.doesNotMatch(JSON.stringify(rehearsed), /forget|plain description|old summary/);
  const lines = rehearsed.slice(0, -1) as BackfillLine[];
  assert.deepEqual(
    lines.map((line) => [line.projectId, line.summaryChars, line.as, line.result]),
    [
      [f.withSections.projectId, summaryOf('alice').length, 'operator', 'would write'],
      [
        f.withExisting.projectId,
        'Carol’s old summary.'.length,
        'operator',
        'skipped: has a Problem',
      ],
      [f.unowned.projectId, 37, 'paper service', 'would write'],
    ],
  );
  assert.equal(lines[0]!.mapping.length, 6);
  assert.equal((await problem(f.withSections)).revision, 0);
  assert.equal(
    (await f.state.read(async (sql) =>
      sql.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM actors WHERE service_owner='paper'"),
    ))!.n,
    0,
    'A dry run creates no service actor',
  );

  const written = await backfill({ ...f });
  assert.deepEqual(written, { projects: 3, written: 2, skipped: 1, failed: 0, dryRun: false });
  const alice = await problem(f.withSections);
  assert.equal(alice.revision, 1);
  assert.equal(alice.updatedBy, f.withSections.actorId, 'Written as the project’s operator');
  assert.deepEqual(
    alice.sections.map(({ id, title, content }) => [id, title, content]),
    [
      [
        'problem',
        'Problem',
        'Intro sentence about the work.\n\nModels forget alice.\n\n### Background\nEarlier work tried X.',
      ],
      ['scope', 'Scope', 'Only small models.'],
      ['goals', 'Goals', '### Primary\nReduce forgetting.'],
      ['constraints', 'Constraints', 'Two GPUs.'],
    ],
  );
  // A draft: nothing is published.
  assert.equal((await f.paper.document(f.withSections, 'problem')).published, null);
  const plain = await problem(f.unowned);
  assert.deepEqual(
    plain.sections.map(({ id, content }) => [id, content]),
    [
      ['problem', 'A plain description with no headings.'],
      ['scope', ''],
      ['goals', ''],
      ['constraints', ''],
    ],
  );
  const service = await f.scope.serviceActor('paper', f.unowned.projectId);
  assert.equal(plain.updatedBy, service.actorId, 'A project with no operator: Paper’s service');
  const carol = await problem(f.withExisting);
  assert.equal(carol.revision, 1);
  assert.equal(carol.sections[0]!.content, 'Already written.');

  // Idempotent: a second run finds every Problem written.
  assert.deepEqual(await backfill({ ...f }), {
    projects: 3,
    written: 0,
    skipped: 3,
    failed: 0,
    dryRun: false,
  });
  assert.equal((await problem(f.withSections)).revision, 1);

  // Now the release with scope@10 drops the summary, the receipts and their guards.
  await f.dropSummaries();
  assert.deepEqual(
    (await columns()).filter((name) => ['summary', 'context_revision'].includes(name)),
    [],
  );
  const left = await f.state.read(
    async (sql) =>
      await sql.get<{ receipts: string | null; guards: number }>(
        `SELECT to_regclass('project_context_commands')::text AS receipts,
          (SELECT COUNT(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname=current_schema() AND p.proname LIKE 'project_context_commands%') AS guards`,
      ),
  );
  assert.deepEqual(left, { receipts: null, guards: 0 });
  // Scope still reads its projects without them.
  assert.equal((await f.scope.project(f.withSections)).id, f.withSections.projectId);
});
