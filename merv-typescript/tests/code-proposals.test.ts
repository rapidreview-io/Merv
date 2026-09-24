import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonical,
  type Caller,
  type CodeCommitCommand,
  type CodeCommitReceipt,
  type Data,
  type SessionWorkspace,
  type Transaction,
  type WorkflowDispatchAdmission,
  type WorkflowPolicy,
} from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { CodeCommandService } from '../packages/code-research/src/commands.js';
import { CodeProposalService } from '../packages/code-research/src/proposals.js';
import type { CodeProposalInput } from '../packages/code-research/src/types.js';
import { openState } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';

const oid = (digit: string) => digit.repeat(40);
const workspace: SessionWorkspace = {
  repositoryId: 'repository',
  workspaceId: 'workspace',
  mode: 'persistent',
  branch: 'codex/merv/work',
  baseOid: oid('a'),
  headOid: oid('a'),
  stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
};
const receipt = (command: CodeCommitCommand): CodeCommitReceipt => ({
  commandId: command.id,
  repositoryId: command.workspace.repositoryId,
  workspaceId: command.workspace.workspaceId,
  baseOid: command.workspace.baseOid,
  parentOid: command.expectedHead,
  headOid: oid('b'),
  treeOid: oid('c'),
  stats: { commitCount: 1, filesChanged: 2, insertions: 3, deletions: 4 },
});
const binding: WorkflowDispatchAdmission = { tool: 'domain.submit', input: { gate: 'code' } };

async function fixture(t: TestContext, options: { readOnly?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-code-proposals-'));
  let clock = Date.now(),
    poisoned = false;
  let state: PostgresState,
    scope: ProjectScope,
    workflows: WorkflowsService,
    events: DurableEvents,
    sessions: LeasedSessions,
    commands: CodeCommandService,
    artifacts: ArtifactStore,
    proposals: CodeProposalService;
  const definition = {
    name: 'code-proposals-test',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const policy = (): WorkflowPolicy => ({
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'domain.submit',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'read', tx);
        },
        build: async () => {
          if (poisoned) throw new Error('Proposal sealing must not render assignment context');
          return {
            role: 'producer',
            label: 'Code work',
            brief: 'Implement and seal.',
            references: [],
            handoff: { instruction: 'Finish.', tools: [] },
            execution: { readOnly: options.readOnly ?? false, tools: [] },
            context: null,
          };
        },
        execution: {
          readOnly: options.readOnly ?? false,
          tools: [
            { name: 'code.commit', alternatives: [{}] },
            { name: 'code.operation', alternatives: [{}] },
            { name: 'domain.submit', alternatives: [{ gate: { kind: 'literal', value: 'code' } }] },
            { name: 'domain.other', alternatives: [{}] },
          ],
          workspace: {
            mode: 'persistent',
            namespace: 'proposals',
            base: 'reference:code',
            perBase: true,
            retain: true,
            advancesCentral: false,
          },
        },
        references: () => ({ code: oid('a') }),
        lease: {
          role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
          acquire: async () => ({}),
          check: async () => {},
          release: async () => {},
        },
      },
    ],
  });
  let handle: Awaited<ReturnType<WorkflowsService['register']>>;
  const open = async () => {
    state = await openState(directory);
    scope = await createService(new ProjectScope(state, () => clock));
    workflows = await createService(new WorkflowsService(state, scope));
    events = await createService(new DurableEvents(state));
    handle = await workflows.register(definition, policy());
    sessions = await createService(
      new LeasedSessions(state, scope, workflows, events, {
        clock: () => clock,
        sweepIntervalMs: 60_000,
      }),
    );
    commands = await createService(new CodeCommandService(state, scope, sessions));
    artifacts = await createService(
      new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
    );
    proposals = await createService(
      new CodeProposalService(commands, state, scope, sessions, artifacts),
    );
    await state.migrate('proposal_domain_test', [
      {
        version: 1,
        sql: 'CREATE TABLE proposal_domain_test(id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL)',
      },
    ]);
  };
  const close = async () => {
    proposals.close();
    commands.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
  };
  await open();
  const boot = await scope!.bootstrap({ projectName: 'Code', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const ready = async (instanceId?: string) => {
    const instance = instanceId
      ? { id: instanceId }
      : await handle.start(source, {
          workflow: definition.name,
          requestId: randomBytes(10).toString('hex'),
        });
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId: instance.id,
      expectedRevision: 0,
      runnerId: 'runner',
      requestId: randomBytes(10).toString('hex'),
      secret,
    });
    const control = { sessionId: session.id, runnerId: 'runner', hostRef: `launch-${session.id}` };
    await sessions.attach(source, { ...control, workspace });
    return { session, control, secret, caller: await sessions.authenticate(secret) };
  };
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    source,
    boot,
    ready,
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    get sessions() {
      return sessions;
    },
    get commands() {
      return commands;
    },
    get artifacts() {
      return artifacts;
    },
    get proposals() {
      return proposals;
    },
    async complete(worker: Awaited<ReturnType<typeof ready>>, requestId = 'commit') {
      const operation = await commands.commit(worker.caller, {
        requestId,
        expectedHead: oid('a'),
        message: 'Implementation ready for review',
      });
      const command = (await commands.nextCommand(source, worker.control))!;
      assert.equal(command.id, operation.command.id);
      return await commands.completeCommand(source, {
        ...worker.control,
        commandId: command.id,
        receipt: receipt(command),
      });
    },
    async input(worker: Awaited<ReturnType<typeof ready>>): Promise<CodeProposalInput> {
      const command = (await this.complete(worker)).command;
      const evidence = await artifacts.create(worker.caller, {
        title: 'Test results',
        content: 'Three meaningful tests passed.',
      });
      return {
        commandId: command.id,
        summary: 'A bounded implementation with evidence.',
        artifactIds: [evidence.id],
        requestId: 'seal',
      };
    },
    async seal(caller: Caller, input: CodeProposalInput, admission = binding) {
      const invocation = await sessions.prepare(caller, admission.tool, admission.input);
      return sessions.run(
        invocation,
        async (boundCaller, parsed) =>
          await state.transaction(
            async (tx) =>
              await proposals.seal(boundCaller, input, { tool: admission.tool, input: parsed }, tx),
          ),
      );
    },
    events: async (type = 'code.proposal_sealed') =>
      (await state.events(source.projectId)).filter((event) => event.type === type),
    poison() {
      poisoned = true;
    },
    advance(ms: number) {
      clock += ms;
    },
    async restart() {
      await close();
      await open();
    },
  };
}

