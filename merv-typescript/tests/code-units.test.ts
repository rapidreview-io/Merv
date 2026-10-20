import { CodeService as CoreCodeService } from '@merv/code/service';
import { createService, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code-work/service';
import { CodeCommandService } from '@merv/code-work/commands';
import { workBranch } from '@merv/code/store/refs';
import { OperationJournal } from '../packages/code/src/request-journal.js';
import { openState } from './fixtures/state.js';
import { codeConfig, moveMain } from './fixtures/code-binding.js';
import { ReviewService } from '@merv/reviews';

const issuer = 'https://identity.example/auth/v1';
const oid = (char: string) => char.repeat(40);

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

async function fixture(t: TestContext, withUnits = true) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-units-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  let core: CoreCodeService;
  /** An older command store can exist before the research unit adapter is installed. */
  const open = async (units: boolean) => {
    core = await createService(
      new CoreCodeService(state, scope, codeConfig(join(directory, 'code'))),
    );
    const service = new CodeService(state, scope, sessions, workflows, reviews, core);
    if (units) await service.initialize();
    else {
      const commands = await createService(new CodeCommandService(state, scope, sessions));
      commands.close();
      assert.equal(
        await state.read((sql) =>
          sql.get(
            "SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='code_units'",
          ),
        ),
        undefined,
      );
    }
    return service;
  };
  let code = await open(withUnits);
  t.after(async () => {
    await code.close();
    await core.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const identity = (subject: string) => ({
    issuer,
    subject,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const principal = await scope.members.acceptVerifiedIdentity(identity('owner'));
  const project = await scope.members.createProject(principal, { name: 'Units', requestId: 'one' });
  const admin = await scope.caller(principal, project.id);
  const build = await workflows.register(definition, policy);
  let sequence = 0;
  return {
    state,
    scope,
    workflows,
    build,
    principal,
    project,
    admin,
    identity,
    get code() {
      return code;
    },
    reopen: async () => {
      await code.close();
      await core.close();
      code = await open(true);
    },
    request: () => `request-${++sequence}`,
    refused: async (sql: string, ...values: string[]) =>
      await assert.rejects(
        state.transaction(async (tx) => await tx.run(sql, ...values)),
        // A trigger or constraint refused it; PostgreSQL keeps the reason inside the store.
        { code: 'state_constraint' },
        sql,
      ),
  };
}

test('the unit tables arrive beside existing Code rows and hold their write-once sections', async (t) => {
  const f = await fixture(t, false);
  const work = await f.build.start(f.admin, { workflow: 'build', requestId: 'start' });
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

  await moveMain(f.state, f.project.id, oid('a'), {
    repositoryId: 'runner-repository',
    stored: false,
  });
  // A completed operation of the project's, as the journal keeps one.
  await f.state.transaction(
    async (tx) =>
      await new OperationJournal(tx, f.project.id, 'actor:fixture', 'bind', 'hash').complete(
        'cop_fixture',
        'local_bind',
        {},
        {},
        new Date().toISOString(),
      ),
  );
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
});

/** What Code's status says of a project its repository does not hold yet. */
const unhosted = {
  project: null,
  bases: [],
  landing: { enabled: false, reason: 'disabled', current: null, waiting: [], landed: [] },
  store: {
    hosted: false,
    objectFormat: null,
    rootOid: null,
    source: null,
    tips: [],
    diskBytes: 0,
    quotaBytes: 1024 ** 3,
    limits: { format: 1, denyGlobs: [], secretExemptGlobs: [], check: null },
  },
  operations: [],
  mirror: {
    state: 'off',
    repository: null,
    blockedBy: 'github_unconfigured',
    pending: 0,
    oldestPendingAt: null,
    lastError: null,
    blockedRefs: [],
  },
  warnings: [],
};

test("a project's Code reads are its own", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.code.status(f.admin), {
    ...unhosted,
    units: [],
    blockers: [],
  });
  await moveMain(f.state, f.project.id, oid('a'), { stored: false });
  // Reads are the project's own.
  const work = await f.build.start(f.admin, { workflow: 'build', requestId: 'start' });
  await f.state.transaction(async (tx) => await f.code.declareUnit(f.admin, work.id, tx));
  const elsewhere = await f.scope.members.createProject(f.principal, {
    name: 'Elsewhere',
    requestId: 'two',
  });
  const outsider = await f.scope.caller(f.principal, elsewhere.id);
  await assert.rejects(f.code.unit(outsider, work.id), { code: 'code_unit_not_found' });
  assert.deepEqual(await f.code.status(outsider), {
    ...unhosted,
    units: [],
    blockers: [],
  });
  assert.equal((await f.code.unit(f.admin, work.id)).unitId, work.id);
});
