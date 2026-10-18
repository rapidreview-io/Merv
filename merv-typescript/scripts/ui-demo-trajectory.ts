import type { Caller, Data, ReviewApplication } from '@merv/contracts';
import type { AgentEvent } from '@merv/sessions/agent-stream';
import { currentExperiment } from '../tests/fixtures/current-experiment.js';
import type { currentWork } from '../tests/fixtures/current-work.js';
import { post } from './ui-demo-running.js';

/**
 * One experiment with a whole agent trajectory, for the record page's Agents tab (`--trajectory`):
 * four leased sessions walk it through its stages, a design visit, its review, the execution
 * and its review, each a real lease (offer, attach, the tool calls as the session's worker, a
 * release) that streams a scripted conversation: thoughts, messages, web searches, reads,
 * edits, commands, sandbox jobs, Merv calls and two failures. Then the clock is rewritten so
 * the sessions stand hours apart and each call took as long as such a call takes.
 */

type Work = ReturnType<typeof currentWork>;
type Held = Awaited<ReturnType<Work['lease']>>;
/** A step: a thought, a message, a tool call with its scripted answer, or a real Merv call. */
type Step =
  | { kind: 'thinking' | 'text'; text: string; seconds: number }
  | { kind: 'call'; name: string; input: Data; output: string; seconds: number; error?: boolean }
  | { kind: 'do'; name: string; input: Data; seconds: number };

const T = (text: string, seconds = 20): Step => ({ kind: 'thinking', text, seconds });
const S = (text: string, seconds = 6): Step => ({ kind: 'text', text, seconds });
const C = (name: string, input: Data, output: string, seconds = 3, error = false): Step => ({
  kind: 'call',
  name,
  input,
  output,
  seconds,
  error,
});
const DO = (name: string, input: Data = {}, seconds = 2): Step => ({
  kind: 'do',
  name,
  input,
  seconds,
});
const search = (query: string, hits: string[], seconds = 5) =>
  C('WebSearch', { query }, hits.map((hit, i) => `${i + 1}. ${hit}`).join('\n'), seconds);
const read = (file_path: string, lines: string, seconds = 1) =>
  C('Read', { file_path }, lines, seconds);
const edit = (file_path: string, old_string: string, new_string: string) =>
  C('Edit', { file_path, old_string, new_string }, 'The file has been updated.', 2);
const sh = (command: string, output: string, seconds = 4, error = false) =>
  C('Bash', { command }, output, seconds, error);

const NAME = 'decay-sweep-p97-trajectory';
const plan = [
  '## Summary',
  'Question: Does the grokking step fall as weight decay grows at p = 97?',
  '## Objective and hypothesis',
  'Stronger weight decay brings the step at which held-out accuracy crosses 95% earlier, monotonically over 0.3, 1.0 and 3.0.',
  '## Evaluation',
  '| Arm | Weight decay |',
  '|---|---|',
  '| Low | 0.3 |',
  '| Mid | 1.0 |',
  '| High | 3.0 |',
  '',
  '- Primary measure: the first step with held-out accuracy at or over 95%.',
  '- Success: the step falls strictly across the three decays, each within 20k steps.',
  '- Budget: one A100 for an afternoon; one seed per arm.',
].join('\n');

