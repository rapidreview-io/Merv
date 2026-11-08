import assert from 'node:assert/strict';
import test from 'node:test';
import { createService, digest, migrationList } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { openState } from './fixtures/state.js';
import { postgresMigrations } from '../packages/sessions/src/index.postgres.js';

for (const ordinaryFirst of [false, true]) {
  test(`message and inquiry replay remain independent with colliding keys, ordinary first: ${ordinaryFirst}`, async (t) => {
    const state = await openState();
    const scope = await createService(new ProjectScope(state));
    const workflows = await createService(new WorkflowsService(state, scope));
    const events = await createService(new DurableEvents(state));
    const migrate = state.migrate.bind(state);
    const prior: typeof state.migrate = (component, migrations) =>
      migrate(
        component,
        component === 'sessions'
          ? migrationList(migrations).filter((m) => m.version <= 26)
          : migrations,
      );
    const oldSchema = t.mock.method(state, 'migrate', prior);
    const sessions = await createService(
      new LeasedSessions(state, scope, workflows, events, {
        sweepIntervalMs: 60_000,
        dispatchByDefault: true,
      }),
    );
    oldSchema.mock.restore();
    t.after(async () => {
      await sessions.close();
      await events.close();
      workflows.close();
      await state.close();
    });
    const boot = await scope.credentials.bootstrap({
      projectName: 'Inquiry replay',
      actorName: 'Owner',
    });
    const owner = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const program = await workflows.register({
      name: 'replay',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    });
    const work = await program.start(owner, { workflow: 'replay', requestId: 'work' });
    const worker = await scope.credentials.issueActor(owner, { name: 'Worker', role: 'producer' });
    const threadId = 'saved-thread';
    const at = new Date().toISOString();
    await state.transaction((tx) =>
      tx.run(
        'INSERT INTO session_threads(id,project_id,continuity_key,instance_id,state,role,actor_id,status,harness,conversation_id,sha256,size,uploaded_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        threadId,
        owner.projectId,
        'saved-key',
        work.id,
        'working',
        'producer',
        worker.actor.id,
        'dormant',
        'claude',
        'saved-conversation',
        'a'.repeat(64),
        100,
        at,
        at,
        at,
      ),
    );
    const input = { threadId, body: 'Inspect the next step', requestId: 'one' };
    const ordinary = { ...input, requestId: 'inquiry:one' };
    const send = () => sessions.messaging.message(owner, ordinary);
    const ask = () => sessions.inquiries.ask(owner, input);
    const first = ordinaryFirst ? await send() : await ask();
    // Upgrade with a retained row: the old public replay still resolves after key separation.
    await state.migrate('sessions', postgresMigrations);
    const second = ordinaryFirst ? await ask() : await send();
    const message = await send(),
      inquiry = await ask();
    assert.notEqual(message.id, inquiry.messageId);
    assert.deepEqual(ordinaryFirst ? message : inquiry, first);
    assert.deepEqual(ordinaryFirst ? inquiry : message, second);
    assert.deepEqual(
      await state.read((sql) =>
        sql.all(
          'SELECT inquiry_role FROM session_messages WHERE thread_id=? ORDER BY inquiry_role NULLS FIRST',
          threadId,
        ),
      ),
      [{ inquiry_role: null }, { inquiry_role: 'question' }],
    );
    await assert.rejects(sessions.messaging.message(owner, { ...ordinary, body: 'Changed' }), {
      code: 'request_conflict',
    });
    await assert.rejects(sessions.inquiries.ask(owner, { ...input, body: 'Changed' }), {
      code: 'request_conflict',
    });
    const context = {
      threadId,
      body: 'Retained answer context',
      requestId: `inquiry-context:${inquiry.id}`,
    };
    const sendContext = () => sessions.messaging.message(owner, context);
    const retainContext = () =>
      state.transaction((tx) =>
        sessions.messaging.insert(tx, {
          ...context,
          projectId: owner.projectId,
          senderActorId: owner.actorId,
          fingerprint: digest({ threadId, body: context.body }),
          inquiry: { id: inquiry.id, role: 'context' },
        }),
      );
    const before = ordinaryFirst ? (await sendContext()).id : await retainContext();
    const after = ordinaryFirst ? await retainContext() : (await sendContext()).id;
    assert.notEqual(before, after);
    assert.equal((await sendContext()).id, ordinaryFirst ? before : after);
  });
}