test('seals exact commit, original worker, pinned input/output metadata and canonical immutable manifest', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const pinned = await f.artifacts.create(f.source, {
    title: 'Approved specification',
    content: 'The bounded requirements.',
  });
  const binary = await f.artifacts.create(worker.caller, {
    title: 'Binary evidence',
    content: Buffer.from([0, 128, 255]).toString('base64'),
    encoding: 'base64',
    mediaType: 'application/octet-stream',
  });
  input.artifactIds.push(pinned.id, binary.id);
  input.pinnedInputIds = [pinned.id];
  input.provenance = { kind: 'consolidation', changes: ['one'] };
  f.poison();
  const proposal = await f.seal(worker.caller, input);
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.instanceId, worker.session.instanceId);
  assert.deepEqual(proposal.producer, {
    actorId: worker.caller.actorId,
    sessionId: worker.session.id,
    source: worker.session.source,
  });
  assert.deepEqual(proposal.workflow, {
    name: worker.session.execution.workflow,
    version: 1,
    state: 'working',
    revision: 0,
    policyHash: worker.session.execution.policyHash,
    registrationId: worker.session.execution.registrationId,
  });
  assert.equal(proposal.manifestArtifact.createdBy, worker.caller.actorId);
  assert.notEqual(proposal.manifestArtifact.createdBy, f.source.actorId);
  assert.deepEqual(
    proposal.command,
    (await f.commands.operation(worker.caller, input.commandId)).command,
  );
  assert.deepEqual(
    proposal.receipt,
    (await f.commands.operation(worker.caller, input.commandId)).receipt,
  );
  assert.deepEqual(
    proposal.artifacts.map((item) => item.id),
    input.artifactIds,
  );
  const manifest = await f.artifacts.read(f.source, proposal.manifestArtifact.id);
  const { manifestHash, manifestArtifact, ...facts } = proposal;
  assert.equal(manifest.content, canonical({ format: 1, ...facts }));
  assert.equal(createHash('sha256').update(manifest.content).digest('hex'), manifestHash);
  assert.equal(manifestArtifact.hash, manifestHash);
  assert.deepEqual(
    (await f.events()).map((event) => [event.actorId, event.subjectId]),
    [[worker.caller.actorId, proposal.id]],
  );
  assert.equal(((await f.events())[0].data.source as Data).sessionId, worker.session.id);
  (input.provenance.changes as string[]).push('mutated');
  proposal.producer.source.actorId = 'mutated';
  proposal.artifacts[0].hash = 'd'.repeat(64);
  assert.deepEqual((await f.proposals.proposal(f.source, proposal.id)).provenance, {
    kind: 'consolidation',
    changes: ['one'],
  });
  assert.notEqual(
    (await f.proposals.proposal(f.source, proposal.id)).artifacts[0].hash,
    'd'.repeat(64),
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('UPDATE code_proposals SET revision=9 WHERE id=?', proposal.id),
      ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM code_proposals WHERE id=?', proposal.id),
      ),
    { code: 'state_constraint' },
  );
});

