import {
  check,
  MAX_ARTIFACT_BYTES,
  sha256Hex,
  type Caller,
  type Scope,
  type Artifacts,
} from '@merv/contracts';
import type { Experiment, Experiments } from '@merv/experiments/types';
import type { Sessions } from '@merv/sessions/types';
import { Tokens } from './tokens.js';
import { PALETTE, type Chart, type ChartMark } from './chart.js';

export interface Run {
  run: string;
  id: string;
  experimentId?: string;
  /** The experiment's name, as the proxy grouped the run. */
  experiment?: string;
  attempt?: number;
  createdAt: string;
}
export interface Point {
  step: number;
  value: unknown;
}
export interface Summary {
  config: unknown;
  metrics: string[];
  last_step: number | null;
}
export interface MetricsConfig {
  upstream: string;
  writeToken: string;
  secret: string;
  publicOrigin?: string;
  mediaDir: string;
}
/** Rows one read may return: Trackio refuses a query of more than 10,000. */
const BUDGET = 9000;
/** Metrics one read draws or returns, the first by name. */
const MAX_METRICS = 60;
/** A SQLite string literal. Trackio's query endpoint takes SQL text, read-only and per project. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
/**
 * The runs these names select: a run's id selects that run alone, so duplicate names stay
 * selectable; any other name selects every run of that name.
 */
