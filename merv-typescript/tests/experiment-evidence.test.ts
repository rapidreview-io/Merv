import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  copyExperimentJson,
  experimentAttachSchema,
  experimentCreateSchema,
  experimentGetSchema,
  experimentTransitionSchema,
  parseExperimentInput,
} from '../packages/experiments/src/input.js';
import {
  buildMetricsExhibit,
  decodeEvidence,
  exhibitBytes,
  markdownImageTargets,
  parseResult,
  reportConclusion,
  shouldPinExhibit,
  validateGraph,
  validatePlan,
  validateReport,
  type MetricsResultSource,
} from '../packages/experiments/src/evidence.js';

const plan =
  '# Summary\nCompare treatment and control.\n# Objective & hypothesis\nTreatment changes the measured outcome.\n# Evaluation\nUse the declared comparison and confidence interval.\n';
const report =
  '# Summary\nThe run completed.\n# Results\nSee metrics_exhibit.json.\n# Deviations from plan\nNone.\n# Conclusion\nThe result is inconclusive.\n';
const invalidInput = (action: () => unknown) =>
  assert.throws(action, { code: 'invalid_experiment_input' });
const invalidEvidence = (action: () => unknown) =>
  assert.throws(action, { code: 'invalid_experiment_evidence' });
const mutation = { experimentId: 'exp_one', expectedRevision: 0, requestId: 'request_1' };

test('input normalization is idempotent across tool and core parsing', () => {
  const created = parseExperimentInput(experimentCreateSchema, {
    name: '  accuracy-trial  ',
    intent: ' Test a claim. ',
    testedClaimIds: ['clm_a', 'clm_a'],
    requestId: 'create_1',
  });
  assert.deepEqual(created, {
    name: 'accuracy-trial',
    intent: 'Test a claim.',
    details: '',
    testedClaimIds: ['clm_a'],
    dependsOn: [],
    requestId: 'create_1',
  });
  assert.deepEqual(parseExperimentInput(experimentCreateSchema, created), created);
  const attached = parseExperimentInput(experimentAttachSchema, {
    ...mutation,
    artifactId: 'art_result',
    role: 'result',
    path: 'results/data.json',
    attemptIndex: 1,
  });
  assert.equal(attached.resultFormat, 'json');
  assert.deepEqual(parseExperimentInput(experimentAttachSchema, attached), attached);
  const retried = parseExperimentInput(experimentTransitionSchema, {
    ...mutation,
    transition: 'retry_running',
  });
  assert.deepEqual(retried.evidence, { reason: 'infrastructure failure', detail: '' });
  assert.deepEqual(parseExperimentInput(experimentTransitionSchema, retried), retried);
  assert.deepEqual(
    parseExperimentInput(experimentTransitionSchema, {
      ...mutation,
      transition: 'submit_design',
      evidence: {},
    }),
    { ...mutation, transition: 'submit_design' },
  );
});

test('public mutation fields enforce scope-independent shape, paths and system-only exhibit', () => {
  const attachment = {
    ...mutation,
    artifactId: 'art_a',
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
  };
  for (const path of [
    '../plan.md',
    '/plan.md',
    'a//plan.md',
    'a/./plan.md',
    'a\\plan.md',
    ' plan.md',
    'https://host/plan',
  ])
    invalidInput(() => parseExperimentInput(experimentAttachSchema, { ...attachment, path }));
  for (const delta of [
    { role: 'exhibit' },
    { attemptIndex: 0 },
    { expectedRevision: -1 },
    { resultFormat: 'json' },
    { actorId: 'act_other' },
  ])
    invalidInput(() => parseExperimentInput(experimentAttachSchema, { ...attachment, ...delta }));
  invalidInput(() =>
    parseExperimentInput(experimentTransitionSchema, { ...mutation, transition: 'abandon' }),
  );
  invalidInput(() =>
    parseExperimentInput(experimentTransitionSchema, {
      ...mutation,
      transition: 'mark_failed',
      evidence: { reason: '  ' },
    }),
  );
  invalidInput(() =>
    parseExperimentInput(experimentTransitionSchema, {
      ...mutation,
      transition: 'submit_results',
      evidence: { reason: 'Use a different result' },
    }),
  );
  assert.equal(
    parseExperimentInput(experimentTransitionSchema, {
      ...mutation,
      transition: 'mark_failed',
      evidence: { reason: ' Compute unavailable. ' },
    }).evidence?.reason,
    'Compute unavailable.',
  );
});