test('normalized request replay survives restart without new artifacts, revisions or events; binding changes conflict', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const first = await f.seal(worker.caller, input);
  const artifactCount = (await f.artifacts.list(f.source)).length;
  assert.deepEqual(
    await f.seal(worker.caller, { ...input, pinnedInputIds: [], provenance: {} }),
    first,
  );
  await assert.rejects(f.seal(worker.caller, { ...input, summary: 'Different' }), {
    code: 'code_proposal_conflict',
  });
  await assert.rejects(f.seal(worker.caller, input, { tool: 'domain.other', input: {} }), {
    code: 'code_proposal_conflict',
  });
  await assert.rejects(
    f.seal(worker.caller, input, { ...binding, input: { gate: 'code', different: true } }),
    { code: 'code_proposal_conflict' },
  );
  await f.restart();
  const restored = await f.sessions.authenticate(worker.secret);
  assert.deepEqual(await f.seal(restored, input), first);
  assert.equal((await f.artifacts.list(f.source)).length, artifactCount);
  assert.equal((await f.events()).length, 1);
  assert.equal((await f.seal(restored, { ...input, requestId: 'second' })).revision, 2);
});

test('requires current real invocation and exact matching domain admission even for replay', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await f.proposals.seal(worker.caller, input, binding, tx),
      ),
    { code: 'session_invocation' },
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) =>
          await f.proposals.seal(
            { ...worker.caller, session: { ...worker.caller.session!, invocationId: 'invented' } },
            input,
            binding,
            tx,
          ),
      ),
    { code: 'session_invocation' },
  );
  const invocation = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
  await assert.rejects(
    f.sessions.run(
      invocation,
      async (caller) =>
        await f.state.transaction(
          async (tx) =>
            await f.proposals.seal(caller, input, { tool: 'domain.other', input: {} }, tx),
        ),
    ),
    { code: 'session_invocation' },
  );
  const valid = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
  const first = await f.sessions.run(
    valid,
    async (caller) =>
      await f.state.transaction(async (tx) => {
        const source = structuredClone(caller);
        const pending = f.proposals.seal(source, input, binding, tx);
        source.actorId = 'missing';
        source.session!.invocationId = 'missing';
        return await pending;
      }),
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await f.proposals.seal(valid.caller, input, binding, tx),
      ),
    { code: 'session_invocation' },
  );
  const stale = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
  await f.sessions.release(f.source, {
    sessionId: worker.session.id,
    runnerId: 'runner',
    reason: 'cancelled',
  });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await f.proposals.seal(stale.caller, input, binding, tx),
      ),
  );
  assert.equal((await f.proposals.proposal(f.source, first.id)).id, first.id);
  assert.equal((await f.events()).length, 1);
});

