import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import {
  MervError,
  type CodeStoreOperation,
  type StoredEvent,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';
import type { CodeStoreOptions } from '@merv/code-research/service';
import { codeStoreFixture, gitSource, type Backend, type Bundle } from './code-store.js';

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
const workspace = {
  mode: 'persistent',
  namespace: 'tasks',
  base: 'reference:base',
  perBase: false,
  retain: true,
  advancesCentral: false,
  driver: 'code.v2',
};
export const refused = (code: string) => (error: unknown) => {
  assert.ok(error instanceof MervError, String(error));
  assert.equal(error.code, code);
  return true;
};

/** A hosted project with one unit, and sessions the test plays itself. */
export async function writerFixture(
  t: TestContext,
  backend: Backend,
  grace = 900,
  options: Pick<CodeStoreOptions, 'mirror' | 'mirrorConfig'> = {},
) {
  const source = gitSource(t);
  const root = source.commit({ 'README.md': 'root\n' });
  const sessions = new Map<string, Record<string, unknown>>();
  const f = await codeStoreFixture(t, backend, {}, root, {
    get: async (_caller, id) => {
      const session = sessions.get(id);
      if (!session) throw new MervError('session_not_found', 'Session not found', 404);
      return structuredClone(session) as never;
    },
  });
  await f.open({ finalizeGraceSeconds: grace, ...options });
  assert.equal((await f.deliver(source.bundle(root))).status, 'completed');
  await f.workflows.register(definition, policy);
  const unit = await f.workflows.start(f.admin, { workflow: 'build', requestId: 'unit' });
  const runner = { runnerId: 'runner-1' };
  let commands = 0;
  const self = {
    ...f,
    get code() {
      return f.code;
    },
    source,
    root,
    unitId: unit.id,
    /** What an owner's lease acquisition does, in one transaction. */
    lease: async (sessionId: string) =>
      await f.state.transaction(async (tx) => {
        await f.code.pinBase(f.admin, { unitId: unit.id, leaseId: sessionId }, tx);
        const writer = await f.code.reserveWriter(
          f.admin,
          { unitId: unit.id, leaseId: sessionId },
          tx,
        );
        sessions.set(sessionId, {
          id: sessionId,
          projectId: f.admin.projectId,
          instanceId: unit.id,
          status: 'active',
          hostRef: `launch-${sessionId}`,
          ...runner,
          execution: { policy: { readOnly: false, workspace, tools: [] }, references: {} },
        });
        return writer;
      }),
    event: async (type: string, sessionId: string) =>
      await f.state.transaction(
        async (tx) =>
          await f.code.sessionChanged(
            { type, projectId: f.admin.projectId, subjectId: sessionId } as StoredEvent,
            tx,
          ),
      ),
    /** A read-only session whose checkout is exactly one referenced commit. */
    reviewer: (sessionId: string, code: string) => {
      sessions.set(sessionId, {
        id: sessionId,
        projectId: f.admin.projectId,
        instanceId: unit.id,
        status: 'active',
        hostRef: `launch-${sessionId}`,
        ...runner,
        execution: {
          policy: {
            readOnly: true,
            workspace: {
              mode: 'ephemeral',
              namespace: 'task-reviews',
              base: 'reference:code',
              retain: false,
              driver: 'code.v2',
            },
            tools: [],
          },
          references: { code },
        },
      });
    },
    /** The session as the machine that runs it was handed it. */
    session: (sessionId: string) => structuredClone(sessions.get(sessionId)!),
    end: (sessionId: string) => {
      sessions.get(sessionId)!.status = 'released';
    },
    unit: async () => await f.code.unit(f.admin, unit.id),
    /** A commit command the session was handed, as Code's command table records it. */
    async dispatched(sessionId: string, commandId: string) {
      await f.state.transaction(async (tx) => {
        // A session has one outstanding command; the earlier ones have ended.
        await tx.run(
          "UPDATE code_commands SET status='failed',error='ended' WHERE session_id=? AND id<>? AND status='dispatched'",
          sessionId,
          commandId,
        );
        await tx.run(
          'INSERT INTO code_commands (id,project_id,session_id,actor_id,request_id,input_hash,command_json,status) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          commandId,
          f.admin.projectId,
          sessionId,
          f.admin.actorId,
          commandId,
          'hash',
          '{}',
          'dispatched',
        );
      });
    },
    async begin(
      kind: 'checkpoint' | 'final',
      sessionId: string,
      generation: number,
      expectedHead: string,
      bundle: Bundle | null,
      commandId = `command-${++commands}`,
    ): Promise<CodeStoreOperation> {
      if (kind === 'checkpoint') await self.dispatched(sessionId, commandId);
      const tip = bundle?.tip ?? expectedHead;
      const body = {
        sessionId,
        ...runner,
        hostRef: `launch-${sessionId}`,
        unitId: unit.id,
        generation,
        leaseId: sessionId,
        expectedHead,
        proposedHead: tip,
        treeOid: source.git('rev-parse', `${tip}^{tree}`),
        bundle: bundle && { sha256: bundle.sha256, bytes: bundle.bytes },
        kind,
        ...(kind === 'checkpoint' ? { commandId, requestId: commandId } : {}),
      };
      return (
        (await f.code.v2!.call(f.admin, kind === 'final' ? 'finalize' : 'uploads', body)) as {
          operation: CodeStoreOperation;
        }
      ).operation;
    },
    async send(operation: CodeStoreOperation, bundle: Bundle): Promise<CodeStoreOperation> {
      // A sender whose whole bundle already arrived is told so, and goes on to complete.
      await f.code.v2!.putPart(f.admin, operation.id, 0, bundle.content).catch((error: unknown) => {
        if (!(error instanceof MervError) || error.code !== 'code_upload_closed') throw error;
      });
      return (
        (await f.code.v2!.call(f.admin, `uploads/${operation.id}/complete`, {})) as {
          operation: CodeStoreOperation;
        }
      ).operation;
    },
    async upload(
      kind: 'checkpoint' | 'final',
      sessionId: string,
      generation: number,
      expectedHead: string,
      bundle: Bundle,
    ) {
      return await self.send(
        await self.begin(kind, sessionId, generation, expectedHead, bundle),
        bundle,
      );
    },
  };
  return self;
}