test('plain JSON boundary invokes no getters or normal/revoked proxy traps', () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get: () => {
        traps++;
        throw Error('get');
      },
      getPrototypeOf: () => {
        traps++;
        throw Error('prototype');
      },
      ownKeys: () => {
        traps++;
        throw Error('keys');
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty({}, 'experimentId', {
    enumerable: true,
    get() {
      traps++;
      throw Error('getter');
    },
  });
  for (const value of [
    proxy,
    revoked.proxy,
    getter,
    Object.create(proxy),
    Object.create(revoked.proxy),
    { experimentId: proxy },
  ])
    invalidInput(() => parseExperimentInput(experimentGetSchema, value));
  assert.equal(traps, 0);
  const ordinary = Object.assign(Object.create(null), {
    experimentId: 'exp_a',
    ignored: undefined,
  });
  assert.deepEqual(parseExperimentInput(experimentGetSchema, ordinary), { experimentId: 'exp_a' });
});

test('plain JSON boundary refuses cycles, sparse arrays, symbols, dangerous keys and resource excess', () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const symbol = { [Symbol('hidden')]: 1 };
  for (const value of [
    cycle,
    [, 1],
    [undefined],
    symbol,
    { x: Infinity },
    { x: NaN },
    JSON.parse('{"__proto__":{}}'),
    new Date(),
    {
      toJSON() {
        throw Error('must not run');
      },
    },
  ])
    invalidInput(() => copyExperimentJson(value));
  invalidInput(() => copyExperimentJson({ x: 'é'.repeat(10) }, { maxBytes: 20 }));
  invalidInput(() => copyExperimentJson([1, 2, 3], { maxNodes: 3 }));
  let deep: unknown = 1;
  for (let index = 0; index < 21; index++) deep = { x: deep };
  invalidInput(() => copyExperimentJson(deep));
});

test('retained evidence uses exact UTF-8 byte bounds and never caller byte accessors', () => {
  assert.equal(decodeEvidence(Buffer.from('é'.repeat(8000))).length, 8000);
  invalidEvidence(() => decodeEvidence(Buffer.from('é'.repeat(8001))));
  invalidEvidence(() => decodeEvidence(Buffer.from([0xc3, 0x28])));
  invalidEvidence(() => decodeEvidence(Buffer.alloc(0)));
  invalidEvidence(() => decodeEvidence(Buffer.from('  \n')));
  const bytes = new Uint8Array(Buffer.from('kept'));
  for (const key of ['byteLength', 'byteOffset', 'buffer'])
    Object.defineProperty(bytes, key, {
      get() {
        throw Error('must not read');
      },
    });
  assert.equal(decodeEvidence(bytes), 'kept');
});

test('plan and report gates require visible nonempty sections and retain conclusion text', () => {
  validatePlan(plan);
  validateReport(report, { exhibitPath: 'experiments/trial/metrics_exhibit.json' });
  assert.equal(reportConclusion(report), 'The result is inconclusive.');
  assert.equal(reportConclusion(plan), null);
  invalidEvidence(() => validatePlan(`<!--${plan}-->`));
  invalidEvidence(() => validatePlan(`\`\`\`markdown\n${plan}\`\`\``));
  invalidEvidence(() =>
    validatePlan(
      plan.replace('Use the declared comparison and confidence interval.', '<!-- placeholder -->'),
    ),
  );
  invalidEvidence(() =>
    validateReport(report.replace('See metrics_exhibit.json.', 'No exhibit.'), {
      exhibitPath: 'metrics_exhibit.json',
    }),
  );
  invalidEvidence(() =>
    validateReport(
      report.replace('See metrics_exhibit.json.', '<!-- metrics_exhibit.json -->A result.'),
      { exhibitPath: 'metrics_exhibit.json' },
    ),
  );
  validatePlan(plan.replace('# Evaluation', '## Evaluation protocol'));
});