test('rejects read-only, uncaptured success, final-captured workspace and another worker operation', async (t) => {
  await t.test('read-only', async (t) => {
    const f = await fixture(t, { readOnly: true }),
      worker = await f.ready();
    await assert.rejects(
      f.seal(worker.caller, {
        commandId: 'missing',
        summary: 'x',
        artifactIds: ['missing'],
        requestId: 'seal',
      }),
      { code: 'code_read_only' },
    );
  });
  await t.test('pending commit', async (t) => {
    const f = await fixture(t),
      worker = await f.ready();
    const command = await f.commands.commit(worker.caller, {
      requestId: 'commit',
      expectedHead: oid('a'),
      message: 'Capture',
    });
    const art = await f.artifacts.create(worker.caller, { title: 'Evidence', content: 'Evidence' });
    await assert.rejects(
      f.seal(worker.caller, {
        commandId: command.command.id,
        summary: 'x',
        artifactIds: [art.id],
        requestId: 'seal',
      }),
      { code: 'code_commit_required' },
    );
  });
  await t.test('final capture', async (t) => {
    const f = await fixture(t),
      worker = await f.ready(),
      input = await f.input(worker);
    await f.sessions.workspaceResult(f.source, {
      ...worker.control,
      workspace: { ...workspace, headOid: oid('b') },
    });
    await assert.rejects(f.seal(worker.caller, input), { code: 'code_workspace_closed' });
  });
  await t.test('different worker', async (t) => {
    const f = await fixture(t),
      worker = await f.ready(),
      input = await f.input(worker),
      other = await f.ready();
    await assert.rejects(f.seal(other.caller, input));
    assert.equal((await f.events()).length, 0);
  });
});

test('requires authored output and trusted explicit pinned inputs; checks evidence byte integrity', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const other = await f.artifacts.create(f.source, { title: 'Owner input', content: 'Owner text' });
  await assert.rejects(f.seal(worker.caller, { ...input, artifactIds: [other.id] }), {
    code: 'code_proposal_authorship',
  });
  await assert.rejects(
    f.seal(worker.caller, { ...input, pinnedInputIds: [...input.artifactIds] }),
    { code: 'code_proposal_output_required' },
  );
  await assert.rejects(f.seal(worker.caller, { ...input, pinnedInputIds: [other.id] }), {
    code: 'invalid_code_input',
  });
  await assert.rejects(
    f.seal(worker.caller, { ...input, artifactIds: [input.artifactIds[0], input.artifactIds[0]] }),
    { code: 'invalid_code_input' },
  );
  const art = await f.artifacts.get(f.source, input.artifactIds[0]);
  writeFileSync(
    join(f.directory, 'blobs', f.source.projectId, art.hash.slice(0, 2), art.hash),
    'corrupted bytes',
  );
  await assert.rejects(f.seal(worker.caller, input), { code: 'blob_corrupt' });
  assert.equal((await f.events()).length, 0);
});

test('sealing is atomic with manifest metadata, domain writes, event failure and revision allocation', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const count = (await f.artifacts.list(f.source)).length;
  const invocation = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
  await assert.rejects(
    f.sessions.run(
      invocation,
      async (caller) =>
        await f.state.transaction(async (tx) => {
          const proposal = await f.proposals.seal(caller, input, binding, tx);
          await tx.run(
            'INSERT INTO proposal_domain_test(id,proposal_id) VALUES(?,?)',
            'pointer',
            proposal.id,
          );
          throw new Error('Domain transition refused');
        }),
    ),
    /Domain transition refused/,
  );
  assert.equal((await f.artifacts.list(f.source)).length, count);
  assert.equal((await f.proposals.proposals(f.source)).length, 0);
  assert.equal(
    (await f.state.read(async (sql) => await sql.all('SELECT * FROM proposal_domain_test'))).length,
    0,
  );
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    if (event.type === 'code.proposal_sealed') throw new Error('Event storage refused');
    return await append(tx, event);
  };
  await assert.rejects(f.seal(worker.caller, input), /Event storage refused/);
  f.state.appendEvent = append;
  assert.equal((await f.artifacts.list(f.source)).length, count);
  assert.equal((await f.events()).length, 0);
  const successful = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
  const proposal = await f.sessions.run(
    successful,
    async (caller) =>
      await f.state.transaction(async (tx) => {
        const proposal = await f.proposals.seal(caller, input, binding, tx);
        await tx.run(
          'INSERT INTO proposal_domain_test(id,proposal_id) VALUES(?,?)',
          'pointer',
          proposal.id,
        );
        return proposal;
      }),
  );
  assert.equal(proposal.revision, 1);
  assert.equal((await f.artifacts.list(f.source)).length, count + 1);
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ proposal_id: string }>('SELECT proposal_id FROM proposal_domain_test'),
    ))!.proposal_id,
    proposal.id,
  );
});

