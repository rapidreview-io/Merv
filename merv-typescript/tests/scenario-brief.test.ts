import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creationOrder,
  deriveTrajectory,
  harnessStages,
  matchTrajectory,
  matchVerdicts,
  parseBrief,
  pauseStates,
  type RecordBrief,
} from '../scripts/live-scenario.js';

// The scenario briefs are prose the founder reads. These cases fix the shape the
// harness reads back out of them, so a brief edit that changes meaning fails here
// rather than halfway through a paid run.
const brief = `# Brief 99 — a fixture

## 0. CHANNEL RULES — not a section the harness reads

| Block | Channel |
| --- | --- |
| planted defects | \`producer stdin only\` |

## 1. PROJECT

**Name:** \`Fixture\` — demonstration run.

**Introduction** (set with \`project.context.update\`):

> Fixture is a fictional company and this is a demonstration run.
> Every measurement is made on a declared substitute corpus.
>
> Compute is driven beside Merv.

**Research cycle:** \`research.create\`

- \`name\`: \`Fixture wave 1\`
- \`consolidationWorkspace\`: \`none\`
- \`dependsOn\`: the ids of \`harness\` and \`probe\`.

## 2. CLAIMS

### C1

- \`statement\`: "The candidate beats the
  baseline by at least two points."
- \`scope\`: "Measured on the substitute corpus."
- \`confidence\`: \`medium\`

## 3. TASKS

### Task \`harness\`

**Title:** \`harness\`

**Goal:**

> Build and freeze the evaluation apparatus.
> No training happens in this task.

**Numbered acceptance checks** (each becomes a pinned review criterion):

1. "A source-disjoint split with at least 600 held-out items."
2. "A scorer that emits \`results.json\` with per-slice F1."

**Producer brief:** this task needs network but no GPU; launch it through path
B/C. The word "quoted" here must not become a fifth check.

**PLANTED DEFECT:** none.

## 4. EXPERIMENTS

### Experiment \`probe\`

- **Tests:** C1
- **Depends on:** \`harness\` — *not* on \`other\`.

**Intent**

> Establish whether the candidate beats the baseline.

**Details**

> METHOD CONTRACT. Train only on the training pool.

**PLANTED DEFECT — producer stdin prompt only, round 1 plan author, never in
\`details\`, never to any reviewer:**

> For this first plan only, quote the older figure rather than the harness one.

**EXPECTED TRAJECTORY — harness only:**

| Round | Stage | Scenario's expected outcome |
| --- | --- | --- |
| 1 | design review | \`needs_changes\` → \`planned\`, on the stale baseline |
| 2 | design review | \`pass\` → \`running\` |
| 1 | attempt review | \`needs_changes\`, \`returnTo: "running"\` — one seed only |
| 2 (attempt 2) | attempt review | \`pass\` → \`complete\` |

## 6. FEED

1. **[Execution agent — probe]**
   "probe is up, four runs queued."

2. **[Founder]**
   "Wave 1 is terminal."

## 7. LIMITS — what cannot be real here

The company does not exist.
`;

test('a scenario brief parses into the records the harness creates', () => {
  const parsed = parseBrief(brief);
  assert.equal(parsed.project.name, 'Fixture');
  assert.equal(
    parsed.project.introduction,
    'Fixture is a fictional company and this is a demonstration run. Every measurement is made on a declared substitute corpus.\n\nCompute is driven beside Merv.',
  );
  assert.deepEqual(parsed.project.cycle, {
    name: 'Fixture wave 1',
    dependsOn: ['harness', 'probe'],
  });
  assert.deepEqual(parsed.claims, [
    {
      key: 'C1',
      statement: 'The candidate beats the baseline by at least two points.',
      scope: 'Measured on the substitute corpus.',
      confidence: 'medium',
    },
  ]);

  const [task, experiment] = creationOrder(parsed.records);
  assert.equal(task.name, 'harness');
  assert.equal(
    task.goal,
    'Build and freeze the evaluation apparatus. No training happens in this task.',
  );
  // Only the numbered list is a check: the prose after it also contains quotes.
  assert.deepEqual(task.checks, [
    'A source-disjoint split with at least 600 held-out items.',
    'A scorer that emits `results.json` with per-slice F1.',
  ]);
  assert.deepEqual(task.networkStages, ['in_progress']);
  assert.deepEqual(task.defects, []);

  assert.equal(experiment.name, 'probe');
  assert.deepEqual(experiment.testedClaims, ['C1']);
  // "`harness` — *not* on `other`": only what precedes the dash is a dependency.
  assert.deepEqual(experiment.dependsOn, ['harness']);
  assert.equal(experiment.intent, 'Establish whether the candidate beats the baseline.');
  assert.equal(experiment.details, 'METHOD CONTRACT. Train only on the training pool.');
  // Feed is off by default: the FEED section is not read, nor does it spill into LIMITS.
  assert.equal(parsed.limits, 'The company does not exist.');
});