test('figures must be retained, verified inline artifact references', () => {
  const withFigure = `${plan}\n![Comparison](art_figure "Measurements")\n![Again](<art_figure>)`;
  assert.deepEqual(markdownImageTargets(withFigure), ['art_figure']);
  validatePlan(withFigure, { figures: ['art_figure'] });
  invalidEvidence(() => validatePlan(withFigure));
  for (const figure of [
    '![X](https://example.com/a.png)',
    '![X](data:image/png;base64,abc)',
    '![X](../a.png)',
    '![X][image]',
    '<img src="art_figure">',
  ])
    invalidEvidence(() => markdownImageTargets(`${plan}\n${figure}`));
  assert.deepEqual(
    markdownImageTargets(
      `${plan}\n<!-- ![X](https://host/a) -->\n\`![X](https://host/a)\`\n\`\`\`\n![X](https://host/a)\n\`\`\``,
    ),
    [],
  );
});

test('graphs preserve original JSON metadata but require a bounded versioned DAG', () => {
  const graph = {
    version: 1,
    notes: { confidence: 0.5 },
    nodes: [
      { id: 'a', label: 'Claim', refs: ['clm_a'], evidence: ['observed'] },
      { id: 'b', label: 'Result' },
    ],
    edges: [{ from: 'a', to: 'b', relation: 'tested_by' }],
  };
  assert.deepEqual(validateGraph(JSON.stringify(graph)), graph);
  assert.deepEqual(validateGraph('{"version":1,"nodes":[{"id":"a","label":"Claim"}]}').edges, []);
  for (const delta of [
    { version: 2 },
    { nodes: [] },
    { nodes: Array.from({ length: 17 }, (_, i) => ({ id: String(i), label: 'Node' })) },
    { nodes: [graph.nodes[0], graph.nodes[0]] },
    { edges: [{ from: 'a', to: 'missing' }] },
    { edges: [{ from: 'a', to: 'a' }] },
    {
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    },
  ])
    invalidEvidence(() => validateGraph(JSON.stringify({ ...graph, ...delta })));
  invalidEvidence(() =>
    validateGraph('{"version":1,"nodes":[{"id":"a","label":"A"}],"score":1e999}'),
  );
});

test('explicit result format distinguishes any valid JSON including null from qualitative text', () => {
  for (const value of [
    null,
    false,
    0,
    'result',
    [1, 2],
    { measurements: [1, 2], conclusion: 'negative' },
  ])
    assert.deepEqual(parseResult(JSON.stringify(value), 'json'), value);
  assert.equal(parseResult('Observed no meaningful difference.', 'qualitative'), null);
  for (const text of ['{', 'NaN', '1e999', '{"score":1e999}'])
    invalidEvidence(() => parseResult(text, 'json'));
  assert.equal(shouldPinExhibit([{ resultFormat: 'json' }]), true);
  assert.equal(shouldPinExhibit([{ resultFormat: 'qualitative' }]), false);
});

const source = (
  path: string,
  data: MetricsResultSource['data'],
  resultFormat: MetricsResultSource['resultFormat'] = 'json',
): MetricsResultSource => ({
  path,
  data,
  resultFormat,
  artifactId: `art_${path.replace(/[^a-z]/g, '')}`,
  sha256: 'a'.repeat(64),
  submittedAt: '2026-09-15T00:00:00.000Z',
});
const metrics = {
  projectId: 'proj_a',
  experimentId: 'exp_a',
  attemptIndex: 1,
  startedAt: null,
  sources: [
    source('z.json', null),
    source('a.json', { z: [2, 1], a: false }),
    source('notes.txt', null, 'qualitative'),
  ],
};

