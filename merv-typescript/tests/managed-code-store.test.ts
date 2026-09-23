import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, createService, type Caller, type CodeUploadFinalize } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { CodeUnitStore } from '@merv/code/units';
import { CodeWriterService } from '@merv/code/writers';
import { CodeStore } from '@merv/code/store/operations';
import { openState } from './fixtures/state.js';
import { boundProject } from './fixtures/code-binding.js';
import { gitSource } from './fixtures/code-store.js';

test('managed Code transfers are fenced to one session even for the same source actor', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-managed-code-'));
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const writers = new CodeWriterService(state, scope, 900);
  const units = await createService(new CodeUnitStore(state, scope, writers));
  const source = gitSource(t);
  const head = source.commit({ 'README.md': 'baseline\n' });
  const tree = source.git('rev-parse', 'HEAD^{tree}');
  const boot = await scope.bootstrap({ projectName: 'Managed Code', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const delegation = await scope.delegationSource(owner);
  let current = true;
  const unregister = scope.registerManagedRunnerAuthority({
    require: async (caller) => {
      check(
        current && caller.managed?.boundSessionId === caller.managed?.allocationId,
        'unauthorized',
        'Binding no longer current',
        401,
      );
      return delegation;
    },
  });
  const managed = (session: string): Caller => ({
    actorId: owner.actorId,
    projectId: owner.projectId,
    managed: {
      allocationId: session,
      epoch: 1,
      credentialHash: 'test-binding',
      boundSessionId: session,
    },
  });
  const first = managed('session_first');
  const other = managed('session_other');
  const store = await createService(
    new CodeStore(
      state,
      scope,
      { root: join(directory, 'code'), reservedFreeBytes: 1, settleMs: 60_000 },
      {
        imported: async () => {},
        workspaces: async () => [],
        frozen: async () => [],
        fenced: async () => {},
        advanced: async () => {},
        quarantined: async () => {},
      },
    ),
  );
  t.after(async () => {
    await store.close();
    unregister();
    units.close();
    writers.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await boundProject(state, owner.projectId, head);
  const bundle = source.bundle(head);
  const imported = await store.importRepository(owner, {
    source: 'bundle',
    tip: head,
    bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
    requestId: 'baseline',
  });
  await store.putPart(owner, imported.id, 0, bundle.content);
  assert.equal((await store.complete(owner, imported.id)).status, 'completed');

  const input: CodeUploadFinalize = {
    kind: 'final',
    sessionId: 'session_first',
    runnerId: 'runner_first',
    hostRef: 'launch_first',
    unitId: 'unit_first',
    leaseId: 'lease_first',
    generation: 1,
    expectedHead: head,
    proposedHead: head,
    treeOid: tree,
    bundle: null,
  };
  const operation = await store.beginUpload(first, input);
  assert.equal(operation.status, 'completed');
  assert.equal((await store.beginUpload(first, input)).id, operation.id);
  // A second VM shares the project's source actor. That does not authorize it to
  // replay, inspect or continue this assignment's durable upload receipt.
  for (const call of [
    () => store.beginUpload(other, input),
    () => store.operation(other, operation.id),
    () => store.putPart(other, operation.id, 0, Buffer.from('no')),
    () => store.complete(other, operation.id),
    () => store.export(other, { sessionId: 'session_first', head, haves: [] }),
  ])
    await assert.rejects(call, { code: 'managed_runner_forbidden' });
  const exported = await store.export(first, { sessionId: 'session_first', head, haves: [] });
  assert.ok('exportId' in exported);
  const part = { sessionId: 'session_first', offset: 0, length: 128 };
  assert.ok((await store.readExport(first, exported.exportId, part)).length);
  await assert.rejects(() => store.readExport(other, exported.exportId, part), {
    code: 'managed_runner_forbidden',
  });
  // Revoke between creating an export and reading its next part.
  current = false;
  await assert.rejects(() => store.readExport(first, exported.exportId, part), {
    code: 'unauthorized',
  });
  await assert.rejects(() => store.operation(first, operation.id), { code: 'unauthorized' });
});
