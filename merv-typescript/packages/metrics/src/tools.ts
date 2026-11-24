import type { Context } from 'cordis';
import { z } from 'zod';
import { check, type Caller } from '@merv/contracts';
import { pictured } from '@merv/contracts/pictured';
import type { NounAction } from '@merv/api/types';
import type {} from './service.js';
import { MetricsRenderer } from './renderer.js';
import { sheet } from './chart.js';
const name = z.string().min(1).max(256);
/** A running experiment or a task in progress, by its id: exactly one of the two. */
const item = z
  .object({
    experimentId: name.optional(),
    taskId: name.optional(),
    machine: z.string().min(1).max(120).optional(),
  })
  .strict();
function itemOf(input: z.infer<typeof item>) {
  check(
    !!input.experimentId !== !!input.taskId,
    'invalid_input',
    'Name the experimentId or the taskId, one of them',
    400,
  );
  return input.taskId ? { taskId: input.taskId } : { experimentId: input.experimentId! };
}
const run = { run: name, id: name.optional() };
const range = { from: z.number().finite().optional(), to: z.number().finite().optional() };
const chartInput = z.object({
  runs: z.array(name).min(1).max(20).optional(),
  experimentId: name.optional(),
  metrics: z.string().max(500).optional(),
  ...range,
});
function bounded(value: unknown) {
  check(
    Buffer.byteLength(JSON.stringify(value)) <= 512000,
    'metrics_too_large',
    'Narrow the metrics request',
    413,
  );
  return value;
}
export const metricsToolsPlugin = {
  name: 'merv-metrics-tools',
  inject: ['api', 'metrics', 'tools'],
  apply(ctx: Context) {
    const metrics = ctx.metrics;
    const renderer = new MetricsRenderer();
    ctx.effect(() => () => renderer.close());
    ctx.effect(() =>
      ctx.tools.contributeInstructions(
        [
          "Log every training or evaluation run to Trackio, so its curves show live on the item's card and its figure is kept with its results.",
          'How: call metrics.write connect with the experimentId (or taskId) you are producing and, if you know it, machine (e.g. "1x A100, lab-gpu-01"); put the returned env on the job; in Python `import trackio; trackio.init(project=<the returned project>, name="<arm>-seed<k>", config={...}); trackio.log({"val/acc": a, "train/loss": l}, step=s); trackio.finish()`, or report_to="trackio" in Hugging Face Trainer.',
          "Name runs by arm and seed (baseline-seed1, ablation-seed1); log the plan's primary measure under a name that says it (val/acc, eval/loss); log cost_usd (dollars so far) if you know it.",
          'Before you submit, call metrics.write export: it keeps every series and draws the key figure (all runs overlaid). An experiment gets both attached to its results; a task gets their ids to include in its delivery. Embed the figure in the report as ![caption](art_ID).',
          'metrics.read look shows the charts as a picture. Ask anything else about runs as metrics.read query (SQL over Trackio tables) or by composing metrics.read series in script.run.',
        ].join(' '),
      ),
    );
    const actions: Record<string, NounAction> = {
      runs: {
        description: 'List runs, newest first, optionally for an experiment.',
        input: z.object({ experimentId: name.optional() }).strict(),
        handler: (c, i) => metrics.runs(c, i.experimentId),
      },
      run: {
        description:
          "Read a run's config, metric names and each metric's last logged step and value.",
        input: z.object(run).strict(),
        handler: (c, i) => metrics.run(c, i),
      },
      series: {
        description:
          "Many runs' metric series in one read: an experiment's runs or named ones (names or ids, at most 20), metrics by exact name (default every scalar; at most 60, the first by name), from/to a step range applied before thinning; each series [step, value] pairs evenly thinned to points (default 200).",
        input: z
          .object({
            experimentId: name.optional(),
            runs: z.array(name).min(1).max(20).optional(),
            metrics: z.array(name).min(1).max(50).optional(),
            ...range,
            points: z.number().int().min(1).max(1000).optional(),
          })
          .strict(),
        handler: (c, i) => metrics.series(c, i),
      },
      query: {
        description:
          "Read-only SQLite over this project's Trackio data, at most 200 rows. Tables: metrics(run_id, run_name, step, timestamp, metrics: JSON of name to value), configs(run_id, run_name, config: JSON, created_at), system_metrics, alerts. A run's experiment is json_extract(config, '$._Group') (its name) or '$._merv_experiment' (its id), its attempt '$._merv_attempt'; a metric is json_extract(metrics, '$.\"val/loss\"'). Write the question as SQL: best values, first step past a threshold, tail means, joins on config.",
        input: z.object({ sql: z.string().min(1).max(20000) }).strict(),
        handler: (c, i) => metrics.query(c, i.sql),
      },
      look: {
        description:
          "See runs' charts as people's pages draw them: an experiment's runs, named ones (names or ids), or the project's newest 20. metrics names words a metric's name holds, | between alternatives (12 panels a picture), from/to a step range, smoothing 0-99 (exponential, percent). The legend gives each run's experiment, attempt and state; marks along a panel's foot are what Merv recorded while the run logged, listed in marks.",
        input: chartInput
          .extend({ smoothing: z.number().int().min(0).max(99).optional() })
          .strict(),
        present: pictured,
        handler: async (caller, { smoothing = 0, ...input }) => {
          const chart = await metrics.chart(caller, input);
          const { svg, shown, width, height } = sheet(chart, { smoothing: smoothing / 100 });
          check(shown.length, 'metrics_not_drawn', 'No metric matches for these runs', 422);
          const image = await renderer.render(svg, width, height);
          await metrics.read(caller);
          return {
            image,
            width,
            height,
            runs: chart.runs.map(({ metrics: _, muted, color, ...run }) => ({
              ...run,
              color: muted ? 'grey' : color,
            })),
            metrics: shown,
            ...(chart.metrics.length > shown.length && {
              notShown: chart.metrics.slice(shown.length, shown.length + 50),
            }),
            marks: chart.marks,
            ...(chart.omitted && { omitted: chart.omitted }),
          };
        },
      },
    };
    for (const [key, action] of Object.entries(actions)) {
      action.was = [`metrics.${key}`];
      action.openWorld = true;
      const handle = action.handler;
      if (key !== 'look')
        action.handler = async (caller, input) => bounded(await handle(caller, input));
    }
    ctx.effect(() =>
      ctx.tools.noun('metrics.read', {
        tier: 'deferred',
        readOnly: true,
        summary: 'Read training metrics logged to Trackio.',
        description: 'Read runs, metric series, chart pictures or read-only SQL.',
        actions,
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'metrics.items',
        tier: 'ui',
        readOnly: true,
        description:
          "Items' key curves for cards and the board: each task or experiment that logged runs, by id.",
        inputSchema: z
          .object({
            ids: z.array(name).min(1).max(100),
            hints: z.record(name, z.string().max(300)).optional(),
            points: z.number().int().min(2).max(300).optional(),
          })
          .strict(),
        handler: (
          caller: Caller,
          input: { ids: string[]; hints?: Record<string, string>; points?: number },
        ) => metrics.items(caller, input).then(bounded),
      }),
    );
    ctx.effect(() =>
      ctx.tools.register({
        name: 'metrics.chart',
        tier: 'ui',
        readOnly: true,
        description: "What a page's metric charts draw (the page itself reads this).",
        inputSchema: chartInput.strict(),
        handler: (caller: Caller, input: z.infer<typeof chartInput>) =>
          metrics.chart(caller, input),
      }),
    );
    ctx.effect(() =>
      ctx.tools.noun('metrics.write', {
        tier: 'deferred',
        summary: "Connect training code to Trackio or keep an item's metrics and figure.",
        description:
          'Connect the experiment or task you are producing to Trackio, or keep its runs: every series as one JSON artifact and its key figure as a picture.',
        actions: {
          connect: {
            description:
              'Get the Trackio environment for the running experiment or in-progress task you produce; machine, where given, is stamped on each run.',
            input: item,
            was: ['metrics.connect'],
            handler: (c, i) => metrics.connect(c, itemOf(i), i.machine),
          },
          export: {
            description:
              "Keep the item's runs: all metric series as JSON and the key figure (every run overlaid) as a PNG. An experiment's are attached to its current attempt as qualitative results; a task's ids go in its delivery. Embed the figure in the report.",
            input: item,
            was: ['metrics.export'],
            handler: (c, i) =>
              metrics.export(c, itemOf(i), (svg, width, height) =>
                renderer.render(svg, width, height, 'png'),
              ),
          },
        },
      }),
    );
  },
};
export default metricsToolsPlugin;