test('metrics exhibit preserves source data/provenance and canonicalizes without clock or scoring', () => {
  const exhibit = buildMetricsExhibit(metrics),
    bytes = exhibitBytes(exhibit);
  assert.deepEqual(
    exhibit.resultFiles.map((file) => file.path),
    ['a.json', 'notes.txt', 'z.json'],
  );
  assert.deepEqual(exhibit.resultFiles[0].data, { z: [2, 1], a: false });
  assert.deepEqual(exhibit.verdict, { resultFiles: 3 });
  assert.deepEqual(exhibit.window, { startedAt: '' });
  assert.equal(exhibit.resultFiles[2].source.resultFormat, 'json');
  assert.equal(exhibit.resultFiles[1].source.resultFormat, 'qualitative');
  assert.equal(bytes.toString().endsWith('\n'), true);
  assert.deepEqual(
    bytes,
    exhibitBytes(buildMetricsExhibit({ ...metrics, sources: [...metrics.sources].reverse() })),
  );
  const changed = exhibitBytes(
    buildMetricsExhibit({ ...metrics, startedAt: '2026-09-15T00:00:01.000Z' }),
  );
  assert.notEqual(
    createHash('sha256').update(bytes).digest('hex'),
    createHash('sha256').update(changed).digest('hex'),
  );
  assert.deepEqual(JSON.parse(bytes.toString()), exhibit);
  metrics.sources[1].data = { altered: true };
  assert.deepEqual(exhibit.resultFiles[0].data, { z: [2, 1], a: false });
});

test('metrics reject ambiguous provenance, duplicate slots and malformed data without invoking accessors', () => {
  invalidEvidence(() =>
    buildMetricsExhibit({ ...metrics, sources: [source('a.json', 1), source('a.json', 2)] }),
  );
  invalidEvidence(() =>
    buildMetricsExhibit({ ...metrics, sources: [source('a.json', { value: 1 }, 'qualitative')] }),
  );
  invalidEvidence(() =>
    buildMetricsExhibit({ ...metrics, sources: [{ ...source('a.json', 1), sha256: 'fictional' }] }),
  );
  let called = 0;
  const hostile = Object.defineProperty({ ...metrics }, 'sources', {
    enumerable: true,
    get() {
      called++;
      throw Error('getter');
    },
  });
  invalidEvidence(() => buildMetricsExhibit(hostile));
  assert.equal(called, 0);
});

test('finite evidence preserves reserved-looking data keys without changing object prototypes', () => {
  const raw = '{"constructor":"Adam","prototype":{"rate":0.01},"__proto__":{"polluted":true}}';
  const value = parseResult(raw, 'json');
  assert.ok(value && typeof value === 'object');
  assert.deepEqual(value, JSON.parse(raw));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value!, '__proto__'), true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  const encoded = exhibitBytes(
    buildMetricsExhibit({ ...metrics, sources: [source('reserved.json', value)] }),
  );
  assert.deepEqual(JSON.parse(encoded.toString()).resultFiles[0].data, JSON.parse(raw));
  assert.equal(encoded.toString().includes('"__proto__": {'), true);
  const graph = JSON.parse(
    '{"version":1,"nodes":[{"id":"a","label":"A","__proto__":{"meaning":"data"}}],"constructor":"graph generator"}',
  );
  assert.deepEqual(validateGraph(JSON.stringify(graph)), { ...graph, edges: [] });
  assert.equal(Object.hasOwn(validateGraph(JSON.stringify(graph)).nodes[0], '__proto__'), true);
  invalidInput(() => copyExperimentJson(JSON.parse(raw)));
});