test('provider-triggered source revocation during manifest creation rolls back authority and all sealed writes', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const count = (await f.artifacts.list(f.source)).length;
  const create = f.artifacts.create.bind(f.artifacts);
  f.artifacts.create = async (caller, value, tx) => {
    const result = await create(caller, value, tx);
    // Fault-inject a provider's authority mutation inside the existing writer. Calling
    // Scope.revokeCredential here would only fail on a nested transaction.
    assert.ok(tx);
    await tx.run(
      'UPDATE actor_credentials SET revoked_at=? WHERE id=?',
      new Date().toISOString(),
      f.source.credentialId!,
    );
    return result;
  };
  await assert.rejects(f.seal(worker.caller, input), { code: 'forbidden' });
  f.artifacts.create = create;
  assert.ok(await f.scope.authenticate(f.boot.token));
  assert.equal((await f.artifacts.list(f.source)).length, count);
  assert.equal((await f.proposals.proposals(f.source)).length, 0);
  assert.equal((await f.events()).length, 0);
  assert.equal((await f.seal(worker.caller, input)).revision, 1);
});

test('project reads remain scoped and metadata-only, support borrowed transactions and bounded historical lookup', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const first = await f.seal(worker.caller, input);
  // Revisions 2-101 as sealing would store them: the reads under test see only rows. Revision
  // allocation by real seals is the concern of the tests above.
  await f.state.transaction((tx) =>
    tx.run(
      `INSERT INTO code_proposals(id,project_id,instance_id,revision,session_id,request_id,input_hash,proposal_json)
       SELECT id||'-'||n, project_id, instance_id, n, session_id, 'seal-'||(n-1), input_hash,
         jsonb_set(jsonb_set(proposal_json::jsonb,'{revision}',to_jsonb(n)),'{id}',to_jsonb(id||'-'||n))::text
       FROM code_proposals, generate_series(2,101) AS n WHERE id=?`,
      first.id,
    ),
  );
  const otherBoot = await f.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const other = { actorId: otherBoot.actor.id, projectId: otherBoot.project.id };
  await assert.rejects(async () => await f.proposals.proposal(other, first.id), {
    code: 'code_proposal_not_found',
  });
  assert.deepEqual(await f.proposals.proposals(other), []);
  for (const method of ['proposal', 'proposals'] as const) {
    await t.test(method, async () => {
      const caller = { ...other };
      const pending =
        method === 'proposal'
          ? f.proposals.proposal(caller, first.id)
          : f.proposals.proposals(caller);
      Object.assign(caller, f.source);
      if (method === 'proposal') await assert.rejects(pending, { code: 'code_proposal_not_found' });
      else assert.equal(((await pending) as unknown[]).length, 0);
    });
  }
  f.sessions.describe = async () => {
    throw new Error('Metadata read must not recursively describe a session');
  };
  f.artifacts.read = async () => {
    throw new Error('Metadata read must not fetch artifact bytes');
  };
  assert.equal((await f.proposals.proposals(f.source)).length, 100);
  assert.equal((await f.proposals.proposals(f.source))[0].revision, 101);
  assert.equal((await f.proposals.proposals(f.source)).at(-1)!.revision, 2);
  assert.equal((await f.proposals.proposal(f.source, first.id)).revision, 1);
  assert.equal(
    (await f.state.transaction(async (tx) => await f.proposals.proposal(f.source, first.id, tx)))
      .id,
    first.id,
  );
  assert.deepEqual(await f.proposals.proposals(f.source, 'absent-instance'), []);
  let stale!: Transaction;
  await f.state.transaction(async (tx) => {
    stale = tx;
  });
  await assert.rejects(async () => await f.proposals.proposal(f.source, first.id, stale));
  await assert.rejects(async () => await f.proposals.seal(worker.caller, input, binding, stale));
});

