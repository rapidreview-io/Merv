import type { Context } from 'cordis';
import { z } from 'zod';
import { check, type Caller } from '@merv/contracts';
import { pictured } from '@merv/contracts/pictured';
import type { NounAction } from '@merv/api/types';
import type {} from './service.js';
import { MetricsRenderer } from './renderer.js';
import { sheet } from './chart.js';
const name = z.string().min(1).max(256);
const experiment = z.object({ experimentId: name }).strict();
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
        'Training code logs curves to Trackio after metrics.write connect, with the returned environment on the job. metrics.read look shows the charts as a picture. Ask anything else about runs as metrics.read query (SQL over Trackio tables) or by composing metrics.read series in script.run.',
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
        summary: "Connect training code to Trackio or retain an attempt's metrics.",
        description:
          "Connect a running producer or retain its current attempt's metrics as one JSON artifact; attach that artifact as a qualitative result (small results must be declared JSON).",
        actions: {
          connect: {
            description: 'Get the Trackio environment for a running experiment.',
            input: experiment,
            was: ['metrics.connect'],
            handler: (c, i) => metrics.connect(c, i.experimentId),
          },
          export: {
            description:
              'Retain all current attempt runs and metric series; attach the returned artifact with experiment.write attach.',
            input: experiment,
            was: ['metrics.export'],
            handler: (c, i) => metrics.export(c, i.experimentId),
          },
        },
      }),
    );
  },
};
export default metricsToolsPlugin;
