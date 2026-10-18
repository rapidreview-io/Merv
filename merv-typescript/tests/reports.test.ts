import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, MervError, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReportService, parseReport } from '@merv/reports';
import { draftFromPlan } from '@merv/reports/prefill';
import { ReportRenderer } from '../packages/reports/src/render.js';
import { reportsToolsPlugin } from '@merv/reports/tools';
import type { ToolDefinition } from '@merv/api/types';
import type { Context } from 'cordis';
import { openState } from './fixtures/state.js';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof MervError && error.code === code;

/** A Chromium for rendering: MERV_REPORTS_CHROMIUM, else Playwright's cached build. */
function chromium(): string | undefined {
  if (process.env.MERV_REPORTS_CHROMIUM) return process.env.MERV_REPORTS_CHROMIUM;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse()) {
    for (const build of ['chrome-mac-arm64', 'chrome-mac']) {
      const app = join(
        cache,
        dir,
        build,
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing',
      );
      if (existsSync(app)) return app;
    }
    const linux = join(cache, dir, 'chrome-linux', 'chrome');
    if (existsSync(linux)) return linux;
  }
  return undefined;
}
const browser = chromium();

const PLAN = {
  id: 'EXP-1',
  question: 'Question: Does the new tokenizer improve NER',
  inquiry:
    'The current tokenizer splits Portuguese legal terms badly. We test whether a domain tokenizer helps NER.',
  constraints: ['NER macro-F1 improves by at least 1.0', 'Budget 10 GPU-hours'],
  method: '| Arm | What it varies |\n|---|---|\n| A | base tokenizer |\n| B | domain tokenizer |',
};

