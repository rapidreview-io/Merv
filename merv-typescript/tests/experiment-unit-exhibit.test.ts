/**
 * A system-generated exhibit is nobody's own on an experiment's Artifacts tab, even when its
 * submitting session made it (submit() creates it with the worker's caller) or a reviewer cites
 * it: the shared file list must not hand it the producer's or the reviewer's role.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentUnit } from '../packages/experiments/src/running.js';

const at = (minute: number) => `2026-10-06T12:${String(minute).padStart(2, '0')}:00.000Z`;
const node = (state: string, current = false) => ({
  state,
  initial: state === 'planned',
  terminal: state === 'complete',
  current,
  entries: 0,
  firstEnteredAt: null,
  blockers: [],
});
const states = ['planned', 'design_review', 'running', 'experiment_review', 'complete'];
const graph = {
  instanceId: 'wf_1',
  workflow: 'experiment',
  version: 1,
  revision: 3,
  state: 'experiment_review',
  currentGate: 'experiment_review',
  terminal: false,
  dependencies: [],
  nodes: states.map((each) => node(each, each === 'experiment_review')),
  edges: [],
};
const file = (id: string, minute: number) => ({
  id,
  title: `${id}.md`,
  mediaType: 'application/json',
  size: 100,
  createdAt: at(minute),
});
const evidence = (artifactId: string, role: string, systemGenerated = false) => ({
  artifactId,
  role,
  path: `${role}.md`,
  figureIds: [],
  sessionId: 'ses_run',
  systemGenerated,
  current: true,
  attemptIndex: 1,
});
const experiment = {
  id: 'wf_1',
  intent: 'Q',
  workflow: { state: 'experiment_review' },
  attempt: { index: 1 },
  evidence: [evidence('report', 'report')],
  submissions: [
    {
      stage: 'results',
      reviewId: 'rv1',
      createdAt: at(20),
      sessionId: 'ses_run',
      figureIds: [],
      evidence: [evidence('exhibit', 'exhibit', true)],
    },
  ],
};
const review = {
  id: 'rv1',
  subjectId: 'wf_1',
  subjectRevision: 3,
  artifactIds: [],
  criteria: ['one'],
  findings: [{ criterionNumber: 1, status: 'met', evidenceIds: ['exhibit'] }],
  status: 'submitted',
  verdict: null,
  reviewerId: 'actor_claude',
  synopsis: null,
  notes: null,
  createdAt: at(21),
};
const found = new Map([file('report', 18), file('exhibit', 20)].map((item) => [item.id, item]));
const roleOf = (unit: ReturnType<typeof experimentUnit>, id: string) =>
  unit.artifacts!.find((item) => item.id === id)?.role;

test('an exhibit its submitting session made stays nobody’s own', () => {
  const unit = experimentUnit(experiment as never, graph as never, [] as never, {
    found,
    made: [file('exhibit', 20)],
  });
  assert.equal(roleOf(unit, 'exhibit'), undefined);
});

test('an exhibit a reviewer cites stays nobody’s own', () => {
  const unit = experimentUnit(experiment as never, graph as never, [review] as never, { found });
  assert.equal(roleOf(unit, 'exhibit'), undefined);
});
