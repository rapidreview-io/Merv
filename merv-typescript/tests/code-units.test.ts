import { createService, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code/service';
import { workBranch } from '@merv/code/store/refs';

const issuer = 'https://identity.example/auth/v1';
const oid = (char: string) => char.repeat(40);
const postgresUrl = process.env.MERV_TEST_POSTGRES_URL;
const backends = ['sqlite', 'postgres'] as const;
const optional = (backend: (typeof backends)[number]) => ({
  skip: backend === 'postgres' && !postgresUrl,
});

const definition: WorkflowDefinition = {
  name: 'build',
  version: 1,
  initial: 'building',
  states: ['building', 'built'],
  terminal: ['built'],
  edges: [{ from: 'building', action: 'finish', to: 'built' }],
};
const policy: WorkflowPolicy = {
  successStates: ['built'],
  actions: [
    {
      name: 'finish',
      tool: 'build.finish',
      states: ['building'],
      transitions: ['finish'],
      instruction: 'Finish the build.',
      check: () => {},
    },
  ],
};

async function fixture(t: TestContext, backend: (typeof backends)[number], withUnits = true) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-units-'));
  const schema = `code_units_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(join(directory, 'state.sqlite'))
      : await PostgresState.open({ connectionString: postgresUrl!, schema });
  const migrate = state.migrate.bind(state);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  /** Code as it was before units existed, or as it is now. */
  const open = async (units: boolean) => {
    let skipped = false;
    state.migrate = async (component, migrations) => {
      if (component === 'code_units' && !units) skipped = true;
      else await migrate(component, migrations);
    };
    try {
      const service = new CodeService(state, scope, sessions, artifacts, workflows);
      await service.initialize();
      assert.equal(skipped, !units);
      return service;
    } finally {
      state.migrate = migrate;
    }
  };
  let code = await open(withUnits);
  t.after(async () => {
    await code.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
    if (backend === 'sqlite') return;
    const pool = new Pool({ connectionString: postgresUrl });
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  const identity = (subject: string) => ({
    issuer,
    subject,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const principal = await scope.acceptVerifiedIdentity(identity('owner'));
  const project = await scope.createProject(principal, { name: 'Units', requestId: 'one' });
  const admin = await scope.caller(principal, project.id);
  await workflows.register(definition, policy);
  let sequence = 0;
  return {
    state,
    scope,
    workflows,
    principal,
    project,
    admin,
    identity,
    get code() {
      return code;
    },
    reopen: async () => {
      await code.close();
      code = await open(true);
    },
    request: () => `request-${++sequence}`,
    refused: async (sql: string, ...values: string[]) =>
      await assert.rejects(
        state.transaction(async (tx) => await tx.run(sql, ...values)),
        // SQLite reports the trigger's words; PostgreSQL reports a refused constraint.
        /immutable|retained|constraint/i,
        sql,
      ),
  };
}

for (const backend of backends) {
  test(
    `${backend}: the unit tables arrive beside existing Code rows and hold their write-once sections`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend, false);
      const work = await f.workflows.start(f.admin, { workflow: 'build', requestId: 'start' });
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "INSERT INTO code_commands (id,project_id,session_id,actor_id,request_id,input_hash,command_json,status) VALUES ('command',?,'session','actor','request','hash','{}','queued')",
            f.project.id,
          ),
      );
      await f.reopen();
      const commands = await f.state.read(
        async (sql) => await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM code_commands'),
      );
      assert.equal(Number(commands?.n), 1);

      await f.code.bindLocal(f.admin, {
        repositoryId: 'runner-repository',
        mainOid: oid('a'),
        requestId: f.request(),
      });
      const declared = await f.state.transaction(
        async (tx) => await f.code.declareUnit(f.admin, work.id, tx),
      );
      assert.deepEqual(
        [declared.unitId, declared.workflow, declared.version, declared.base, declared.acceptance],
        [work.id, 'build', 1, null, null],
      );
      assert.deepEqual(
        await f.state.transaction(async (tx) => await f.code.declareUnit(f.admin, work.id, tx)),
        declared,
        'declaring again changes nothing',
      );
      await assert.rejects(
        f.state.transaction(async (tx) => await f.code.declareUnit(f.admin, 'missing', tx)),
        { code: 'code_unit_not_found' },
      );

      // Each write-once section is filled exactly once, by whoever gets there first.
      const write = async (sql: string, ...values: string[]) =>
        await f.state.transaction(async (tx) => await tx.run(sql, ...values, work.id));
      const base = JSON.stringify({
        formatVersion: 1,
        kind: 'main',
        reference: oid('a'),
        repositoryId: 'runner-repository',
        dependencies: [],
        sources: [],
        main: { oid: oid('a'), operationId: 'operation' },
      });
      const acceptance = JSON.stringify({
        formatVersion: 1,
        unitId: work.id,
        workflow: 'build',
        version: 1,
        terminalRevision: 1,
        submissionRef: 'submission',
        reviewRef: 'review',
        acceptedBy: f.admin.actorId,
        code: null,
        storage: 'none',
      });
      await f.refused("UPDATE code_units SET base_json='{}' WHERE unit_id=?", work.id);
      await write(
        "UPDATE code_units SET base_json=?,base_hash='h',base_lease_id='lease',based_at='now' WHERE unit_id=?",
        base,
      );
      await write(
        "UPDATE code_units SET acceptance_json=?,acceptance_hash='h',accepted_at='now' WHERE unit_id=?",
        acceptance,
      );
      for (const sql of [
        'UPDATE code_units SET base_json=\'{"moved":1}\' WHERE unit_id=?',
        "UPDATE code_units SET base_lease_id='another' WHERE unit_id=?",
        "UPDATE code_units SET acceptance_hash='other' WHERE unit_id=?",
        "UPDATE code_units SET workflow='other' WHERE unit_id=?",
        'DELETE FROM code_units WHERE unit_id=?',
      ])
        await f.refused(sql, work.id);
      for (const sql of [
        "UPDATE code_projects SET repository_id='another' WHERE project_id=?",
        "UPDATE code_projects SET binding_json='{}' WHERE project_id=?",
        'DELETE FROM code_projects WHERE project_id=?',
        "UPDATE code_operations SET result_json='{}' WHERE project_id=?",
        "UPDATE code_operations SET kind='other' WHERE project_id=?",
        'DELETE FROM code_operations WHERE project_id=?',
      ])
        await f.refused(sql, f.project.id);
      await f.state.transaction(
        async (tx) =>
          await tx.run(
            "INSERT INTO code_edges (project_id,source_ref,relation,target_ref,created_at) VALUES (?,'unit:a','based_on','main:b','now')",
            f.project.id,
          ),
      );
      await f.refused("UPDATE code_edges SET relation='other' WHERE project_id=?", f.project.id);
      await f.refused('DELETE FROM code_edges WHERE project_id=?', f.project.id);

      // The pinned migration text is stable across a restart.
      await f.reopen();
      const [unit] = (await f.code.status(f.admin)).units;
      // The branch is a pure function of the id, and is the name the mirror publishes under.
      assert.equal(unit.branch, workBranch(work.id));
      assert.deepEqual(unit.base, {
        unitId: work.id,
        kind: 'main',
        reference: oid('a'),
        sources: [],
        pinnedAt: 'now',
        leaseId: 'lease',
      });
      assert.deepEqual([unit.acceptance?.storage, unit.acceptance?.reference], ['none', null]);
    },
  );

  test(
    `${backend}: only a signed-in administrator binds the repository, and main moves by compare-and-set`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      assert.deepEqual(await f.code.status(f.admin), {
        project: null,
        store: null,
        operations: [],
        mirror: null,
        warnings: [],
        units: [],
        blockers: [],
      });
      const first = { repositoryId: 'runner-repository', mainOid: oid('a'), requestId: 'bind' };

      const issued = await f.scope.createKey(f.principal, { projectId: f.project.id });
      const machine = await f.scope.caller({
        kind: 'key',
        key: await f.scope.authenticateKey(issued.token),
      });
      await assert.rejects(f.code.bindLocal(machine, first), { code: 'code_human_required' });
      const reader = await f.scope.acceptVerifiedIdentity(f.identity('reader'));
      await f.scope.addMember(f.principal, f.project.id, { subject: 'reader', role: 'reader' });
      await assert.rejects(
        f.code.bindLocal(await f.scope.caller(reader, f.project.id), first),
        (error: { status?: number }) => error.status === 403,
      );
      for (const invalid of [
        { ...first, mainOid: 'main' },
        { ...first, repositoryId: 'two words' },
        { ...first, requestId: '' },
        { ...first, extra: true },
      ])
        await assert.rejects(f.code.bindLocal(f.admin, invalid as typeof first), {
          code: 'invalid_code_input',
        });
      await assert.rejects(f.code.bindLocal(f.admin, { ...first, expectedMainOid: oid('a') }), {
        code: 'code_main_changed',
      });

      const bound = await f.code.bindLocal(f.admin, first);
      assert.deepEqual(
        [bound.mode, bound.repositoryId, bound.main.oid, bound.durability, bound.boundBy],
        ['local', 'runner-repository', oid('a'), 'legacy-local', f.admin.actorId],
      );
      assert.deepEqual(await f.code.bindLocal(f.admin, first), bound, 'the same request replays');
      await assert.rejects(f.code.bindLocal(f.admin, { ...first, mainOid: oid('b') }), {
        code: 'request_conflict',
      });

      const move = { ...first, mainOid: oid('b'), requestId: 'move' };
      await assert.rejects(f.code.bindLocal(f.admin, move), { code: 'code_main_changed' });
      await assert.rejects(f.code.bindLocal(f.admin, { ...move, expectedMainOid: oid('c') }), {
        code: 'code_main_changed',
      });
      await assert.rejects(
        f.code.bindLocal(f.admin, {
          ...move,
          repositoryId: 'another-repository',
          expectedMainOid: oid('a'),
        }),
        { code: 'code_rebind_required' },
      );
      const moved = await f.code.bindLocal(f.admin, { ...move, expectedMainOid: oid('a') });
      assert.deepEqual(
        [moved.main.oid, moved.boundAt, moved.repositoryId],
        [oid('b'), bound.boundAt, bound.repositoryId],
      );
      // A stale mover that read the old main cannot take it back.
      await assert.rejects(
        f.code.bindLocal(f.admin, {
          ...first,
          expectedMainOid: oid('a'),
          requestId: 'stale',
        }),
        { code: 'code_main_changed' },
      );
      assert.deepEqual((await f.code.status(f.admin)).project, moved);
      assert.deepEqual(
        (await f.state.events(f.project.id))
          .filter((event) => event.type === 'code.local_bound')
          .map((event) => [event.data.mainOid, event.data.previousMainOid]),
        [
          [oid('a'), null],
          [oid('b'), oid('a')],
        ],
      );

      // Reads are the project's own.
      const work = await f.workflows.start(f.admin, { workflow: 'build', requestId: 'start' });
      await f.state.transaction(async (tx) => await f.code.declareUnit(f.admin, work.id, tx));
      const elsewhere = await f.scope.createProject(f.principal, {
        name: 'Elsewhere',
        requestId: 'two',
      });
      const outsider = await f.scope.caller(f.principal, elsewhere.id);
      await assert.rejects(f.code.unit(outsider, work.id), { code: 'code_unit_not_found' });
      assert.deepEqual(await f.code.status(outsider), {
        project: null,
        store: null,
        operations: [],
        mirror: null,
        warnings: [],
        units: [],
        blockers: [],
      });
      assert.equal((await f.code.unit(f.admin, work.id)).unitId, work.id);
    },
  );
}