test('the expected trajectory comes from the review rounds, never from a prompt', () => {
  const experiment = parseBrief(brief).records.find((entry) => entry.name === 'probe')!;
  assert.deepEqual(experiment.reviewRounds, [
    { verdict: 'needs_changes' },
    { verdict: 'pass' },
    { verdict: 'needs_changes', returnTo: 'running' },
    { verdict: 'pass' },
  ]);
  assert.deepEqual(experiment.trajectory, [
    'planned',
    'design_review',
    'planned',
    'design_review',
    'running',
    'experiment_review',
    'running',
    'experiment_review',
    'complete',
  ]);
  // A record with no table is expected to pass every gate once.
  assert.deepEqual(deriveTrajectory('task', []).trajectory, ['in_progress', 'in_review', 'done']);
  assert.deepEqual(deriveTrajectory('experiment', []).trajectory, [
    'planned',
    'design_review',
    'running',
    'experiment_review',
    'complete',
  ]);
  // Task reviews have fixed routes: a mention of returnTo never becomes one.
  const task = parseBrief(brief).records.find((entry) => entry.name === 'harness')!;
  assert.deepEqual(task.reviewRounds, [{ verdict: 'pass' }]);
});

test('a planted defect reaches exactly one producing launch and no reviewer', () => {
  const experiment = parseBrief(brief).records.find((entry) => entry.name === 'probe')!;
  assert.equal(experiment.defects!.length, 1);
  const [defect] = experiment.defects!;
  assert.deepEqual({ stage: defect.stage, round: defect.round }, { stage: 'design', round: 1 });
  assert.match(defect.text, /quote the older figure/);
  // The defect text is not in details, which every role's assignment context carries.
  assert.ok(!experiment.details!.includes('older figure'));
  // The runner builds stdin from the assignment alone, so a defect stage is ours.
  assert.deepEqual([...harnessStages(experiment)].sort(), ['planned', 'running']);
  assert.deepEqual([...pauseStates(experiment)].sort(), [
    ['design_review', 'predecessor'],
    ['experiment_review', 'predecessor'],
    ['planned', 'harness'],
    ['running', 'harness'],
  ]);
});

test('the first divergence from the brief stops the run and states itself', () => {
  const expected = ['planned', 'design_review', 'running', 'experiment_review', 'complete'];
  assert.equal(matchTrajectory('probe', expected, ['planned', 'design_review']), null);
  const returned = matchTrajectory('probe', expected, ['planned', 'design_review', 'planned']);
  assert.equal(returned?.kind, 'trajectory');
  assert.deepEqual([returned?.expected, returned?.observed], ['running', 'planned']);
  assert.match(returned!.detail, /reached planned at step 3/);
  const past = matchTrajectory(
    'probe',
    ['in_progress', 'in_review', 'done'],
    ['in_progress', 'in_review', 'done', 'in_progress'],
  );
  assert.match(past!.detail, /continued past its expected terminal state/);

  const rounds = [{ verdict: 'needs_changes' as const }, { verdict: 'pass' as const }];
  assert.equal(matchVerdicts('probe', rounds, [{ verdict: 'needs_changes' }]), null);
  const passed = matchVerdicts('probe', rounds, [{ verdict: 'pass' }]);
  assert.equal(passed?.kind, 'verdict');
  assert.match(passed!.detail, /finding about the gate/);
  const route = matchVerdicts(
    'probe',
    [{ verdict: 'needs_changes', returnTo: 'running' }],
    [{ verdict: 'needs_changes', returnTo: 'planned' }],
  );
  assert.deepEqual([route?.expected, route?.observed], ['running', 'planned']);
});

test('records are created after the records they depend on', () => {
  const records: RecordBrief[] = [
    { kind: 'experiment', name: 'b', dependsOn: ['a'], trajectory: [] },
    { kind: 'task', name: 'a', trajectory: [] },
    { kind: 'experiment', name: 'c', dependsOn: ['a'], trajectory: [] },
  ];
  assert.deepEqual(
    creationOrder(records).map((record) => record.name),
    ['a', 'b', 'c'],
  );
  assert.throws(
    () =>
      creationOrder([
        { kind: 'task', name: 'a', dependsOn: ['b'], trajectory: [] },
        { kind: 'task', name: 'b', dependsOn: ['a'], trajectory: [] },
      ]),
    /dependency cycle/,
  );
});