const COMPLETE = {
  frontMatter: 'id: "EXP-1"\ndate: "2026-10-14"\ncriteria:\n  - {metric: "NER macro-F1", bar: 1.0}',
  sections: [
    {
      name: 'Result',
      content: `Yes: NER improves by 1.8 F1.

\`\`\`chart
{"id": "results", "message": "NER clears its bar.", "data": {"values": [{"metric": "NER macro-F1", "delta": 1.8, "lo": 1.1, "hi": 2.5}]},
 "y": {"field": "metric"}, "x": {"title": "Δ vs baseline", "domain": [-1, 3]},
 "layer": [{"mark": "rule", "x": "lo", "x2": "hi", "size": "l", "emphasis": "low", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}},
           {"mark": "point", "x": "delta", "size": "l", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}},
           {"mark": "tick", "x": "bar", "style": "dashed", "size": "s"}]}
\`\`\``,
    },
    {
      name: 'Method',
      content:
        'Both arms fine-tune identically, 3 epochs, seeds 0–4. Intervals are t-based over paired seed differences.',
    },
    {
      name: 'Execution',
      content: `Ten jobs ran in 2 h 10 m: 6.1 of 10 GPU-hours.

\`\`\`chart
{"id": "loss", "message": "Training converged smoothly.", "data": {"file": "loss.csv"}, "x": {"field": "step", "title": "step"}, "y": {"field": "loss", "title": "loss", "zero": false},
 "layer": [{"mark": "line", "color": "ink"}]}
\`\`\``,
    },
    {
      name: 'Data',
      content: '| Dataset | Use | Train / test |\n|---|---|---|\n| LeNER-Br | NER | 7.8k / 1.4k |',
    },
    {
      name: 'Verification',
      content: 'Metrics were recomputed from the evaluation logs; all matched.',
    },
    { name: 'Limitations', content: '- One tokenizer vocabulary size was tried.' },
  ],
  files: [
    { name: 'loss.csv', content: 'step,loss\n0,2.0\n100,1.6\n200,1.4\n300,1.35\n400,1.32\n' },
  ],
};

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'reports-'));
  const state = await openState(dir);
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(dir, 'blobs'))),
  );
  const reports = await createService(
    new ReportService(state, scope, artifacts, new ReportRenderer(browser)),
  );
  const boot = await scope.credentials.bootstrap({ projectName: 'Reports', actorName: 'Owner' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.credentials.issueActor(operator, { name: 'reader', role: 'reader' });
  const reader: Caller = {
    projectId: operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const allowed = new Set<string>();
  reports.registerSubject('experiment', {
    async authorize(caller, id, mode) {
      if (!allowed.has(id) && mode === 'write')
        throw new MervError('forbidden', 'not this worker', 403);
    },
    async prefill() {
      return draftFromPlan(PLAN, '2026-10-14');
    },
  });
  let n = 0;
  t.after(async () => {
    await reports.close();
    await state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const subject = (id: string) => ({ subjectKind: 'experiment' as const, subjectId: id });
  return { reports, artifacts, operator, reader, allowed, subject, request: () => `r-${++n}` };
}

test('a draft opens once from the plan, locks the plan sections, and persists edits', async (t) => {
  const f = await fixture(t);
  f.allowed.add('exp_1');
  const first = await f.reports.open(f.operator, f.subject('exp_1'));
  assert.equal(first.revision, 1);
  assert.match(first.source, /^# Does the new tokenizer improve NER\?$/m);
  assert.match(first.source, /- NER macro-F1 improves by at least 1\.0/);
  assert.match(first.source, /\| B \| domain tokenizer \|/);
  assert.deepEqual(first.locked, ['title', 'Inquiry', 'Constraints']);
  assert.equal((await f.reports.open(f.operator, f.subject('exp_1'))).reportId, first.reportId);

  const written = await f.reports.write(f.operator, {
    ...f.subject('exp_1'),
    expectedRevision: 1,
    requestId: f.request(),
    ...COMPLETE,
  });
  assert.equal(written.revision, 2);
  assert.deepEqual(written.files, [
    { name: 'loss.csv', bytes: Buffer.byteLength(COMPLETE.files[0].content) },
  ]);
  // The draft is what the next round edits: a later open returns it, not a fresh prefill.
  const reopened = await f.reports.open(f.operator, f.subject('exp_1'));
  assert.equal(reopened.revision, 2);
  assert.match(reopened.source, /Yes: NER improves by 1\.8 F1\./);

  await assert.rejects(
    f.reports.write(f.operator, {
      ...f.subject('exp_1'),
      expectedRevision: 2,
      requestId: f.request(),
      sections: [{ name: 'Inquiry', content: 'Something else.' }],
    }),
    hasCode('report_locked_section'),
  );
  await assert.rejects(
    f.reports.write(f.operator, {
      ...f.subject('exp_1'),
      expectedRevision: 2,
      requestId: f.request(),
      sections: [{ name: 'title', content: 'Another question?' }],
    }),
    hasCode('report_locked_section'),
  );
  await assert.rejects(
    f.reports.write(f.operator, {
      ...f.subject('exp_1'),
      expectedRevision: 1,
      requestId: f.request(),
      sections: [{ name: 'Method', content: 'x' }],
    }),
    hasCode('report_revision_conflict'),
  );
  // A retried request replays its receipt rather than writing twice.
  const input = {
    ...f.subject('exp_1'),
    expectedRevision: 2,
    requestId: 'same',
    sections: [{ name: 'Method', content: 'Edited method.' }],
  };
  const once = await f.reports.write(f.operator, input);
  assert.equal((await f.reports.write(f.operator, input)).revision, once.revision);

  const cleared = await f.reports.clear(f.operator, {
    ...f.subject('exp_1'),
    expectedRevision: 3,
    requestId: f.request(),
  });
  assert.equal(cleared.revision, 4);
  assert.equal(cleared.source, first.source);
  assert.deepEqual(cleared.files, []);
});

test('only an authorized subject caller edits, and check names every unfinished part', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.reports.open(f.operator, f.subject('exp_2')), hasCode('forbidden'));
  f.allowed.add('exp_2');
  await f.reports.open(f.operator, f.subject('exp_2'));
  await assert.rejects(f.reports.open(f.reader, f.subject('exp_2')), hasCode('forbidden'));
  const draft = await f.reports.check(f.operator, f.subject('exp_2'));
  const text = draft.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(text, /placeholders/);
  assert.match(text, /needs one chart/);
  const done = await f.reports.write(f.operator, {
    ...f.subject('exp_2'),
    expectedRevision: 1,
    requestId: f.request(),
    ...COMPLETE,
  });
  const checked = await f.reports.check(f.operator, f.subject('exp_2'));
  assert.deepEqual(
    checked.issues.filter((i) => i.level === 'error'),
    [],
  );
  assert.deepEqual(
    checked.charts.map((c) => [c.id, c.approved]),
    [
      ['results', false],
      ['loss', false],
    ],
  );
  // A result row whose metric matches no criterion is an error, not a silent pass.
  const renamed = await f.reports.write(f.operator, {
    ...f.subject('exp_2'),
    expectedRevision: done.revision,
    requestId: f.request(),
    frontMatter:
      'id: "EXP-1"\ndate: "2026-10-14"\ncriteria:\n  - {metric: NER, macro-F1, bar: 1.0}',
  });
  const broken = await f.reports.check(f.operator, f.subject('exp_2'));
  assert.ok(
    broken.issues.some((i) => /quote a metric name/.test(i.message)),
    JSON.stringify(broken.issues),
  );
  assert.ok(renamed.revision > done.revision);
});

test('format rules: answer length, captions, unknown sections and citations', () => {
  const report = parseReport(`---
id: X
date: Y
---
# Q?
## Inquiry
Why.
## Constraints
- c
## Result
This answer line is far too long to be a one line answer for any reader at all.
## Method
Figure 1: a caption.
## Execution
E [3].
## Data
D
## Verification
V
## Limitations
- L
## Appendix
A
`);
  const text = report.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
  assert.match(text, /Result: the answer is 18 words; the limit is 15/);
  assert.match(text, /Method: captions are not allowed/);
  assert.match(text, /Appendix: unknown section/);
  assert.match(text, /\[3\] is cited but there is no reference 3/);
});

test(
  'charts are reviewed one at a time, approved, and rendered final to artifacts',
  { skip: !browser && 'no Chromium for rendering' },
  async (t) => {
    const f = await fixture(t);
    f.allowed.add('exp_3');
    await f.reports.open(f.operator, f.subject('exp_3'));
    let rev = (
      await f.reports.write(f.operator, {
        ...f.subject('exp_3'),
        expectedRevision: 1,
        requestId: f.request(),
        ...COMPLETE,
      })
    ).revision;
    await assert.rejects(
      f.reports.render(f.operator, { ...f.subject('exp_3'), final: true, requestId: f.request() }),
      hasCode('report_visuals_unapproved'),
    );
    const review = await f.reports.reviewVisual(f.operator, f.subject('exp_3'));
    assert.equal(review.chart, 'results');
    assert.equal(review.section, 'Result');
    assert.ok(Buffer.from(review.image, 'base64').subarray(1, 4).toString() === 'PNG');
    assert.deepEqual(review.remaining, ['loss']);
    for (const chartId of ['results', 'loss'])
      rev = (
        await f.reports.approveVisual(f.operator, {
          ...f.subject('exp_3'),
          chartId,
          expectedRevision: rev,
          requestId: f.request(),
        })
      ).revision;
    const preview = await f.reports.render(f.operator, f.subject('exp_3'));
    assert.equal(preview.pages, 1);
    assert.equal(preview.images.length, 1);
    assert.equal(preview.final, null);

    const final = await f.reports.render(f.operator, {
      ...f.subject('exp_3'),
      final: true,
      requestId: 'final-1',
    });
    assert.ok(final.final);
    const [source, pdf, page] = await f.artifacts.getAll(f.operator, [
      final.final.sourceArtifactId,
      final.final.pdfArtifactId,
      final.final.pageArtifactIds[0],
    ]);
    assert.equal(source.mediaType, 'text/markdown');
    assert.equal(pdf.mediaType, 'application/pdf');
    assert.equal(page.mediaType, 'image/png');
    const found = await f.reports.finalFor(f.operator, final.final.sourceArtifactId);
    assert.equal(found?.subject.id, 'exp_3');
    assert.equal(found?.answer, 'Yes: NER improves by 1.8 F1.');
    assert.equal(await f.reports.finalFor(f.operator, final.final.pdfArtifactId), null);

    // Changing a chart's data withdraws its approval; a final render then needs a fresh review.
    await f.reports.write(f.operator, {
      ...f.subject('exp_3'),
      expectedRevision: final.revision,
      requestId: f.request(),
      files: [{ name: 'loss.csv', content: 'step,loss\n0,2\n100,1.5\n' }],
    });
    const checked = await f.reports.check(f.operator, f.subject('exp_3'));
    assert.deepEqual(
      checked.charts.map((c) => [c.id, c.approved]),
      [
        ['results', true],
        ['loss', false],
      ],
    );
  },
);

test('report tools present chart and page images to MCP clients', async () => {
  const tools = new Map<string, ToolDefinition>();
  const calls: string[] = [];
  const fake = new Proxy(
    {},
    {
      get: (_, name: string) => async () => {
        calls.push(name);
        return name === 'reviewVisual'
          ? { chart: 'results', image: 'AAA', context: 'BBB', issues: [] }
          : name === 'render'
            ? { pages: 1, images: ['CCC'], final: null, issues: [] }
            : { revision: 1 };
      },
    },
  );
  reportsToolsPlugin.apply({
    reports: fake,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (t: ToolDefinition) => tools.set(t.name, t),
      contributeInstructions() {},
      contributeContext() {},
    },
  } as unknown as Context);
  assert.deepEqual([...tools.keys()].sort(), [
    'report.approve_visual',
    'report.check',
    'report.clear',
    'report.open',
    'report.render',
    'report.review_visual',
    'report.write',
  ]);
  const visual = tools.get('report.review_visual')!;
  const shown = visual.present!(await visual.handler({} as Caller, {}));
  assert.deepEqual(
    shown.content.map((c) => c.type),
    ['text', 'image', 'image'],
  );
  assert.ok(!JSON.parse((shown.content[0] as { text: string }).text).image);
  const render = tools.get('report.render')!;
  assert.deepEqual(
    render.present!(await render.handler({} as Caller, {})).content.map((c) => c.type),
    ['text', 'image'],
  );
  const open = (await tools.get('report.open')!.handler({} as Caller, {})) as { guide: string };
  assert.match(open.guide, /report\.review_visual/);
  // Agents are told a locked section the plan left as a placeholder is theirs to write: told
  // only that locked sections never change, a healer reported a fixed template as broken.
  assert.match(
    open.guide,
    /locked, except a locked section the plan left as only a \[\[write: …\]\]/,
  );
  assert.match(
    tools.get('report.write')!.description,
    /cannot change, except one that still holds only its \[\[write: …\]\] placeholder/,
  );
});

test('a locked section the plan left as a placeholder is written once, then stays', async (t) => {
  const f = await fixture(t);
  f.reports.registerSubject('customer_experiment', {
    async authorize() {},
    async prefill() {
      return draftFromPlan({ ...PLAN, inquiry: '' }, '2026-10-14');
    },
  });
  const subject = { subjectKind: 'customer_experiment' as const, subjectId: 'ce_1' };
  const first = await f.reports.open(f.operator, subject);
  assert.match(first.source, /\[\[write: why this was asked/);
  const written = await f.reports.write(f.operator, {
    ...subject,
    expectedRevision: first.revision,
    requestId: f.request(),
    sections: [{ name: 'Inquiry', content: 'To shortlist models for a larger evaluation.' }],
  });
  assert.match(written.source, /To shortlist models for a larger evaluation\./);
  const checked = await f.reports.check(f.operator, subject);
  assert.ok(
    !checked.issues.some((i) => i.where?.includes('Inquiry')),
    JSON.stringify(checked.issues),
  );
  // The sections the plan did fill stay locked.
  await assert.rejects(
    f.reports.write(f.operator, {
      ...subject,
      expectedRevision: written.revision,
      requestId: f.request(),
      sections: [{ name: 'title', content: 'Another question?' }],
    }),
    hasCode('report_locked_section'),
  );
});

test('a plan that set no numeric bar charts its measured results with criteria: []', async (t) => {
  const f = await fixture(t);
  f.allowed.add('exp_x');
  const first = await f.reports.open(f.operator, f.subject('exp_x'));
  assert.match(first.source, /^criteria: \[\]$/m);
  const leaderboard = `Kev-9B and Kev-27B tie for the most correct answers.

\`\`\`chart
{"id": "leaderboard", "message": "Two checkpoints tie at 22 of 24.", "data": {"values": [{"model": "Kev-9B", "correct": 22}, {"model": "Kev-27B", "correct": 22}, {"model": "JEV", "correct": 20}]},
 "y": {"field": "model"}, "x": {"field": "correct", "title": "correct of 24", "domain": [0, 24]},
 "layer": [{"mark": "bar", "color": "result"}]}
\`\`\``;
  const written = await f.reports.write(f.operator, {
    ...f.subject('exp_x'),
    expectedRevision: first.revision,
    requestId: f.request(),
    ...COMPLETE,
    frontMatter: 'id: "EXP-1"\ndate: "2026-10-14"\ncriteria: []',
    sections: [{ name: 'Result', content: leaderboard }, ...COMPLETE.sections.slice(1)],
  });
  // No invented bar is needed: the chart is checked as it stands, and a warning names the rule.
  const checked = await f.reports.check(f.operator, f.subject('exp_x'));
  assert.deepEqual(
    checked.issues.filter((i) => i.level === 'error'),
    [],
  );
  assert.ok(
    checked.issues.some((i) => i.where === 'front matter' && /no numeric bar/.test(i.message)),
    JSON.stringify(checked.issues),
  );
  if (!browser) return;
  const review = await f.reports.reviewVisual(f.operator, {
    ...f.subject('exp_x'),
    chartId: 'leaderboard',
  });
  assert.equal(review.revision, written.revision);
  assert.deepEqual(
    review.issues.filter((i) => i.level === 'error'),
    [],
  );
});