const design: Step[] = [
  T(
    'The question is whether weight decay moves the grokking step earlier. I should check what the literature already says before fixing the sweep.',
    35,
  ),
  search('grokking weight decay modular arithmetic transformer', [
    'Power et al. 2022, Grokking: generalization beyond overfitting',
    'Nanda et al. 2023, Progress measures for grokking',
    'Liu et al. 2022, Omnigrok: grokking beyond algorithmic data',
  ]),
  search('grokking step vs weight decay sweep p=97', [
    'Varma et al. 2023, Explaining grokking through circuit efficiency',
    'Thilak et al. 2022, the slingshot mechanism',
  ]),
  C(
    'WebFetch',
    {
      url: 'https://arxiv.org/abs/2301.05217',
      prompt: 'How does weight decay change the grokking step?',
    },
    'Larger weight decay shortens the delay between memorisation and generalisation; the paper sweeps 0.1 to 3.0.',
    7,
  ),
  T(
    'Two papers sweep decay but neither fixes the seed or reports the crossing step directly. A three-point sweep at p = 97 with one seed is enough for a first answer.',
    40,
  ),
  read('/work/README.md', '# modular-grokking\nTrain a 1-layer transformer on (a + b) mod p.'),
  read(
    '/work/src/train.py',
    'def train(config):\n    ...\n    if held_out_acc >= 0.95: log_crossing(step)',
  ),
  read('/work/configs/base.yaml', 'p: 97\ntrain_frac: 0.5\nsteps: 20000\nweight_decay: 1.0'),
  C('Grep', { pattern: 'weight_decay', path: '/work/src' }, 'src/train.py:41\nsrc/optim.py:12', 1),
  S(
    'The repository already logs the crossing step. The plan is a three-decay sweep, one seed, 20k steps each; pass if the step falls monotonically.',
    8,
  ),
  DO('experiment.get_state'),
  DO('artifact.create', { title: `Plan: ${NAME}`, content: plan, mediaType: 'text/markdown' }, 3),
  DO('experiment.attach', { role: 'plan', path: 'plan.md' }),
  sh('nvidia-smi --query-gpu=name --format=csv,noheader', 'NVIDIA A100-SXM4-40GB', 2),
  T(
    'Feasibility: the table is generated by the harness and one GPU afternoon covers three 20k-step runs.',
    15,
  ),
  DO(
    'artifact.create',
    {
      title: `Feasibility: ${NAME}`,
      content: JSON.stringify({
        formatVersion: 1,
        resources: [
          {
            kind: 'data',
            name: 'modular addition p=97',
            unit: 'examples',
            required: 9409,
            available: 9409,
            basis: 'The harness generates the whole table.',
          },
          {
            kind: 'compute',
            name: 'single GPU',
            unit: 'hours',
            required: 3,
            available: 8,
            basis: 'lab-gpu-01 reports eight idle hours.',
          },
        ],
        dependencies: [{ name: 'evaluation harness', present: true, basis: 'In this project.' }],
        blockers: [],
      }),
      mediaType: 'application/json',
    },
    3,
  ),
  DO('experiment.attach', { role: 'feasibility', path: 'feasibility.json' }),
  T('Submitting the design; the reviewer will check the evaluation rule.', 12),
  DO('experiment.transition', { transition: 'submit_design' }),
  S('Design submitted for review.', 3),
];
const designReview: Step[] = [
  T(
    'A design review: can the plan test its claim? Three points and one seed is thin, but the claim is monotonic ordering, not an effect size.',
    45,
  ),
  DO('experiment.get_state'),
  DO('review.get'),
  read('/work/configs/base.yaml', 'p: 97\ntrain_frac: 0.5\nsteps: 20000'),
  search('one seed grokking variance crossing step', [
    'Seed variance in grokking is large for small decay (Nanda 2023, fig. 7)',
  ]),
  T(
    'With one seed the smallest decay may not grok within 20k steps; the plan says that is a fail, which is the honest reading.',
    30,
  ),
  S(
    'The design can answer its question: the pass rule is pre-registered and the resources are in hand. Noting the one-seed caveat for the report.',
    8,
  ),
  DO(
    'review.submit',
    {
      synopsis:
        'The plan can test its claim on the stated resources; one seed per arm is the known limit.',
      notes: 'Approving the design.',
    },
    3,
  ),
];
const run: Step[] = [
  T(
    'Execution. Three runs on the lab GPU, then the crossing steps into results.json and a report.',
    25,
  ),
  DO('experiment.get_state'),
  sh('nvidia-smi --query-gpu=name,memory.used --format=csv', 'NVIDIA A100-SXM4-40GB, 0 MiB', 2),
  sh('git status --short && git log --oneline -1', 'a41f2c9 Log crossing step', 2),
  read('/work/src/train.py', 'def train(config):\n    for step in range(config.steps):'),
  edit('/work/configs/base.yaml', 'weight_decay: 1.0', 'weight_decay: ${WD}'),
  sh('pytest -q tests/test_train.py', '3 passed in 4.2s', 9),
  C(
    'sandbox.request',
    { hardware: 'gpu', ttlMinutes: 240 },
    '{"sandboxId":"sbx_lab01","status":"ready"}',
    40,
  ),
  C(
    'sandbox.runs',
    { sandboxId: 'sbx_lab01', command: 'WD=0.3 python src/train.py --out runs/wd0.3' },
    '{"runId":"run_wd03","status":"finished"}',
    1500,
  ),
  sh(
    'tail -n 2 runs/wd0.3/log.txt',
    'step 14000 train 1.00 held_out 0.91\nstep 14200 train 1.00 held_out 0.96 crossing',
    3,
  ),
  S('Decay 0.3 crossed 95% at step 14,200.', 5),
  C(
    'sandbox.runs',
    { sandboxId: 'sbx_lab01', command: 'WD=1.0 python src/train.py --out runs/wd1.0' },
    '{"runId":"run_wd10","status":"finished"}',
    1100,
  ),
  sh('tail -n 1 runs/wd1.0/log.txt', 'step 9810 train 1.00 held_out 0.95 crossing', 3),
  C(
    'sandbox.runs',
    { sandboxId: 'sbx_lab01', command: 'WD=3.0 python src/train.py --out runs/wd3.0' },
    'Error: CUDA out of memory. Tried to allocate 2.00 GiB',
    95,
    true,
  ),
  T('OOM at decay 3.0: the eval batch is full-size. Halve it; it only changes evaluation.', 30),
  edit('/work/src/train.py', 'eval_batch = len(held_out)', 'eval_batch = len(held_out) // 2'),
  sh('pytest -q tests/test_train.py', '3 passed in 4.4s', 9),
  C(
    'sandbox.runs',
    { sandboxId: 'sbx_lab01', command: 'WD=3.0 python src/train.py --out runs/wd3.0' },
    '{"runId":"run_wd30","status":"finished"}',
    820,
  ),
  sh('tail -n 1 runs/wd3.0/log.txt', 'step 6050 train 1.00 held_out 0.97 crossing', 3),
  sh(
    'python scripts/collect.py runs/ > results.json && cat results.json',
    '{"grokking_step": {"0.3": 14200, "1.0": 9810, "3.0": 6050}}',
    6,
  ),
  sh(
    'python scripts/plot.py results.json --out figures/crossing.png',
    'wrote figures/crossing.png',
    8,
  ),
  C(
    'sandbox.pull_outputs',
    { sandboxId: 'sbx_lab01', paths: ['results.json', 'figures/crossing.png'] },
    '{"pulled":2}',
    12,
  ),
  C('sandbox.release', { sandboxId: 'sbx_lab01' }, '{"released":true}', 3),
  S('All three arms grokked. The step falls monotonically: 14,200, 9,810, 6,050.', 6),
  DO(
    'artifact.create',
    {
      title: `Results: ${NAME}`,
      content: JSON.stringify({ grokking_step: { '0.3': 14200, '1.0': 9810, '3.0': 6050 } }),
      mediaType: 'application/json',
    },
    3,
  ),
  DO('experiment.attach', { role: 'result', path: 'results.json' }),
  T('The report: a one-line answer, the chart, the OOM deviation and the one-seed caveat.', 60),
  DO('report.open'),
  DO(
    'report.write',
    {
      frontMatter: `id: "${NAME}"\ndate: "2026-10-16"\ncriteria:\n  - {metric: "Step at decay 0.3", bar: 20000}\n  - {metric: "Step at decay 1.0", bar: 20000}\n  - {metric: "Step at decay 3.0", bar: 20000}`,
      sections: [
        {
          name: 'Result',
          content:
            'Yes: the grokking step falls with decay, from 14,200 to 6,050.\n\n```chart\n{"id": "results", "message": "Stronger decay groks sooner.", "data": {"values": [{"metric": "Step at decay 0.3", "delta": 14200, "lo": 13300, "hi": 15100, "status": "met", "bar": 20000}, {"metric": "Step at decay 1.0", "delta": 9810, "lo": 9110, "hi": 10510, "status": "met", "bar": 20000}, {"metric": "Step at decay 3.0", "delta": 6050, "lo": 5550, "hi": 6550, "status": "met", "bar": 20000}]}, "y": {"field": "metric"}, "x": {"title": "Grokking step (bar: grokked within 20k)", "domain": [0, 20000]}, "layer": [{"mark": "rule", "x": "lo", "x2": "hi", "size": "l", "emphasis": "low", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}}, {"mark": "point", "x": "delta", "size": "l", "color": {"field": "status", "map": {"met": "result", "not met": "warn"}}}, {"mark": "tick", "x": "bar", "style": "dashed", "size": "s"}]}\n```',
        },
        {
          name: 'Method',
          content:
            'One-layer transformer on modular addition at p = 97, three weight decays, one seed each; the grokking step is the first with held-out accuracy at or over 95%.',
        },
        {
          name: 'Execution',
          content:
            'Three runs on lab-gpu-01 in 1 h 40 m: 1.7 GPU-hours. The decay 3.0 run was restarted after an out-of-memory error with a halved evaluation batch.',
        },
        {
          name: 'Data',
          content:
            '| Dataset | Use | Train / test |\n|---|---|---|\n| (a + b) mod 97 | all arms | 4.7k / 4.7k |',
        },
        { name: 'Verification', content: 'Crossing steps were recomputed from the run logs.' },
        {
          name: 'Limitations',
          content: '- One seed per arm: the intervals are run-to-run estimates.',
        },
      ],
    },
    45,
  ),
  DO('report.approve_visual', { chartId: 'results' }),
  DO('report.render', { final: true }, 8),
  DO('experiment.attach', { role: 'report', path: 'report.md' }),
  DO('experiment.transition', { transition: 'submit_results' }),
  S('Results submitted.', 3),
];
const resultsReview: Step[] = [
  T(
    'Attempt review: do the results answer the pre-registered rule, and was the deviation harmless?',
    40,
  ),
  DO('experiment.get_state'),
  DO('review.get'),
  read('/work/results.json', '{"grokking_step": {"0.3": 14200, "1.0": 9810, "3.0": 6050}}'),
  sh(
    'python - <<EOF\nimport json; r=json.load(open("results.json"))["grokking_step"]; print(sorted(r.values(), reverse=True)==list(r.values()))\nEOF',
    'True',
    3,
  ),
  C(
    'Grep',
    { pattern: 'eval_batch', path: '/work/src/train.py' },
    'src/train.py:88: eval_batch = len(held_out) // 2',
    1,
  ),
  T(
    'Halving the evaluation batch changes nothing about the crossing step. The ordering holds strictly. Pass, with the one-seed caveat already in the report.',
    35,
  ),
  S('The evidence answers the question as planned; the deviation is cosmetic.', 6),
  DO(
    'review.submit',
    {
      synopsis: 'The three arms grokked and the step falls strictly with decay.',
      notes: 'Passing.',
    },
    3,
  ),
];

