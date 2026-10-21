import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { MervError, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';
import { fixtureThread } from './threads.js';
import { codeStoreFixture, gitSource } from './code-store.js';

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
  driver: 'code.git.1',
};
export const refused = (code: string) => (error: unknown) => {
  assert.ok(error instanceof MervError, String(error));
  assert.equal(error.code, code);
  return true;
};

/** A hosted project with one unit, and sessions the test plays itself. */
export async function writerFixture(
  t: TestContext,
  grace = 900,
  options: {
    objectFormat?: 'sha1' | 'sha256';
  } = {},
) {
  const { objectFormat = 'sha1', ...storeOptions } = options;
  const source = gitSource(t, objectFormat);
  const root = source.commit({ 'README.md': 'root\n' });
  const sessions = new Map<string, Record<string, unknown>>();
  const f = await codeStoreFixture(t, {}, root, {
    get: async (_caller, id) => {
      const session = sessions.get(id);
      if (!session) throw new MervError('session_not_found', 'Session not found', 404);
      return structuredClone(session) as never;
    },
  });
  await f.open({ finalizeGraceSeconds: grace, ...storeOptions });
  assert.equal((await f.deliver(source.bundle(root))).status, 'completed');
  const build = await f.workflows.register(definition, policy);
  const unit = await build.start(f.admin, { workflow: 'build', requestId: 'unit' });
  const runner = { runnerId: 'runner-1' };
  let revision = 0;
  const actors = new Map<string, string>();
  const persist = async (sessionId: string, readOnly = false) => {
    let actorId = actors.get(sessionId);
    if (!actorId) {
      actorId = (
        await f.scope.credentials.issueActor(f.admin, {
          name: sessionId,
          role: readOnly ? 'reviewer' : 'producer',
        })
      ).actor.id;
      actors.set(sessionId, actorId);
    }
    const actor = actorId;
    await f.state.transaction(async (tx) => {
      const thread = await fixtureThread(tx, f.admin.projectId, actor);
      await tx.run(
        'INSERT INTO worker_sessions(id,project_id,actor_id,instance_id,revision,owner_hash,runner_id,request_id,token_hash,fingerprint,status,session_json,thread_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        sessionId,
        f.admin.projectId,
        actor,
        unit.id,
        ++revision,
        'owner',
        runner.runnerId,
        sessionId,
        sessionId,
        sessionId,
        'active',
        JSON.stringify(sessions.get(sessionId)),
        thread,
      );
    });
  };
  const self = {
    ...f,
    get code() {
      return f.code;
    },
    get store() {
      return f.store;
    },
    source,
    root,
    unitId: unit.id,
    /** What an owner's lease acquisition does, in one transaction. */
    lease: async (sessionId: string) => {
      const result = await f.state.transaction(async (tx) => {
        await f.code.pinBase(f.admin, { unitId: unit.id, leaseId: sessionId, writer: true }, tx);
        const writer = await f.core.writers.writerStatus(f.admin, unit.id, tx);
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
      });
      await persist(sessionId);
      return result;
    },
    /** A session event as Code's writer subscription takes it; `ownEnd` as session.closed says
     *  its worker ended the visit by its own hand (a handoff or a question to its owner). */
    event: async (type: string, sessionId: string, ownEnd = false) => {
      const change = (
        { 'session.workspace_attached': 'attached', 'session.closed': 'closed' } as const
      )[type as 'session.closed'];
      if (change)
        await f.state.transaction((tx) =>
          f.core.writers.sessionChanged(f.admin.projectId, sessionId, change, tx, ownEnd),
        );
    },
    /** A read-only session whose checkout is exactly one referenced commit. */
    reviewer: async (sessionId: string, code: string) => {
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
              driver: 'code.git.1',
            },
            tools: [],
          },
          references: { code },
        },
      });
      await persist(sessionId, true);
    },
    /** The session as the machine that runs it was handed it. */
    session: (sessionId: string) => structuredClone(sessions.get(sessionId)!),
    end: async (sessionId: string, closeReason: string | null = null) => {
      Object.assign(sessions.get(sessionId)!, { status: 'released', closeReason });
      await f.state.transaction((tx) =>
        tx.run(
          "UPDATE worker_sessions SET status='released',session_json=? WHERE id=?",
          JSON.stringify(sessions.get(sessionId)),
          sessionId,
        ),
      );
    },
    unit: async () => await f.code.unit(f.admin, unit.id),
    /** Code's writer sweep, as the store runs it at start and on its interval. */
    sweep: async () => await f.core.writers.expire(),
  };
  return self;
}
