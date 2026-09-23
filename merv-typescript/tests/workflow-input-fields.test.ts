import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  Caller,
  WorkflowActionRule,
  WorkflowDefinition,
  WorkflowCheckContext,
} from '@merv/contracts';
import { createApp } from './fixtures/app.js';

type App = Awaited<ReturnType<typeof createApp>>;
type RequiredInput = NonNullable<WorkflowActionRule['requiredInput']>;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-input-fields-'));
  const app = await createApp({ directory });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Workflow inputs',
    actorName: 'Operator',
  });
  const caller: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const other: Caller = {
    actorId: (await app.ctx.scope.issueActor(caller, { name: 'Other producer', role: 'producer' }))
      .actor.id,
    projectId: caller.projectId,
  };
  return {
    app,
    caller,
    other,
    async close() {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function durable(app: App, caller: Caller) {
  return await app.ctx.state.read(async (sql) => ({
    definitions: await sql.all('SELECT * FROM wf_definitions ORDER BY name,version'),
    workflows: await sql.all('SELECT * FROM wf_instances ORDER BY id'),
    history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
    requests: await sql.all('SELECT * FROM wf_requests ORDER BY request_id'),
    events: await app.ctx.state.events(caller.projectId),
  }));
}

const singleStep = (name: string): WorkflowDefinition => ({
  name,
  version: 1,
  initial: 'working',
  states: ['working', 'done'],
  terminal: ['done'],
  edges: [{ from: 'working', action: 'finish', to: 'done' }],
});

const rule = (requiredInput: RequiredInput): WorkflowActionRule => ({
  name: 'finish',
  states: ['working'],
  transitions: ['finish'],
  tool: 'example.finish',
  instruction: 'Submit the required values.',
  requiredInput,
  check: async () => {},
});

test('dynamic fields follow instance state, data and caller while static fields and transition guards agree', async () => {
  const f = await fixture();
  try {
    const graph: WorkflowDefinition = {
      name: 'variable_inputs',
      version: 1,
      initial: 'working',
      states: ['working', 'checking', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'working', action: 'advance', to: 'checking' },
        { from: 'checking', action: 'finish', to: 'done' },
        { from: 'working', action: 'annotate', to: 'working' },
      ],
    };
    await f.app.ctx.workflows.register(graph, {
      actions: [
        {
          name: 'continue',
          states: ['working', 'checking'],
          transitions: ['advance', 'finish'],
          tool: 'example.continue',
          instruction: 'Supply the values this instance currently needs.',
          requiredInput: ({ snapshot, caller }) => [
            ...(snapshot.state === 'checking'
              ? ['receipt']
              : snapshot.data.strict
                ? ['reading', 'evidence']
                : ['reading']),
            ...(caller.actorId === f.other.actorId ? ['explanation'] : []),
          ],
          check: async () => {},
        },
        {
          name: 'annotate',
          states: ['working'],
          transitions: ['annotate'],
          tool: 'example.annotate',
          instruction: 'Add a note.',
          requiredInput: ['note', 'stamp'],
          arguments: () => ({ stamp: 'provided-by-program' }),
          check: async () => {},
        },
      ],
    });
    const simple = await f.app.ctx.workflows.start(f.caller, {
      workflow: graph.name,
      requestId: 'simple',
      data: { strict: false },
    });
    const strict = await f.app.ctx.workflows.start(f.caller, {
      workflow: graph.name,
      requestId: 'strict',
      data: { strict: true },
    });
    const fields = async (caller: Caller, id: string) =>
      (await f.app.ctx.workflows.evaluate(caller, id)).actions.find(
        (action) => action.action === 'continue',
      )!.requiredInput;
    assert.deepEqual(await fields(f.caller, simple.id), ['reading']);
    assert.deepEqual(await fields(f.caller, strict.id), ['reading', 'evidence']);
    assert.deepEqual(await fields(f.other, strict.id), ['reading', 'evidence', 'explanation']);
    const staticAction = (await f.app.ctx.workflows.evaluate(f.caller, simple.id)).actions.find(
      (action) => action.action === 'annotate',
    )!;
    assert.deepEqual(staticAction.requiredInput, ['note']);
    assert.deepEqual(staticAction.arguments, { stamp: 'provided-by-program' });
    const before = await durable(f.app, f.caller);
    const partial = await f.app.ctx.workflows.evaluate(f.caller, strict.id, {
      action: 'continue',
      input: { reading: 1 },
    });
    assert.deepEqual(partial.nextAction?.requiredInput, ['evidence']);
    assert.equal(partial.nextAction?.status, 'needs_input');
    await assert.rejects(
      async () =>
        await f.app.ctx.workflows.transition(f.caller, {
          instanceId: strict.id,
          expectedRevision: 0,
          action: 'advance',
          requestId: 'advance',
          input: { reading: 1 },
        }),
      { code: 'input_required' },
    );
    assert.deepEqual(await durable(f.app, f.caller), before);
    const moved = await f.app.ctx.workflows.transition(f.caller, {
      instanceId: strict.id,
      expectedRevision: 0,
      action: 'advance',
      requestId: 'advance',
      input: { reading: 1, evidence: 'retained receipt' },
    });
    assert.equal(moved.state, 'checking');
    assert.deepEqual(await fields(f.caller, strict.id), ['receipt']);
    assert.deepEqual(await fields(f.other, strict.id), ['receipt', 'explanation']);
    const done = await f.app.ctx.workflows.transition(f.caller, {
      instanceId: strict.id,
      expectedRevision: 1,
      action: 'finish',
      requestId: 'finish',
      input: { receipt: 'verified' },
    });
    assert.equal(done.state, 'done');
    assert.deepEqual((await f.app.ctx.workflows.evaluate(f.caller, strict.id)).actions, []);
  } finally {
    await f.close();
  }
});

test('runtime field lists reject invalid or duplicate names with a server policy error and no durable mutation', async () => {
  const f = await fixture();
  try {
    for (const [index, fields] of [
      null,
      {},
      'reading',
      ['reading', 'reading'],
      [''],
      ['bad name'],
      [1],
      ['x'.repeat(129)],
    ].entries()) {
      const graph = singleStep(`invalid_fields_${index}`);
      await f.app.ctx.workflows.register(graph, { actions: [rule(() => fields as string[])] });
      const instance = await f.app.ctx.workflows.start(f.caller, {
        workflow: graph.name,
        requestId: `start-${index}`,
      });
      const before = await durable(f.app, f.caller);
      await assert.rejects(async () => await f.app.ctx.workflows.evaluate(f.caller, instance.id), {
        code: 'invalid_workflow_policy',
        status: 500,
      });
      await assert.rejects(
        async () =>
          await f.app.ctx.workflows.transition(f.caller, {
            instanceId: instance.id,
            action: 'finish',
            expectedRevision: 0,
            requestId: `finish-${index}`,
            input: { reading: 1 },
          }),
        { code: 'invalid_workflow_policy', status: 500 },
      );
      assert.deepEqual(await durable(f.app, f.caller), before);
    }
  } finally {
    await f.close();
  }
});

test('dynamic callbacks receive deeply frozen detached inputs during both guidance and command enforcement', async () => {
  const f = await fixture();
  try {
    const graph = singleStep('frozen_input_context');
    const observations: WorkflowCheckContext[] = [];
    await f.app.ctx.workflows.register(graph, {
      actions: [
        rule((context) => {
          observations.push(context);
          assert.ok(Object.isFrozen(context));
          assert.ok(Object.isFrozen(context.caller));
          assert.ok(Object.isFrozen(context.snapshot));
          assert.ok(Object.isFrozen(context.snapshot.data));
          assert.ok(Object.isFrozen(context.snapshot.data.nested));
          assert.ok(Object.isFrozen(context.dependencies));
          assert.throws(() => {
            context.caller.actorId = 'replaced';
          }, TypeError);
          assert.throws(() => {
            (context.snapshot.data.nested as { value: string }).value = 'replaced';
          }, TypeError);
          if (context.input) {
            assert.ok(Object.isFrozen(context.input));
            assert.ok(Object.isFrozen(context.input.reading));
            assert.throws(() => {
              (context.input!.reading as { value: number }).value = 999;
            }, TypeError);
          }
          return ['reading'];
        }),
      ],
    });
    const data = { nested: { value: 'original' } };
    const input = { reading: { value: 10 } };
    const instance = await f.app.ctx.workflows.start(f.caller, {
      workflow: graph.name,
      requestId: 'start',
      data,
    });
    assert.deepEqual(
      (await f.app.ctx.workflows.evaluate(f.caller, instance.id)).nextAction?.requiredInput,
      ['reading'],
    );
    assert.equal(
      (await f.app.ctx.workflows.evaluate(f.caller, instance.id, { action: 'finish', input }))
        .nextAction?.status,
      'ready',
    );
    await f.app.ctx.workflows.transition(f.caller, {
      instanceId: instance.id,
      action: 'finish',
      expectedRevision: 0,
      requestId: 'finish',
      input,
    });
    assert.ok(observations.length >= 3);
    assert.deepEqual(data, { nested: { value: 'original' } });
    assert.deepEqual(input, { reading: { value: 10 } });
    assert.notEqual(observations[0].caller, f.caller);
    assert.deepEqual((await f.app.ctx.workflows.get(f.caller, instance.id)).data, data);
  } finally {
    await f.close();
  }
});

test('async input callbacks are awaited and rejected callbacks leave no writes', async () => {
  const f = await fixture();
  try {
    for (const [index, callback] of [
      async () => ['reading'],
      () => Promise.resolve(['reading']),
    ].entries()) {
      const graph = singleStep(`async_fields_${index}`);
      await f.app.ctx.workflows.register(graph, { actions: [rule(callback)] });
      const instance = await f.app.ctx.workflows.start(f.caller, {
        workflow: graph.name,
        requestId: `start-success-${index}`,
      });
      const decision = await f.app.ctx.workflows.evaluate(f.caller, instance.id);
      assert.deepEqual(decision.actions[0].requiredInput, ['reading']);
      const finished = await f.app.ctx.workflows.transition(f.caller, {
        instanceId: instance.id,
        action: 'finish',
        expectedRevision: 0,
        requestId: `finish-success-${index}`,
        input: { reading: 1 },
      });
      assert.equal(finished.state, 'done');
    }
    const callbacks = [
      () => Promise.reject(new Error('rejected field promise')),
      () => ({
        then: (_resolve: unknown, reject: (error: Error) => void) =>
          reject(new Error('rejected thenable')),
      }),
    ];
    for (const [index, callback] of callbacks.entries()) {
      const graph = singleStep(`thenable_fields_${index}`);
      await f.app.ctx.workflows.register(graph, {
        actions: [rule(callback as unknown as RequiredInput)],
      });
      const instance = await f.app.ctx.workflows.start(f.caller, {
        workflow: graph.name,
        requestId: `start-${index}`,
      });
      const before = await durable(f.app, f.caller);
      await assert.rejects(f.app.ctx.workflows.evaluate(f.caller, instance.id), /rejected/);
      await assert.rejects(
        f.app.ctx.workflows.transition(f.caller, {
          instanceId: instance.id,
          action: 'finish',
          expectedRevision: 0,
          requestId: `finish-${index}`,
          input: { reading: 1 },
        }),
        /rejected/,
      );
      assert.deepEqual(await durable(f.app, f.caller), before);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await f.close();
  }
});
