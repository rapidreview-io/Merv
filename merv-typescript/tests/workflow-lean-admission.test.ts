import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createService, MervError } from '@merv/contracts';
import type { Caller, WorkflowDefinition, WorkflowPolicy, WorkflowSnapshot } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

type Environment = {
  handleActiveAtEntry?: boolean;
  mayRead?: boolean;
  ownerMatchesSnapshot?: boolean;
  installed?: boolean;
  handleActiveAtReplay?: boolean;
  postEdgeError?: string;
  activeBeforeWrite?: boolean;
  activeAfterWrite?: boolean;
};
type Step = {
  requestId: string;
  fingerprint: string;
  expectedRevision: number;
  action: string;
  environment: Environment;
};
type Observation = {
  kind: string;
  state: string;
  revision: number;
  currentState: string;
  currentRevision: number;
  historyLength: number;
};

const graph: WorkflowDefinition = {
  name: 'lean_admission',
  version: 1,
  managed: true,
  initial: 'draft',
  states: ['draft', 'review', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'draft', action: 'submit', to: 'review' },
    { from: 'review', action: 'revise', to: 'draft' },
    { from: 'review', action: 'accept', to: 'done' },
  ],
};
const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const modelBinary = resolve(modelDir, '.lake/build/bin/workflow_admission_model');
const modelAvailable = existsSync(modelBinary);

function modelObservations(steps: Step[]): Observation[] {
  const run = spawnSync(modelBinary, [], {
    cwd: modelDir,
    input: JSON.stringify({ graph, steps }),
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined, `Lean could not start: ${run.error?.message}`);
  assert.equal(run.status, 0, `Lean admission model failed:\n${run.stderr}`);
  return (JSON.parse(run.stdout) as { observations: Observation[] }).observations;
}

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    release,
    wait: async () => {
      entered();
      await released;
    },
  };
}