export async function seedTrajectory(
  app: { ctx: any },
  input: { url: string; token: string; work: Work; producerCaller: Caller; reviewerCaller: Caller },
) {
  const { ctx } = app;
  const { url, token, work } = input;
  const experiment = await currentExperiment(ctx, input.producerCaller, {
    name: NAME,
    intent: 'Does the grokking step fall as weight decay grows at p = 97?',
    details: 'Three decays on the p = 97 reproduction, one seed each.',
    requestId: 'demo-trajectory-experiment',
  });
  const state = async () => ctx.experiments.get(input.producerCaller, experiment.id);
  let lastArtifact = '';
  let reportRevision = 0;
  const subject = { subjectKind: 'experiment' as const, subjectId: experiment.id };

  /** One session: leased, its steps played (the Merv ones for real), streamed, released. */
  const visit = async (role: Caller, steps: Step[], startAt: number) => {
    const current = await state();
    // A continuing producer's next offer waits out the previous visit's conversation grace.
    const lease = async (): Promise<Held> => {
      for (let tries = 0; ; tries++)
        try {
          return await work.lease(current);
        } catch (error) {
          if ((error as { code?: string }).code !== 'conversation_pending' || tries > 40)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    };
    const held = await lease();
    const events: AgentEvent[] = [];
    const times: number[] = [];
    let clock = startAt + 20_000;
    let n = 0;
    const review = current.reviewId
      ? await ctx.reviews.get(held.worker, current.reviewId)
      : undefined;
    for (const step of steps) {
      const id = `${held.session.id}-${++n}`;
      if (step.kind === 'thinking' || step.kind === 'text') {
        events.push({ kind: step.kind, id, delta: step.text, done: true });
        times.push(clock);
        clock += step.seconds * 1000;
        continue;
      }
      const act = step as Extract<Step, { kind: 'call' | 'do' }>;
      let args: Data = act.input;
      let output = act.kind === 'call' ? act.output : '';
      let error = act.kind === 'call' ? !!act.error : false;
      if (act.kind === 'do') {
        const name = act.name;
        const now = await state();
        const stamp = {
          expectedRevision: now.workflow.revision,
          requestId: `demo-trajectory-${name}-${now.workflow.revision}-${String(args.role ?? args.transition ?? '')}`,
        };
        const handler = async (): Promise<unknown> => {
          const as = <T>(
            tool: string,
            bound: Data,
            fn: (caller: Caller, bound: Data) => Promise<T>,
          ) => work.run(held, tool, bound, fn);
          switch (name) {
            case 'experiment.get_state':
              return as(name, { experimentId: experiment.id }, (caller, bound) =>
                ctx.experiments.get(caller, bound.experimentId as string),
              );
            case 'artifact.create':
              return as(name, args, (caller, bound) => ctx.artifacts.create(caller, bound));
            case 'experiment.attach':
              return as(
                name,
                {
                  experimentId: experiment.id,
                  artifactId: lastArtifact,
                  attemptIndex: now.attempt.index,
                  ...args,
                  ...stamp,
                },
                (caller, bound) => ctx.experiments.attach(caller, bound),
              );
            case 'experiment.transition':
              return as(name, { experimentId: experiment.id, ...args, ...stamp }, (caller, bound) =>
                ctx.experiments.transition(caller, bound),
              );
            case 'review.get':
              return as(name, { reviewId: review!.id }, (caller, bound) =>
                ctx.reviews.get(caller, bound.reviewId as string),
              );
            case 'review.submit':
              return as(
                name,
                {
                  reviewId: review!.id,
                  ...(review!.claimId ? { claimId: review!.claimId } : {}),
                  expectedRevision: review!.subjectRevision,
                  verdict: 'pass',
                  findings: (review!.criteria as string[]).map((_, index) => ({
                    criterionNumber: index + 1,
                    status: 'met',
                    evidenceIds: [...review!.artifactIds],
                    notes: 'Checked against the pinned evidence.',
                  })),
                  requestId: `demo-trajectory-verdict-${review!.id}`,
                  ...args,
                },
                (caller, bound) => ctx.reviews.apply(caller, bound as unknown as ReviewApplication),
              );
            case 'report.open':
              return as(name, subject, (caller, bound) => ctx.reports.open(caller, bound));
            case 'report.write':
              return as(
                name,
                {
                  ...subject,
                  ...args,
                  expectedRevision: reportRevision,
                  requestId: `demo-trajectory-report-write`,
                },
                (caller, bound) => ctx.reports.write(caller, bound),
              );
            case 'report.approve_visual':
              return as(
                name,
                {
                  ...subject,
                  ...args,
                  expectedRevision: reportRevision,
                  requestId: `demo-trajectory-report-approve`,
                },
                (caller, bound) => ctx.reports.approveVisual(caller, bound),
              );
            case 'report.render':
              return as(
                name,
                { ...subject, final: true, requestId: `demo-trajectory-report-render` },
                (caller, bound) => ctx.reports.render(caller, bound),
              );
            default:
              throw new Error(`The trajectory seed has no handler for ${name}`);
          }
        };
        try {
          const answer: any = await handler();
          if (name === 'artifact.create') lastArtifact = answer.id;
          if (name === 'report.render')
            lastArtifact = answer.final?.sourceArtifactId ?? lastArtifact;
          if (name.startsWith('report.') && typeof answer?.revision === 'number')
            reportRevision = answer.revision;
          const { guide: _guide, images: _images, ...said } = answer ?? {};
          output = JSON.stringify(said).slice(0, 1500);
          args =
            name === 'experiment.get_state'
              ? { experimentId: experiment.id }
              : {
                  ...args,
                  ...(name.startsWith('experiment.') ? { experimentId: experiment.id } : {}),
                };
        } catch (failure) {
          output = (failure as Error).message;
          error = true;
          console.error(`trajectory: ${name} failed: ${output}`);
        }
      }
      events.push({ kind: 'tool_call', id, name: act.name, input: JSON.stringify(args) });
      times.push(clock);
      clock += step.seconds * 1000;
      events.push({ kind: 'tool_result', id, output, ...(error && { error: true }) });
      times.push(clock);
      clock += 1500;
    }
    let bytes = 0;
    for (let at = 0; at < events.length; at += 25) {
      const list = events.slice(at, at + 25);
      await post(url, token, `/sessions/${held.session.id}/stream`, {
        runnerId: held.control.runnerId,
        hostRef: held.control.hostRef,
        from: bytes,
        to: (bytes += 100 * list.length),
        events: list,
      });
    }
    await work.release(held);
    return { sessionId: held.session.id, startAt, endAt: clock + 10_000, times };
  };

  const hour = 3_600_000;
  const day = Date.now() - 36 * hour;
  const visits = [await visit(input.producerCaller, design, day)];
  visits.push(await visit(input.reviewerCaller, designReview, day + 1.4 * hour));
  visits.push(await visit(input.producerCaller, run, day + 2.2 * hour));
  visits.push(await visit(input.reviewerCaller, resultsReview, visits[2]!.endAt + 3 * hour));

  // The clock: each session stands when the script says, each event when its step came.
  const iso = (ms: number) => new Date(ms).toISOString();
  await ctx.state.transaction(async (tx: any) => {
    await tx.run('ALTER TABLE worker_sessions DISABLE TRIGGER USER');
    for (const { sessionId, startAt, endAt, times } of visits) {
      // The time columns are generated from the session's JSON: the JSON is what moves.
      await tx.run(
        "UPDATE worker_sessions SET session_json=(session_json::jsonb || jsonb_build_object('createdAt',CAST(? AS TEXT),'activatedAt',CAST(? AS TEXT),'closedAt',CAST(? AS TEXT)))::text WHERE id=?",
        iso(startAt - 15_000),
        iso(startAt),
        iso(endAt),
        sessionId,
      );
      const rows: { seq: number | string }[] = await tx.all(
        'SELECT seq FROM session_events WHERE session_id=? ORDER BY seq',
        sessionId,
      );
      for (const [index, row] of rows.entries())
        await tx.run(
          'UPDATE session_events SET at=? WHERE session_id=? AND seq=?',
          iso(times[index] ?? endAt),
          sessionId,
          row.seq,
        );
    }
    await tx.run('ALTER TABLE worker_sessions ENABLE TRIGGER USER');
  });
  return experiment;
}
