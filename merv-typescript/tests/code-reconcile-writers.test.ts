/**
 * A project's reconciliation on a binding change or a move of a base-resolution task re-derives
 * the units whose writer can still raise a blocker, not every unit that ever had a writer: an
 * ended, accepted unit's closed writer costs nothing. Only a start after Code Work was away
 * (reconcileAll) takes every writer, as one may have moved unseen.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createService, type Transaction } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { ReviewService } from '@merv/reviews';
import { CodeService } from '../packages/code-work/src/service.js';
import { CodeService as CoreCodeService } from '../packages/code/src/service.js';
import { openState } from './fixtures/state.js';

const definition = {
  name: 'build',
  version: 1,
  initial: 'building',
  states: ['building', 'built'],
  terminal: ['built'],
  edges: [{ from: 'building', action: 'finish', to: 'built' }],
};
const policy = {
  successStates: ['built'],
  actions: [
    {
      name: 'finish',
      tool: 'build.finish',
      states: ['building'],
      transitions: ['finish'],
      instruction: 'finish',
      check: () => {},
    },
  ],
  assignments: [],
};

test('a project reconciliation passes over ended units whose writer closed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-reconcile-'));
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
  const core = await createService(
    new CoreCodeService(state, scope, {
      repositories: { root: join(directory, 'code'), quotaBytes: 1024 ** 3, reservedFreeBytes: 1 },
    }),
  );
  const code = await createService(
    new CodeService(state, scope, sessions, workflows, reviews, core),
  );
  t.after(async () => {
    await code.close();
    await core.close();
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const principal = await scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'owner',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const project = await scope.members.createProject(principal, { name: 'P', requestId: 'one' });
  const admin = await scope.caller(principal, project.id);
  const handle = await workflows.register(definition, policy);

  // Count statements a binding change's reconciliation runs in its write transaction.
  let statements = 0;
  let counting = false;
  const transaction = state.transaction.bind(state);
  type Fn = (tx: Transaction) => unknown;
  (state as { transaction: (fn: Fn) => Promise<unknown> }).transaction = (fn: Fn) =>
    transaction(async (tx) => {
      if (counting)
        for (const key of ['get', 'all', 'run'] as const) {
          const original = tx[key] as (...args: unknown[]) => unknown;
          (tx as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => (
            statements++,
            original.apply(tx, args)
          );
        }
      return await fn(tx);
    });
  const measure = async () => {
    statements = 0;
    counting = true;
    await state.transaction((tx) => core.writers.changed(tx, project.id));
    counting = false;
    return statements;
  };

  let n = 0;
  const addEnded = async (count: number, writerState = 'closed', quarantined = false) => {
    for (let i = 0; i < count; i++) {
      const work = await handle.start(admin, {
        workflow: 'build',
        requestId: `r-${++n}`,
        dependsOn: [],
      });
      const moved = await handle.transition(admin, {
        instanceId: work.id,
        action: 'finish',
        requestId: `m-${n}`,
        expectedRevision: work.revision,
      });
      await transaction(async (tx) => {
        await code.acceptUnit(
          admin,
          {
            unitId: work.id,
            terminalRevision: moved.revision,
            submissionRef: 's',
            reviewRef: 'r',
            codeRef: null,
            reviewSessionId: null,
          },
          tx,
        );
        // An ended unit whose writer generation closed long ago, as every leased task leaves one.
        await tx.run(
          'INSERT INTO code_workspaces (project_id,unit_id,declared_at,base_json,generation,writer_state,writer_session_id,writer_lease_id,writer_changed_at,head_oid,quarantine_operation_id) VALUES (?,?,?,?,1,?,?,?,?,?,?)',
          project.id,
          work.id,
          'now',
          JSON.stringify({ reference: 'a'.repeat(40) }),
          writerState,
          `lease-${n}`,
          `lease-${n}`,
          'now',
          'b'.repeat(40),
          quarantined ? `op-${n}` : null,
        );
      });
    }
    await events.drain();
  };
  await addEnded(1);
  const one = await measure();
  await addEnded(20);
  assert.equal(await measure(), one, 'ended units with closed writers cost nothing');
  // A writer that can still raise a blocker is reconciled on every pass.
  await addEnded(1, 'recovery_required');
  const recovering = await measure();
  assert.ok(recovering > one, `${recovering} statements`);
  await addEnded(1, 'closed', true);
  assert.ok((await measure()) > recovering);
});