function named(runs: Run[], names?: string[]) {
  if (!names) return runs;
  const ids = new Set(runs.map((run) => run.id));
  return runs.filter(
    (run) => names.includes(run.id) || names.some((name) => name === run.run && !ids.has(name)),
  );
}
export class MetricsService {
  readonly tokens: Tokens;
  constructor(
    readonly config: MetricsConfig,
    private scope: Scope,
    private experiments: Experiments,
    private sessions: Sessions,
    private artifacts: Artifacts,
    private origin: () => string | undefined,
  ) {
    this.tokens = new Tokens(config.secret);
  }
  private async request<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.config.upstream}/trackio/api/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kwargs: args }),
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      // Trackio explains a refused query ("no such column …"); an agent fixes its SQL from that.
      const error = await response
        .json()
        .then((body: { error?: unknown }) => body.error)
        .catch(() => undefined);
      check(
        typeof error !== 'string',
        'metrics_rejected',
        `Trackio: ${String(error).slice(0, 300)}`,
        422,
      );
      check(false, 'metrics_unavailable', 'Trackio did not answer', 502);
    }
    // A remote server cannot make a tool retain an unbounded response in memory.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      check(size <= 64 * 1024 * 1024, 'metrics_too_large', 'Metrics response is too large', 413);
      chunks.push(chunk);
    }
    return (JSON.parse(Buffer.concat(chunks).toString()) as { data: T }).data;
  }
  async read(caller: Caller) {
    await this.scope.require(caller, 'read');
  }
  async allRuns(caller: Caller, experimentId?: string): Promise<Run[]> {
    await this.read(caller);
    if (experimentId) await this.experiments.get(caller, experimentId);
    const args = { project: caller.projectId };
    const [records, configs] = await Promise.all([
      this.request<{ id: string; name: string; created_at: string }[]>(
        'get_runs_for_project',
        args,
      ),
      this.request<Record<string, Record<string, unknown>>>('get_run_configs', args),
    ]);
    await this.read(caller);
    return records
      .map((record) => {
        const config = configs[record.id] ?? {};
        return {
          run: record.name,
          id: record.id,
          createdAt: record.created_at,
          ...(typeof config._merv_experiment === 'string'
            ? {
                experimentId: config._merv_experiment,
                ...(typeof config._Group === 'string' && { experiment: config._Group }),
              }
            : {}),
          ...(Number.isInteger(config._merv_attempt)
            ? { attempt: config._merv_attempt as number }
            : {}),
        };
      })
      .filter((run) => !experimentId || run.experimentId === experimentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async runs(caller: Caller, experimentId?: string) {
    return (await this.allRuns(caller, experimentId)).slice(0, 200);
  }
  async run(caller: Caller, input: { run: string; id?: string }) {
    await this.read(caller);
    const args = { project: caller.projectId, run: input.run, run_id: input.id };
    const summary = await this.request<Summary>('get_run_summary', args);
    // Each metric's last logged point: metrics logged every n steps have none at the last step.
    const rows = await this.rows(
      caller,
      `SELECT j.key AS metric, MAX(m.step) AS step, j.value AS value FROM metrics m, json_each(m.metrics) j
       WHERE ${input.id ? `m.run_id = ${literal(input.id)}` : `m.run_name = ${literal(input.run)}`}
       AND j.type IN ('integer', 'real') GROUP BY j.key`,
    );
    const last: Record<string, [number, unknown] | null> = Object.create(null);
    for (const metric of summary.metrics) last[metric] = null;
    for (const row of rows)
      if (Object.hasOwn(last, row.metric as string))
        last[row.metric as string] = [row.step as number, row.value];
    await this.read(caller);
    return { config: summary.config, metrics: summary.metrics, lastStep: summary.last_step, last };
  }
  private async rows(caller: Caller, query: string) {
    return (
      await this.request<{ rows: Record<string, unknown>[] }>('query_project', {
        project: caller.projectId,
        query,
      })
    ).rows;
  }
  /** Every value one metric logged, for retention. */
  private async metricValues(caller: Caller, run: string, metric: string, id?: string) {
    return await this.request<Point[]>('get_metric_values', {
      project: caller.projectId,
      run,
      run_id: id,
      metric_name: metric,
    });
  }
  /**
   * Many runs' metric series in one read. Trackio filters, projects and thins inside SQLite: the
   * step range applies before thinning, and only the named metrics leave Trackio.
   */
  async series(
    caller: Caller,
    input: {
      experimentId?: string;
      runs?: string[];
      metrics?: string[];
      from?: number;
      to?: number;
      points?: number;
    },
  ) {
    const runs = named(await this.allRuns(caller, input.experimentId), input.runs);
    check(runs.length, 'not_found', 'No matching runs', 404);
    check(
      runs.length <= 20,
      'metrics_too_large',
      'Name at most 20 runs, by id if names repeat',
      413,
    );
    return (await this.seriesOf(caller, runs, input)).runs;
  }
  private async seriesOf(
    caller: Caller,
    runs: Run[],
    input: {
      metrics?: string[];
      /** Words a metric's name holds, any of them, in any case. */
      matching?: string[];
      from?: number;
      to?: number;
      points?: number;
    },
  ) {
    const points = input.points ?? 200;
    const like = (word: string) => literal(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
    const where = [
      `m.run_id IN (${runs.map((run) => literal(run.id)).join(', ')})`,
      "j.type IN ('integer', 'real')",
      ...(input.metrics ? [`j.key IN (${input.metrics.map(literal).join(', ')})`] : []),
      ...(input.matching?.length
        ? [`(${input.matching.map((w) => `j.key LIKE ${like(w)} ESCAPE '\\'`).join(' OR ')})`]
        : []),
      ...(input.from !== undefined ? [`m.step >= ${input.from}`] : []),
      ...(input.to !== undefined ? [`m.step <= ${input.to}`] : []),
    ];
    // Evenly spaced rows of each run's metric: the first, the last, and one per (n - 1) / (q - 1),
    // where q is what is asked or what the budget leaves each line, whichever is less.
    const kept =
      points === 1
        ? 'i = n - 1'
        : 'n <= q OR i = 0 OR i = n - 1 OR (i * (q - 1)) / (n - 1) <> ((i - 1) * (q - 1)) / (n - 1)';
    const rows = await this.rows(
      caller,
      `WITH p AS (SELECT m.run_id, m.step, j.key AS metric, j.value AS value FROM metrics m, json_each(m.metrics) j
       WHERE ${where.join(' AND ')}),
       r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id, metric ORDER BY step) - 1 AS i,
       COUNT(*) OVER (PARTITION BY run_id, metric) AS n, DENSE_RANK() OVER (ORDER BY metric) AS k FROM p),
       s AS (SELECT *, MAX(k) OVER () AS kinds, SUM(i = 0 AND k <= ${MAX_METRICS}) OVER () AS lines FROM r),
       t AS (SELECT *, MIN(${points}, MAX(2, ${BUDGET} / lines)) AS q FROM s WHERE k <= ${MAX_METRICS})
       SELECT run_id, metric, step, value, kinds FROM t WHERE ${kept} ORDER BY run_id, metric, step`,
    );
    await this.read(caller);
    const series = new Map(
      runs.map((run) => [run.id, Object.create(null) as Record<string, [number, number][]>]),
    );
    for (const row of rows)
      (series.get(row.run_id as string)![row.metric as string] ??= []).push([
        row.step as number,
        row.value as number,
      ]);
    return {
      runs: runs.map((run) => ({ ...run, metrics: series.get(run.id)! })),
      /** Metrics matched, of which the first MAX_METRICS by name were read. */
      kinds: (rows[0]?.kinds as number | undefined) ?? 0,
    };
  }
  /**
   * What Merv's charts draw, for the page and an agent's picture alike: at most 20 runs (an
   * experiment's, named ones, or the project's newest) with their experiments' names and states,
   * and, for one experiment, what its record holds that happened while they logged.
   */
  async chart(
    caller: Caller,
    input: { experimentId?: string; runs?: string[]; metrics?: string; from?: number; to?: number },
  ): Promise<Chart> {
    const pool = await this.allRuns(caller, input.experimentId);
    const runs = named(pool, input.runs).slice(0, 20);
    check(runs.length, 'not_found', 'No matching runs', 404);
    const ids = [...new Set(runs.flatMap((run) => (run.experimentId ? [run.experimentId] : [])))];
    // A run may outlive its experiment's record: it is drawn without one.
    const records = new Map(
      await Promise.all(
        ids.map(
          async (id) =>
            [id, await this.experiments.get(caller, id).catch(() => undefined)] as const,
        ),
      ),
    );
    const { runs: series, kinds } = await this.seriesOf(caller, runs, {
      ...input,
      metrics: undefined,
      // Words, never a pattern: a person's pattern must not hold the server up.
      matching: input.metrics
        ?.split('|')
        .map((word) => word.trim())
        .filter(Boolean),
      points: 300,
    });
    const metrics = [...new Set(series.flatMap((run) => Object.keys(run.metrics)))].sort();
    // Colours go oldest first over every run of the experiment or project, so a run that starts
    // later, or a choice of fewer runs, leaves the others' as they were.
    const oldest = pool.map((run) => run.id).reverse();
    const chart: Chart = {
      metrics,
      runs: series.map((run) => {
        const record = run.experimentId ? records.get(run.experimentId) : undefined;
        return {
          id: run.id,
          run: run.run,
          ...(run.experimentId && { experimentId: run.experimentId }),
          ...(run.experiment && { experiment: run.experiment }),
          ...(run.attempt !== undefined && { attempt: run.attempt }),
          ...(record && { state: record.workflow.state }),
          ...(record &&
            (record.failed || (run.attempt ?? Infinity) < record.attempt.index) && {
              muted: true as const,
            }),
          color: PALETTE[oldest.indexOf(run.id) % PALETTE.length],
          metrics: Object.fromEntries(
            metrics.flatMap((m) => (run.metrics[m] ? [[m, run.metrics[m]]] : [])),
          ),
        };
      }),
      marks: [],
      ...(kinds > MAX_METRICS && { omitted: kinds - MAX_METRICS }),
      live: [...records.values()].some((record) => record?.workflow.state === 'running'),
    };
    const only = ids.length === 1 ? records.get(ids[0]) : undefined;
    if (only)
      chart.marks = await this.marks(
        caller,
        only,
        runs.filter((run) => run.experimentId === only.id),
      );
    return chart;
  }
  /**
   * The record's submissions and the messages people sent its producers, each placed at the last
   * step every run logging at that moment had logged. What happened before or after a run is its
   * record's, not its chart's.
   */
  private async marks(caller: Caller, experiment: Experiment, runs: Run[]): Promise<ChartMark[]> {
    // A leased worker may not read threads: its own chart goes without their messages.
    const threads = await this.sessions.threads.list(caller, experiment.id).catch(() => []);
    const messages = await Promise.all(
      threads
        .filter((thread) => thread.role === 'producer')
        .map((thread) =>
          this.sessions.messaging.thread(caller, thread.id).then(
            (read) => read.messages,
            () => [],
          ),
        ),
    );
    const events = [
      ...experiment.submissions.map((s) => ({
        at: s.createdAt,
        label: `${s.stage === 'results' ? 'Results' : 'Design'} submitted for review`,
      })),
      ...messages
        .flat()
        .map((m) => ({ at: m.createdAt, label: `Message: ${m.body.slice(0, 200)}` })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-50);
    if (!events.length) return [];
    const rows = await this.rows(
      caller,
      `WITH k(i, t) AS (VALUES ${events.map((e, i) => `(${i}, julianday(${literal(e.at)}))`).join(', ')}),
       w AS (SELECT run_id, MIN(julianday(timestamp)) AS a, MAX(julianday(timestamp)) AS b FROM metrics
       WHERE run_id IN (${runs.map((run) => literal(run.id)).join(', ')}) GROUP BY run_id)
       SELECT k.i AS i, w.run_id AS run_id, (SELECT m.step FROM metrics m
       WHERE m.run_id = w.run_id AND julianday(m.timestamp) <= k.t
       ORDER BY julianday(m.timestamp) DESC, m.step DESC LIMIT 1) AS step FROM k JOIN w ON k.t BETWEEN w.a AND w.b`,
    );
    await this.read(caller);
    return rows.map((row) => ({
      run: row.run_id as string,
      step: row.step as number,
      ...events[row.i as number],
    }));
  }
  async query(caller: Caller, sql: string) {
    await this.read(caller);
    const result = await this.request<{ columns: string[]; rows: Record<string, unknown>[] }>(
      'query_project',
      { project: caller.projectId, query: sql },
    );
    await this.read(caller);
    // Only the answer: echoing the agent's own SQL back costs its context.
    return {
      columns: result.columns,
      rows: result.rows.slice(0, 200),
      ...(result.rows.length > 200 && { truncated: true }),
    };
  }
  private async producer(caller: Caller, experimentId: string) {
    await this.scope.require(caller, 'write');
    const experiment = await this.experiments.get(caller, experimentId);
    check(experiment.workflow.state === 'running', 'forbidden', 'Experiment must be running', 403);
    if (caller.session) {
      const session = await this.sessions.session(caller);
      check(
        session.kind === 'work' &&
          session.role === 'producer' &&
          session.instanceId === experimentId &&
          session.actorId === caller.actorId &&
          session.projectId === caller.projectId &&
          session.status === 'active' &&
          session.execution.state === 'running' &&
          session.execution.workflow === 'experiment' &&
          session.execution.revision === experiment.workflow.revision &&
          Date.parse(session.expiresAt) > Date.now(),
        'forbidden',
        'Current producing session required',
        403,
      );
    }
    return experiment;
  }
  async connect(caller: Caller, experimentId: string) {
    const experiment = await this.producer(caller, experimentId);
    const origin = this.config.publicOrigin ?? this.origin();
    check(origin, 'metrics_unavailable', 'Public API origin unavailable', 503);
    const expires = Math.floor(Date.now() / 1000) + 12 * 3600;
    return {
      env: {
        TRACKIO_SERVER_URL: `${origin}/trackio`,
        TRACKIO_WRITE_TOKEN: this.tokens.sign({
          k: 'w',
          p: caller.projectId,
          e: experiment.id,
          g: experiment.name,
          a: experiment.attempt.index,
          x: expires,
        }),
      },
      project: caller.projectId,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }
  async export(caller: Caller, experimentId: string) {
    const experiment = await this.producer(caller, experimentId);
    const records = (await this.allRuns(caller, experimentId)).filter(
      (r) => r.attempt === experiment.attempt.index,
    );
    const runs = [];
    for (const record of records) {
      const summary = await this.request<Summary>('get_run_summary', {
        project: caller.projectId,
        run: record.run,
        run_id: record.id,
      });
      const metrics: Record<string, Point[]> = Object.create(null);
      for (const metric of summary.metrics)
        metrics[metric] = await this.metricValues(caller, record.run, metric, record.id);
      runs.push({ ...record, config: summary.config, metrics });
    }
    const current = await this.producer(caller, experimentId);
    check(
      current.attempt.index === experiment.attempt.index,
      'conflict',
      'Attempt changed during export',
      409,
    );
    const path = `metrics/trackio-attempt-${experiment.attempt.index}.json`;
    const content = JSON.stringify({
      project: caller.projectId,
      experimentId,
      attempt: experiment.attempt.index,
      runs,
    });
    const bytes = Buffer.from(content);
    if (bytes.length <= MAX_ARTIFACT_BYTES) {
      const artifact = await this.artifacts.create(caller, {
        title: path,
        mediaType: 'application/json',
        content,
      });
      return { artifactId: artifact.id, path };
    }
    const upload = await this.artifacts.uploadBegin(caller, {
      title: path,
      mediaType: 'application/json',
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    for (const part of upload.parts) {
      const start = (part.partNumber - 1) * upload.partSize;
      const response = await fetch(part.url, {
        method: 'PUT',
        headers: part.headers,
        body: bytes.subarray(start, start + part.size),
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      check(response.ok, 'metrics_export_failed', 'Metrics upload failed', 502);
      await response.body?.cancel();
    }
    const latest = await this.producer(caller, experimentId);
    check(
      latest.attempt.index === experiment.attempt.index,
      'conflict',
      'Attempt changed during export',
      409,
    );
    const artifact = await this.artifacts.uploadComplete(caller, upload.uploadId);
    return { artifactId: artifact.id, path };
  }
  /** The 30-minute view cookie the proxy reads: a member's browser, or Merv drawing for one. */
  view(caller: Caller) {
    return {
      name: `merv_trackio_${caller.projectId}`,
      value: this.tokens.sign({
        k: 'v',
        p: caller.projectId,
        u: caller.actorId,
        x: Math.floor(Date.now() / 1000) + 1800,
      }),
    };
  }
  /** Trackio's own dashboard, for what Merv's charts do not draw: media, histograms, traces. */
  async panel(caller: Caller, experimentId?: string) {
    const runs = await this.allRuns(caller, experimentId);
    const params = new URLSearchParams({ project: caller.projectId, hide_empty_tabs: 'true' });
    if (experimentId) params.set('run_ids', runs.map((r) => r.id).join(','));
    return { url: `/trackio/?${params}`, runs: runs.length };
  }
}
declare module 'cordis' {
  interface Context {
    metrics: MetricsService;
  }
}