test(
  'Lean admission ordering agrees with managed workflow authorization and withdrawal',
  {
    skip:
      !modelAvailable && process.env.MERV_REQUIRE_LEAN !== '1'
        ? 'Build workflow_admission_model to run conformance'
        : undefined,
  },
  async () => {
    assert.ok(modelAvailable, `Lean admission model binary is missing: ${modelBinary}`);
    const state: PostgresState = await openState();
    try {
      const scope = await createService(new ProjectScope(state));
      const credentials = await scope.bootstrap({
        projectName: 'Lean admission',
        actorName: 'Operator',
      });
      const operator: Caller = {
        actorId: credentials.actor.id,
        projectId: credentials.project.id,
      };
      const producerActor = (
        await scope.issueActor(operator, {
          name: 'Producer',
          role: 'producer',
        })
      ).actor;
      const producer: Caller = { actorId: producerActor.id, projectId: operator.projectId };
      const readerActor = (
        await scope.issueActor(operator, {
          name: 'Reader',
          role: 'reader',
        })
      ).actor;
      const reader: Caller = { actorId: readerActor.id, projectId: operator.projectId };
      const workflows = await createService(new WorkflowsService(state, scope));
      let mode: 'pass' | 'deny' | 'pause' = 'pass';
      let gate = barrier();
      const policy: WorkflowPolicy = {
        actions: graph.edges.map((edge) => ({
          name: edge.action,
          states: [edge.from],
          transitions: [edge.action],
          tool: `admission.${edge.action}`,
          instruction: edge.action,
          async check() {
            if (mode === 'deny') throw new MervError('policy_denied', 'Denied by test policy', 403);
            if (mode === 'pause') await gate.wait();
          },
          arguments: async ({ snapshot }) => ({ instanceId: snapshot.id }),
          requiredInput: async () => [],
        })),
      };
      let program = await workflows.register(graph, policy);
      const other = await workflows.register({ ...graph, name: 'other_admission' }, policy);
      const initial = await program.start(operator, {
        workflow: graph.name,
        requestId: 'admission-start',
      });
      await state.transaction((tx) =>
        tx.run('CREATE TABLE admission_atomic (id TEXT PRIMARY KEY)'),
      );

      const steps: Step[] = [];
      const actual: Observation[] = [];
      const committed = new Set<string>();
      const command = (requestId: string, action: string, expectedRevision: number) => ({
        instanceId: initial.id,
        requestId,
        action,
        expectedRevision,
      });
      const record = async (
        input: ReturnType<typeof command>,
        environment: Environment,
        invoke: () => Promise<WorkflowSnapshot>,
      ) => {
        steps.push({
          requestId: input.requestId,
          fingerprint: JSON.stringify({
            action: input.action,
            expectedRevision: input.expectedRevision,
          }),
          expectedRevision: input.expectedRevision,
          action: input.action,
          environment,
        });
        let kind: string;
        let response: WorkflowSnapshot | undefined;
        try {
          response = await invoke();
          kind = committed.has(input.requestId) ? 'replayed' : 'committed';
          committed.add(input.requestId);
        } catch (error) {
          kind = (error as { code?: string }).code ?? 'unknown_error';
        }
        const current = await workflows.get(operator, initial.id);
        const historyLength = (await workflows.history(operator, initial.id)).length;
        const eventCount = (await state.events(operator.projectId)).filter(
          (event) => event.type === 'workflow.transition' && event.subjectId === initial.id,
        ).length;
        const receiptCount = await state.transaction(async (tx) => {
          const row = await tx.get<{ count: string }>(
            'SELECT COUNT(*) AS count FROM wf_requests WHERE project_id = ?',
            operator.projectId,
          );
          return Number(row?.count);
        });
        assert.equal(eventCount, historyLength, 'transition event/history atomicity');
        assert.equal(receiptCount, historyLength, 'request receipt/history atomicity');
        actual.push({
          kind,
          state: response?.state ?? current.state,
          revision: response?.revision ?? current.revision,
          currentState: current.state,
          currentRevision: current.revision,
          historyLength,
        });
      };

      assert.equal('transition' in workflows, false, 'commands require an owning handle');
      await scope.revokeActor(operator, reader.actorId);
      const noRead = command('revoked-reader', 'submit', 0);
      await record(noRead, { mayRead: false }, () => program.transition(reader, noRead));
      const wrong = command('wrong-handle', 'submit', 0);
      await record(
        wrong,
        {
          ownerMatchesSnapshot: false,
        },
        () => other.transition(operator, wrong),
      );
      mode = 'deny';
      const rejected = command('policy-refusal', 'submit', 0);
      await record(
        rejected,
        {
          postEdgeError: 'policy_denied',
        },
        () => program.transition(operator, rejected),
      );
      mode = 'pass';
      const submit = command('submit-operator', 'submit', 0);
      const handleEnv: Environment = {};
      await record(submit, handleEnv, () => program.transition(operator, submit));
      await record(submit, handleEnv, () => program.transition(operator, submit));
      const revise = command('revise-producer', 'revise', 1);
      await record(revise, handleEnv, () => program.transition(producer, revise));
      await scope.revokeActor(operator, producer.actorId);
      await record(revise, { ...handleEnv, mayRead: false }, () =>
        program.transition(producer, revise),
      );

      mode = 'pause';
      gate = barrier();
      const withdrawn = command('withdrawn', 'submit', 2);
      const pending = state.transaction(async (tx) => {
        await tx.run('INSERT INTO admission_atomic (id) VALUES (?)', 'withdrawn');
        return await program.transition(operator, withdrawn, tx);
      });
      await gate.arrived;
      program.dispose();
      gate.release();
      await record(
        withdrawn,
        {
          ...handleEnv,
          activeBeforeWrite: false,
        },
        () => pending,
      );
      assert.deepEqual(await state.read((sql) => sql.all('SELECT id FROM admission_atomic')), []);
      await record(
        submit,
        {
          ...handleEnv,
          handleActiveAtEntry: false,
        },
        () => program.transition(operator, submit),
      );
      mode = 'pass';
      program = await workflows.register(graph, policy);
      const originalAppendEvent = state.appendEvent.bind(state);
      let withdrawAfterRecord = true;
      state.appendEvent = async (tx, event) => {
        const stored = await originalAppendEvent(tx, event);
        if (
          withdrawAfterRecord &&
          event.type === 'workflow.transition' &&
          event.subjectId === initial.id
        ) {
          withdrawAfterRecord = false;
          program.dispose();
        }
        return stored;
      };
      const afterWrite = command('after-write-withdrawn', 'submit', 2);
      try {
        await record(
          afterWrite,
          {
            ...handleEnv,
            activeAfterWrite: false,
          },
          () =>
            state.transaction(async (tx) => {
              await tx.run('INSERT INTO admission_atomic (id) VALUES (?)', 'after-write');
              return await program.transition(operator, afterWrite, tx);
            }),
        );
      } finally {
        state.appendEvent = originalAppendEvent;
      }
      assert.equal(withdrawAfterRecord, false, 'test reached the post-record withdrawal point');
      assert.deepEqual(await state.read((sql) => sql.all('SELECT id FROM admission_atomic')), []);
      program = await workflows.register(graph, policy);
      await record(afterWrite, handleEnv, () => program.transition(operator, afterWrite));
      const accept = command('accept-operator', 'accept', 3);
      await record(accept, handleEnv, () => program.transition(operator, accept));

      assert.deepEqual(
        actual,
        modelObservations(steps),
        `admission trace:\n${JSON.stringify(steps, null, 2)}`,
      );
      assert.deepEqual(
        [...new Set(actual.map((item) => item.kind))].sort(),
        [
          'committed',
          'forbidden',
          'policy_denied',
          'replayed',
          'workflow_handle_mismatch',
          'workflow_unavailable',
        ].sort(),
      );
    } finally {
      await state.close();
    }
  },
);