test('malformed plain JSON is rejected without getters, proxy traps, sparse allocation or artifact writes', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  let calls = 0;
  const getter = {
    get x() {
      calls++;
      return true;
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      getPrototypeOf() {
        calls++;
        return Object.prototype;
      },
    },
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(2 ** 32 - 1);
  const inherited = Object.create({ unexpected: true });
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  const values = [getter, proxy, cycle, sparse, inherited, dangerous, { value: NaN }];
  const count = (await f.artifacts.list(f.source)).length;
  for (const provenance of values) {
    await assert.rejects(f.seal(worker.caller, { ...input, provenance: provenance as Data }), {
      code: 'invalid_code_input',
    });
  }
  assert.equal(calls, 0);
  assert.equal((await f.artifacts.list(f.source)).length, count);
  assert.equal((await f.events()).length, 0);
});

test('format-1 manifest and replay hashes use deterministic nested Unicode key order', async (t) => {
  const unicode = { ä: { ö: 1, z: 2 }, z: 3, '𐐀': 4 };
  const localeCompare = String.prototype.localeCompare;
  let serialized: string;
  try {
    String.prototype.localeCompare = () => {
      throw new Error('Ambient collation must not participate');
    };
    serialized = canonical(unicode);
  } finally {
    String.prototype.localeCompare = localeCompare;
  }
  assert.equal(serialized!, '{"z":3,"ä":{"z":2,"ö":1},"𐐀":4}');
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  input.provenance = unicode;
  const proposal = await f.seal(worker.caller, input);
  const content = (await f.artifacts.read(f.source, proposal.manifestArtifact.id)).content;
  assert.ok(content.includes('"provenance":' + serialized!));
  assert.equal(proposal.manifestHash, createHash('sha256').update(content).digest('hex'));
  await f.restart();
  assert.deepEqual(await f.seal(await f.sessions.authenticate(worker.secret), input), proposal);
});

test('revoked source and expired worker cannot replay an existing sealed result', async (t) => {
  await t.test('source credential revoked', async (t) => {
    const f = await fixture(t),
      worker = await f.ready(),
      input = await f.input(worker);
    const proposal = await f.seal(worker.caller, input);
    const stale = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
    const admin = await f.scope.issueActor(f.source, {
      name: 'Other administrator',
      role: 'operator',
    });
    const adminCaller = {
      actorId: admin.actor.id,
      projectId: f.source.projectId,
      credentialId: admin.credential.id,
    };
    await f.scope.revokeCredential(adminCaller, f.source.credentialId!);
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await f.proposals.seal(stale.caller, input, binding, tx),
        ),
    );
    assert.equal((await f.proposals.proposal(adminCaller, proposal.id)).id, proposal.id);
    assert.equal((await f.events()).length, 1);
  });
  await t.test('worker expired', async (t) => {
    const f = await fixture(t),
      worker = await f.ready(),
      input = await f.input(worker);
    await f.seal(worker.caller, input);
    const stale = await f.sessions.prepare(worker.caller, binding.tool, binding.input);
    f.advance(24 * 60 * 60 * 1000);
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await f.proposals.seal(stale.caller, input, binding, tx),
        ),
    );
    assert.equal((await f.events()).length, 1);
  });
});

test('commit metadata must match the exact assignment revision and attached repository snapshot', async (t) => {
  const f = await fixture(t),
    worker = await f.ready(),
    input = await f.input(worker);
  const operation = f.commands.operation.bind(f.commands);
  for (const mutate of [
    (record: Awaited<ReturnType<typeof operation>>) => {
      record.command.expectedRevision++;
    },
    (record: Awaited<ReturnType<typeof operation>>) => {
      record.command.workspace.headOid = oid('d');
    },
    (record: Awaited<ReturnType<typeof operation>>) => {
      record.receipt!.repositoryId = 'another-repository';
    },
    (record: Awaited<ReturnType<typeof operation>>) => {
      record.receipt!.parentOid = oid('e');
    },
  ]) {
    f.commands.operation = async (caller, id) => {
      const result = await operation(caller, id);
      mutate(result);
      return result;
    };
    await assert.rejects(f.seal(worker.caller, input), { code: 'code_proposal_binding' });
  }
  f.commands.operation = operation;
  const read = f.artifacts.read.bind(f.artifacts);
  f.artifacts.read = async (caller, id) => ({
    ...(await read(caller, id)),
    content: 'substituted bytes',
  });
  await assert.rejects(f.seal(worker.caller, input), { code: 'code_proposal_artifact' });
  f.artifacts.read = read;
  assert.equal((await f.events()).length, 0);
});
