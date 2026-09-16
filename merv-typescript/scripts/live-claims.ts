import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { check, type WorkflowAssignmentRule } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';

// Explicit native-model acceptance on synthetic data. The managed program is a
// fixture; Claims remains a project-fact provider with no work-item workflow.
const directory = resolve(process.argv[2] ?? `live-runs/claims-${Date.now()}`);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
const boot = await app.ctx.scope.bootstrap({
  projectName: 'Native claim facts acceptance',
  actorName: 'Owner',
});
const source = {
  projectId: boot.project.id,
  actorId: boot.actor.id,
  credentialId: boot.credential.id,
};
const other = await app.ctx.scope.bootstrap({
  projectName: 'Separate synthetic project',
  actorName: 'Other owner',
});
const otherCaller = {
  projectId: other.project.id,
  actorId: other.actor.id,
  credentialId: other.credential.id,
};
const privateClaim = await app.ctx.claims.create(otherCaller, {
  statement: 'Separate project claim',
  requestId: 'other-claim',
});
const statement = 'The synthetic method improves accuracy on this fixture.';
const scope = 'Synthetic interface validation only; no research conclusion is asserted.';
const credentialEnv = 'MERV_NATIVE_CLAIMS_SOURCE';
const previous = process.env[credentialEnv];
process.env[credentialEnv] = boot.token;
const rule = (state: 'write' | 'verify'): WorkflowAssignmentRule => {
  const readOnly = state === 'verify';
  const tools = readOnly
    ? ['claim.list', 'step.verify']
    : ['claim.list', 'claim.create', 'claim.update', 'step.record'];
  return {
    state,
    check: async ({ caller, tx }) => {
      await app.ctx.scope.require(caller, readOnly ? 'review' : 'write', tx);
    },
    references: ({ snapshot }): Record<string, string> =>
      readOnly ? { claimId: String(snapshot.data.claimId) } : {},
    build: async ({ snapshot }) => ({
      role: readOnly ? 'reviewer' : 'producer',
      label: readOnly
        ? 'Independently inspect the saved claim'
        : 'Create and revise a synthetic claim',
      brief: readOnly
        ? `Call claim.list and verify that this project has exactly one claim, ${snapshot.data.claimId}. Its statement must be exactly ${JSON.stringify(statement)} and its scope exactly ${JSON.stringify(scope)}. Verify status weakened, confidence low and revision 1. Its original creator must be the producer actor ${snapshot.data.producerId}, which is different from your actor. Call step.verify with that claimId only after checking the returned server data. Do not modify claims. This is interface validation, not scientific review. Then stop.`
        : `Call claim.list first and verify this project is empty. Create exactly one claim with statement ${JSON.stringify(statement)}, scope ${JSON.stringify(scope)}, confidence high and requestId:"native-create". Check the returned status active and revision 0. Call claim.create a second time with exactly the same input and requestId; verify the same record is returned. Update that claim using claim.update with expectedRevision:0, status:"weakened", confidence:"low", requestId:"native-update". Verify revision 1 and unchanged statement/scope. Repeat that exact update once; verify the same revision-1 receipt is returned. Finally call claim.list to verify there is exactly one claim, then step.record with its claimId. This is an interface test, not a scientific experiment. No external research or filesystem work is needed. Then stop.`,
      references: [],
      handoff: {
        instruction: `Call ${readOnly ? 'step.verify' : 'step.record'}, then stop.`,
        tools: [readOnly ? 'step.verify' : 'step.record'],
      },
      execution: { readOnly, tools: tools.map((name) => ({ name, arguments: {} })) },
      context: null,
    }),
    execution: {
      readOnly,
      tools: tools.map((name) => ({
        name,
        alternatives:
          name === 'step.verify'
            ? [{ claimId: { kind: 'reference' as const, name: 'claimId' } }]
            : [{}],
      })),
      workspace: { mode: 'none' },
    },
    lease: {
      role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> =>
        readOnly ? 'reviewer' : 'producer',
      acquire: async () => ({}),
      check: async () => {},
      release: async () => {},
    },
  };
};
const program = await app.ctx.workflows.register(
  {
    name: 'native-claims',
    version: 1,
    managed: true,
    initial: 'write',
    states: ['write', 'verify', 'done'],
    terminal: ['done'],
    edges: [
      { from: 'write', action: 'record', to: 'verify' },
      { from: 'verify', action: 'verify', to: 'done' },
    ],
  },
  {
    successStates: ['done'],
    actions: ['record', 'verify'].map((action) => ({
      name: action,
      states: [action === 'record' ? 'write' : 'verify'],
      transitions: [action],
      tool: `step.${action}`,
      instruction:
        action === 'record' ? 'Hand off the saved claim.' : 'Confirm the independently read claim.',
      check: async ({ caller, tx }) => {
        await app.ctx.scope.require(caller, action === 'record' ? 'write' : 'review', tx);
      },
    })),
    assignments: [rule('write'), rule('verify')],
  },
);
const target = await program.start(source, { workflow: 'native-claims', requestId: 'start' });
const handles = ['record', 'verify'].map((action) =>
  app.ctx.tools.register({
    name: `step.${action}`,
    description: 'Confirm the fixture claim record and hand off this bounded assignment.',
    inputSchema: z.object({ claimId: z.string().min(1) }).strict(),
    handler: async (caller, input: { claimId: string }) =>
      await app.ctx.state.transaction(async (tx) => {
        const current = await app.ctx.workflows.get(caller, target.id, tx);
        check(
          current.state === (action === 'record' ? 'write' : 'verify'),
          'fixture_state',
          'This fixture step is no longer current',
          409,
        );
        const session = await app.ctx.sessions.describe(caller);
        check(
          session.instanceId === target.id && session.expectedRevision === current.revision,
          'fixture_session',
          'The exact fixture worker is required',
          403,
        );
        const claim = await app.ctx.claims.get(caller, input.claimId, tx);
        check(
          claim.statement === statement &&
            claim.scope === scope &&
            claim.status === 'weakened' &&
            claim.confidence === 'low' &&
            claim.revision === 1,
          'fixture_claim',
          'The exact revised fixture claim is required',
          409,
        );
        check(
          action === 'record'
            ? claim.createdBy === caller.actorId && claim.updatedBy === caller.actorId
            : claim.id === current.data.claimId &&
                claim.createdBy === current.data.producerId &&
                claim.createdBy !== caller.actorId,
          'fixture_authorship',
          'Preserve the original producer and independent reader',
          403,
        );
        check(
          (await app.ctx.claims.list(caller, tx)).length === 1,
          'fixture_count',
          'There must be exactly one claim',
          409,
        );
        return await program.transition(
          caller,
          {
            instanceId: target.id,
            expectedRevision: current.revision,
            action,
            requestId: action,
            ...(action === 'record'
              ? { data: { claimId: claim.id, producerId: caller.actorId } }
              : {}),
          },
          tx,
        );
      }),
  }),
);
const runner = new MachineRunner({
  directory: join(directory, 'machine'),
  baseUrl: app.ctx.api.url!,
  projectId: boot.project.id,
  credentialEnv,
  capacity: 1,
  pollIntervalMs: 500,
  profiles: [
    {
      name: 'native-codex',
      harness: 'codex',
      executable: process.env.MERV_CODEX_BIN ?? 'codex',
      enabled: true,
      parallelism: 1,
    },
  ],
});
try {
  await runner.start();
  await app.ctx.sessions.setDispatch(source, { enabled: true });
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (true) {
    const state = (await app.ctx.workflows.get(source, target.id)).state;
    const snapshot = runner.snapshot();
    const line = JSON.stringify({
      state,
      runnerState: snapshot.state,
      error: snapshot.lastError,
      launches: snapshot.launches.map(({ id, status }) => ({ id, status })),
    });
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (
      state === 'done' &&
      snapshot.launches.length === 2 &&
      snapshot.launches.every((launch) => ['stopped', 'exited'].includes(launch.status))
    )
      break;
    assert.ok(Date.now() < deadline, 'Native Claims acceptance timed out');
    assert.ok(
      snapshot.launches.length <= 2,
      'Expected two fresh agents; inspect retained failure logs',
    );
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.stop();
  const final = await app.ctx.workflows.get(source, target.id);
  const sessions = (await app.ctx.sessions.list(source)).sort(
    (a, b) => a.expectedRevision - b.expectedRevision,
  );
  const claim = await app.ctx.claims.get(source, String(final.data.claimId));
  const events = (await app.ctx.state.events(source.projectId)).filter(
    (event) => event.subjectId === claim.id,
  );
  assert.equal(sessions.length, 2);
  assert.equal(claim.createdBy, sessions[0].actorId);
  assert.equal(claim.updatedBy, sessions[0].actorId);
  assert.notEqual(sessions[0].actorId, sessions[1].actorId);
  assert.deepEqual(
    events.map((event) => event.type),
    ['claim.created', 'claim.updated'],
  );
  assert.deepEqual(
    events.map((event) => event.data.confidence),
    ['high', 'low'],
  );
  assert.ok(events.every((event) => event.actorId === claim.createdBy));
  for (const event of events)
    assert.deepEqual(event.data.source, { kind: 'session', sessionId: sessions[0].id });
  assert.deepEqual(await app.ctx.claims.list(otherCaller), [privateClaim]);
  await assert.rejects(async () => await app.ctx.claims.get(source, privateClaim.id), {
    code: 'claim_not_found',
  });
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const phases = walk(join(directory, 'machine/launches'))
    .filter((path) => path.endsWith('/stdout.log'))
    .map((path) => {
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      return {
        log: path,
        threadId: events.find((event) => event.type === 'thread.started')?.thread_id,
        calls: events
          .filter(
            (event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call',
          )
          .map((event) => ({
            tool: event.item.tool,
            status: event.item.status,
            failed:
              event.item.status !== 'completed' ||
              !!event.item.error ||
              event.item.result?.isError === true,
          })),
      };
    });
  assert.equal(new Set(phases.map((phase) => phase.threadId).filter(Boolean)).size, 2);
  const calls = phases.flatMap((phase) => phase.calls);
  for (const [tool, minimum] of [
    ['claim.create', 2],
    ['claim.update', 2],
    ['claim.list', 3],
    ['step.record', 1],
    ['step.verify', 1],
  ] as const)
    assert.ok(
      calls.filter((call) => call.tool === tool && !call.failed).length >= minimum,
      `Missing successful ${tool} calls`,
    );
  const report = {
    passed: true,
    freshAgents: phases.length,
    successfulCalls: calls.filter((call) => !call.failed).length,
    failedCalls: calls.filter((call) => call.failed).length,
    claim,
    events,
    workflow: final,
    sessions,
    phases,
    runner: runner.snapshot(),
    otherProjectUnchanged: true,
    limits: [
      'Synthetic managed program validates Claims; Claims itself has no workflow.',
      'No experiment, scientific review or reflection publication is implemented by this fixture.',
      'The final read-only worker inspects records without submitting a Reviews assessment.',
    ],
  };
  const serialized = JSON.stringify(report, null, 2);
  assert.ok(!serialized.includes(boot.token) && !serialized.includes(other.token));
  writeFileSync(join(directory, 'report.json'), serialized + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      freshAgents: phases.length,
      successfulCalls: report.successfulCalls,
      failedCalls: report.failedCalls,
      report: join(directory, 'report.json'),
    }),
  );
} finally {
  await runner.stop();
  for (const dispose of handles) await dispose();
  program.dispose();
  await app.stop();
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
}
