import type { Context } from 'cordis';
import {
  check,
  createService,
  digest,
  forRead,
  inTransaction,
  MervError,
  newId,
  now,
  recorded,
  replayed,
  sha256Hex,
  type Artifacts,
  type Caller,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { Tokens } from 'marked';
import {
  approveVisualSchema,
  checkSchema,
  clearSchema,
  MAX_FILES,
  MAX_FILES_BYTES,
  MAX_SOURCE_BYTES,
  openSchema,
  parse,
  renderSchema,
  reviewVisualSchema,
  writeSchema,
} from './input.js';
import { joinReport, parseReport, splitReport, type Report } from './format/parse.js';
import { dataKeys, loadRows, type DataFiles, type Issue } from './format/spec.js';
import { ReportRenderer } from './render.js';
import { postgresMigrations } from './storage.postgres.js';
import type {
  FinalReport,
  RenderResult,
  ReportCheck,
  ReportFinal,
  ReportRevision,
  ReportSubject,
  ReportSubjectRef,
  ReportView,
  Reports,
  VisualReview,
} from './types.js';
export type * from './types.js';
export { parseReport } from './format/parse.js';

type SubjectInput = { subjectKind: string; subjectId: string };
const ref = (input: SubjectInput): ReportSubjectRef => ({
  kind: input.subjectKind,
  id: input.subjectId,
});
const errors = (issues: Issue[]) => issues.filter((i) => i.level === 'error');

/** The one-line answer and the optional description under the result chart. */
export function resultAnswer(report: Report): { answer: string; note: string | null } {
  const result = report.sections.find((s) => s.name === 'Result');
  const paras = (result?.tokens ?? []).filter((t) => t.type === 'paragraph') as Tokens.Paragraph[];
  return { answer: paras[0]?.text.trim() ?? '', note: paras[1]?.text.trim() || null };
}

/** Report drafts that persist across submissions, and their final PDF renders. */
/** A section the first draft left for the author: one `[[write: …]]` and nothing else. */
const PLACEHOLDER = /^\[\[write:[^\]]*\]\]$/;

export class ReportService implements Reports {
  private readonly subjects = new Map<string, ReportSubject>();
  private closed = false;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly artifacts: Artifacts,
    private readonly renderer: ReportRenderer,
  ) {}
  async initialize(): Promise<void> {
    await this.state.migrate('reports', postgresMigrations);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.renderer.close();
  }
  private open_(): void {
    if (this.closed) throw new MervError('reports_unavailable', 'Reports is stopping', 503);
  }

  registerSubject(kind: string, subject: ReportSubject): () => void {
    check(
      !this.subjects.has(kind),
      'conflict',
      `Report subject ${kind} is already registered`,
      409,
    );
    this.subjects.set(kind, subject);
    return () => {
      if (this.subjects.get(kind) === subject) this.subjects.delete(kind);
    };
  }
  private subject(kind: string): ReportSubject {
    const subject = this.subjects.get(kind);
    if (!subject)
      throw new MervError('reports_unavailable', `Reports for ${kind} are not available`, 503);
    return subject;
  }

  private async latest(
    caller: Caller,
    subject: ReportSubjectRef,
    tx: Transaction,
  ): Promise<ReportRevision | null> {
    const row = await tx.get<{ record: string }>(
      `SELECT r.record FROM report_drafts d JOIN report_revisions r ON r.report_id=d.id
       WHERE d.project_id=? AND d.subject_kind=? AND d.subject_id=? ORDER BY r.revision DESC LIMIT 1`,
      caller.projectId,
      subject.kind,
      subject.id,
    );
    return row ? (JSON.parse(row.record) as ReportRevision) : null;
  }
  private async required(
    caller: Caller,
    subject: ReportSubjectRef,
    tx: Transaction,
  ): Promise<ReportRevision> {
    const found = await this.latest(caller, subject, tx);
    if (!found)
      throw new MervError(
        'not_found',
        'This report has not been opened yet; call report.open first',
        404,
      );
    return found;
  }
  private async append(
    caller: Caller,
    before: ReportRevision | null,
    after: ReportRevision,
    tx: Transaction,
  ): Promise<void> {
    check(
      !before || (after.revision === before.revision + 1 && Number.isSafeInteger(after.revision)),
      'report_revision_conflict',
      'Report revision is exhausted',
      409,
    );
    await tx.run(
      'INSERT INTO report_revisions(report_id,revision,project_id,record) VALUES(?,?,?,?)',
      after.reportId,
      after.revision,
      caller.projectId,
      JSON.stringify(after),
    );
    await recorded(this.state, tx, caller, 'report.revised', after.reportId, {
      subjectKind: after.subject.kind,
      subjectId: after.subject.id,
      revision: after.revision,
      final: after.final ? after.final.sourceArtifactId : null,
    });
  }
  private expect(before: ReportRevision, expected: number): void {
    check(
      before.revision === expected,
      'report_revision_conflict',
      `Expected revision ${expected}, found ${before.revision}; read the report and work against the current one`,
      409,
    );
  }
  private view(rev: ReportRevision): ReportView {
    const report = parseReport(rev.source, { locked: rev.locked });
    return {
      reportId: rev.reportId,
      subject: rev.subject,
      revision: rev.revision,
      source: rev.source,
      files: Object.entries(rev.files).map(([name, text]) => ({
        name,
        bytes: Buffer.byteLength(text),
      })),
      locked: rev.locked,
      charts: report.charts
        .filter((c) => typeof c.spec?.id === 'string')
        .map((c) => ({
          id: c.spec.id,
          section: c.section,
          approved: rev.approvals[c.spec.id] !== undefined,
        })),
      final: rev.final,
      finalCurrent: rev.final?.revision === rev.revision,
    };
  }

  async open(caller: Caller, value: unknown): Promise<ReportView> {
    this.open_();
    caller = structuredClone(caller);
    const input = parse(openSchema, value);
    const subject = ref(input);
    return await inTransaction(this.state, undefined, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const provider = this.subject(subject.kind);
      await provider.authorize(caller, subject.id, 'write', tx);
      const found = await this.latest(caller, subject, tx);
      if (found) return this.view(found);
      const prefill = await provider.prefill(caller, subject.id, tx);
      check(
        Buffer.byteLength(prefill.source) <= MAX_SOURCE_BYTES,
        'report_too_large',
        'The prefilled report is too large',
        422,
      );
      const reportId = newId('rep');
      const inserted = await tx.run(
        'INSERT INTO report_drafts(id,project_id,subject_kind,subject_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
        reportId,
        caller.projectId,
        subject.kind,
        subject.id,
        now(),
      );
      if (!inserted.changes) return this.view(await this.required(caller, subject, tx));
      const first: ReportRevision = {
        reportId,
        subject,
        revision: 1,
        source: prefill.source,
        files: {},
        approvals: {},
        locked: prefill.locked,
        base: prefill.source,
        final: null,
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      await this.append(caller, null, first, tx);
      return this.view(first);
    });
  }

  private async command<T>(
    caller: Caller,
    operation: string,
    input: SubjectInput & { requestId: string },
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    this.open_();
    return await inTransaction(
      this.state,
      undefined,
      async (tx) =>
        await replayed(tx, 'report_commands', caller, operation, input, () => run(tx), {
          result: 'result_json',
          after: async () => {
            await this.scope.require(caller, 'write', tx);
            await this.subject(input.subjectKind).authorize(caller, input.subjectId, 'write', tx);
          },
        }),
    );
  }

  async write(caller: Caller, value: unknown): Promise<ReportView> {
    caller = structuredClone(caller);
    const input = parse(writeSchema, value);
    return await this.command(caller, 'write', input, async (tx) => {
      const before = await this.required(caller, ref(input), tx);
      this.expect(before, input.expectedRevision);
      let source = before.source;
      if (input.source !== undefined) source = input.source;
      if (input.sections || input.frontMatter !== undefined) {
        const parts = splitReport(source);
        if (input.frontMatter !== undefined) parts.frontMatter = input.frontMatter;
        for (const s of input.sections ?? []) {
          if (s.name === 'title' || s.name === '#') {
            parts.title = s.content.trim().replace(/^#\s+/, '');
            continue;
          }
          const found = parts.sections.find((x) => x.name === s.name);
          if (found) found.body = s.content;
          else parts.sections.push({ name: s.name, body: s.content });
        }
        source = joinReport(parts);
      }
      this.keepLocked(before, source);
      check(
        Buffer.byteLength(source) <= MAX_SOURCE_BYTES,
        'report_too_large',
        `The report source is over ${MAX_SOURCE_BYTES} bytes`,
        422,
      );
      const files = { ...before.files };
      for (const f of input.files ?? []) {
        if (f.content === null) delete files[f.name];
        else files[f.name] = f.content;
      }
      check(
        Object.keys(files).length <= MAX_FILES,
        'report_too_large',
        `At most ${MAX_FILES} data files`,
        422,
      );
      check(
        Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0) <= MAX_FILES_BYTES,
        'report_too_large',
        `Data files total over ${MAX_FILES_BYTES} bytes`,
        422,
      );
      const after: ReportRevision = {
        ...before,
        revision: before.revision + 1,
        source,
        files,
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      await this.append(caller, before, after, tx);
      return this.view(after);
    });
  }

  /** The plan's sections may not change: they are what the researcher or customer approved. */
  private keepLocked(rev: ReportRevision, source: string): void {
    if (!rev.locked.length) return;
    const base = splitReport(rev.base);
    const next = splitReport(source);
    for (const name of rev.locked) {
      const was =
        name === 'title'
          ? (base.title ?? '').trim()
          : (base.sections.find((s) => s.name === name)?.body.trim() ?? '');
      // A plan that left a section empty approved nothing there: its placeholder is written
      // like any other, or the report could never be finished.
      if (PLACEHOLDER.test(was)) continue;
      const same =
        was ===
        (name === 'title'
          ? (next.title ?? '').trim()
          : next.sections.find((s) => s.name === name)?.body.trim());
      check(
        same,
        'report_locked_section',
        `${name === 'title' ? 'The title' : `The ${name} section`} comes from the approved plan and cannot be edited`,
        422,
      );
    }
  }

  async clear(caller: Caller, value: unknown): Promise<ReportView> {
    caller = structuredClone(caller);
    const input = parse(clearSchema, value);
    return await this.command(caller, 'clear', input, async (tx) => {
      const before = await this.required(caller, ref(input), tx);
      this.expect(before, input.expectedRevision);
      const after: ReportRevision = {
        ...before,
        revision: before.revision + 1,
        source: before.base,
        files: {},
        approvals: {},
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      await this.append(caller, before, after, tx);
      return this.view(after);
    });
  }

  /** Data for rendering: the draft's files and any artifacts the charts name. */
  private async files(
    caller: Caller,
    rev: ReportRevision,
    report: Report,
    tx?: Transaction,
  ): Promise<Map<string, string>> {
    const files = new Map(Object.entries(rev.files));
    const wanted = new Set(
      report.charts
        .flatMap((c) => (c.spec && typeof c.spec === 'object' ? dataKeys(c.spec) : []))
        .filter((k) => k.startsWith('artifact:')),
    );
    for (const key of wanted) {
      try {
        const { artifact, bytes } = await this.artifacts.bytes(
          caller,
          key.slice('artifact:'.length),
          tx,
        );
        if (
          !/^(text\/|application\/(json|x-ndjson)$)/.test(artifact.mediaType) &&
          bytes.includes(0)
        )
          continue;
        files.set(key, bytes.toString('utf8'));
      } catch {
        // Reported by check as missing data.
      }
    }
    return files;
  }

  private approvalHash(spec: Record<string, any>, files: DataFiles): string {
    return digest({
      spec,
      data: dataKeys(spec).map((k) => [k, files.has(k) ? sha256Hex(files.get(k)!) : null]),
    });
  }

  private analyse(
    rev: ReportRevision,
    files: Map<string, string>,
  ): { report: Report; issues: Issue[]; charts: ReportCheck['charts'] } {
    const report = parseReport(rev.source, { locked: rev.locked, files: new Set(files.keys()) });
    const issues = [...report.issues];
    for (const chart of report.charts) {
      if (
        !chart.spec ||
        typeof chart.spec !== 'object' ||
        issues.some(
          (i) => i.level === 'error' && i.where === `${chart.section} chart ${chart.spec.id}`,
        )
      )
        continue;
      try {
        const rows = loadRows(chart.spec.data, files, report.criteria);
        for (const l of chart.spec.layer ?? [])
          if (l?.data) loadRows(l.data, files, report.criteria);
        if (chart.section === 'Result' && report.criteria.length) {
          const metrics = new Set(report.criteria.map((c) => c.metric));
          for (const row of rows)
            if (
              typeof row.delta === 'number' &&
              typeof row.metric === 'string' &&
              !metrics.has(row.metric)
            )
              issues.push({
                level: 'error',
                where: `Result chart ${chart.spec.id}`,
                message: `row metric "${row.metric}" matches no criterion in the front matter`,
              });
          for (const m of metrics)
            if (!rows.some((r) => r.metric === m))
              issues.push({
                level: 'error',
                where: `Result chart ${chart.spec.id}`,
                message: `criterion "${m}" has no row in the result chart`,
              });
        }
      } catch (error) {
        issues.push({
          level: 'error',
          where: `${chart.section} chart ${chart.spec.id}`,
          message: (error as Error).message,
        });
      }
    }
    // A plan may pre-register no numeric bar (an exploratory question): its result chart shows
    // the measured results. Requiring criteria made agents invent bars after seeing results.
    if (report.charts.some((c) => c.section === 'Result') && !report.criteria.length)
      issues.push({
        level: 'warning',
        where: 'front matter',
        message:
          'no criteria, so the result chart shows measured results with no bar or status; that is right only when the approved plan set no numeric bar. Otherwise list each {metric, bar} or {metric, floor} it pre-registered, never one chosen after seeing results',
      });
    const charts = report.charts
      .filter((c) => typeof c.spec?.id === 'string')
      .map((c) => ({
        id: c.spec.id,
        section: c.section,
        approved: rev.approvals[c.spec.id] === this.approvalHash(c.spec, files),
      }));
    return { report, issues, charts };
  }

  async check(caller: Caller, value: unknown): Promise<ReportCheck> {
    caller = structuredClone(caller);
    const input = parse(checkSchema, value);
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      await this.subject(input.subjectKind).authorize(caller, input.subjectId, 'read', tx);
      const rev = await this.required(caller, ref(input), tx);
      const { issues, charts } = this.analyse(
        rev,
        await this.files(caller, rev, parseReport(rev.source), tx),
      );
      const pending = charts.filter((c) => !c.approved).map((c) => c.id);
      if (!errors(issues).length && pending.length)
        issues.push({
          level: 'warning',
          where: 'charts',
          message: `not yet approved: ${pending.join(', ')}; review each with report.review_visual`,
        });
      return { revision: rev.revision, issues, charts };
    });
  }

  private async readable(caller: Caller, input: SubjectInput, mode: 'read' | 'write') {
    return await forRead(this.state, async (tx) => {
      await this.scope.require(caller, mode, tx);
      await this.subject(input.subjectKind).authorize(caller, input.subjectId, mode, tx);
      const rev = await this.required(caller, ref(input), tx);
      const files = await this.files(caller, rev, parseReport(rev.source), tx);
      return { rev, files, ...this.analyse(rev, files) };
    });
  }

  private drawable(issues: Issue[]): void {
    const blocking = errors(issues).filter(
      (i) =>
        i.where?.includes(' chart ') ||
        i.where === 'front matter' ||
        i.where === 'title' ||
        i.where === 'top',
    );
    if (blocking.length)
      throw new MervError(
        'report_invalid',
        `Fix these before rendering: ${blocking.map((i) => `${i.where}: ${i.message}`).join('; ')}`,
        422,
        { issues: blocking.map((i) => ({ ...i })) },
      );
  }

  async reviewVisual(caller: Caller, value: unknown): Promise<VisualReview> {
    caller = structuredClone(caller);
    const input = parse(reviewVisualSchema, value);
    this.open_();
    const { rev, files, report, issues, charts } = await this.readable(caller, input, 'read');
    check(charts.length, 'not_found', 'The report has no charts yet', 404);
    const target = input.chartId ?? charts.find((c) => !c.approved)?.id;
    check(target, 'not_found', 'Every chart is approved; render the report', 404);
    check(
      charts.some((c) => c.id === target),
      'not_found',
      `No chart with id "${target}"`,
      404,
    );
    this.drawable(issues);
    const out = await this.renderer.render(report, files, { visual: target });
    const shot = out.visual!;
    return {
      revision: rev.revision,
      chart: shot.id,
      section: shot.section,
      message: shot.message,
      width: shot.width,
      height: shot.height,
      approved: charts.find((c) => c.id === target)!.approved,
      issues: shot.issues,
      remaining: charts.filter((c) => !c.approved && c.id !== target).map((c) => c.id),
      image: shot.image.toString('base64'),
      context: shot.context.toString('base64'),
    };
  }

  async approveVisual(caller: Caller, value: unknown): Promise<ReportView> {
    caller = structuredClone(caller);
    const input = parse(approveVisualSchema, value);
    this.open_();
    const { rev, files, report, issues, charts } = await this.readable(caller, input, 'write');
    this.expect(rev, input.expectedRevision);
    check(
      charts.some((c) => c.id === input.chartId),
      'not_found',
      `No chart with id "${input.chartId}"`,
      404,
    );
    this.drawable(issues);
    const shot = (await this.renderer.render(report, files, { visual: input.chartId })).visual!;
    const blocking = errors(shot.issues);
    if (blocking.length)
      throw new MervError(
        'report_visual_rejected',
        `Cannot approve ${input.chartId}: ${blocking.map((i) => i.message).join('; ')}`,
        422,
        {
          issues: blocking.map((i) => ({ ...i })),
        },
      );
    const spec = report.charts.find((c) => c.spec.id === input.chartId)!.spec;
    const hash = this.approvalHash(spec, files);
    return await this.command(caller, 'approve_visual', input, async (tx) => {
      const before = await this.required(caller, ref(input), tx);
      this.expect(before, input.expectedRevision);
      const after: ReportRevision = {
        ...before,
        revision: before.revision + 1,
        approvals: { ...before.approvals, [input.chartId]: hash },
        updatedBy: caller.actorId,
        updatedAt: now(),
      };
      await this.append(caller, before, after, tx);
      return this.view(after);
    });
  }

  async render(caller: Caller, value: unknown): Promise<RenderResult> {
    caller = structuredClone(caller);
    const input = parse(renderSchema, value);
    this.open_();
    const { rev, files, report, issues, charts } = await this.readable(
      caller,
      input,
      input.final ? 'write' : 'read',
    );
    this.drawable(issues);
    if (input.final) {
      const blocking = errors(issues);
      check(
        !blocking.length,
        'report_invalid',
        `Fix these first: ${blocking.map((i) => `${i.where}: ${i.message}`).join('; ')}`,
        422,
      );
      const pending = charts.filter((c) => !c.approved).map((c) => c.id);
      check(
        !pending.length,
        'report_visuals_unapproved',
        `Review and approve these charts first: ${pending.join(', ')}`,
        422,
      );
    }
    const out = await this.renderer.render(report, files, { pages: true, pdf: input.final });
    const drawn = [...issues.filter((i) => !input.final || i.level === 'warning'), ...out.issues];
    const summary = { pages: out.pages.length, unfilled: out.layout.pages.map((p) => p.unfilled) };
    if (!input.final)
      return {
        revision: rev.revision,
        ...summary,
        issues: drawn,
        final: null,
        images: out.pages.map((b) => b.toString('base64')),
      };
    check(
      !errors(out.issues).length,
      'report_invalid',
      errors(out.issues)
        .map((i) => `${i.where}: ${i.message}`)
        .join('; '),
      422,
    );
    const final = await this.command(
      caller,
      'render_final',
      { ...input, requestId: input.requestId! },
      async (tx) => {
        const before = await this.required(caller, ref(input), tx);
        check(
          before.revision === rev.revision,
          'report_revision_conflict',
          'The report changed while it rendered; render again',
          409,
        );
        const name = String(report.meta.id ?? input.subjectId);
        const source = await this.artifacts.create(
          caller,
          { title: `Report ${name} (Markdown)`, content: rev.source, mediaType: 'text/markdown' },
          tx,
        );
        const pdf = await this.artifacts.create(
          caller,
          {
            title: `Report ${name} (PDF)`,
            content: out.pdf!.toString('base64'),
            encoding: 'base64',
            mediaType: 'application/pdf',
          },
          tx,
        );
        const pageIds: string[] = [];
        for (const [i, png] of out.pages.entries())
          pageIds.push(
            (
              await this.artifacts.create(
                caller,
                {
                  title: `Report ${name}, page ${i + 1}`,
                  content: png.toString('base64'),
                  encoding: 'base64',
                  mediaType: 'image/png',
                },
                tx,
              )
            ).id,
          );
        const record: ReportFinal = {
          revision: rev.revision + 1,
          sourceArtifactId: source.id,
          pdfArtifactId: pdf.id,
          pageArtifactIds: pageIds,
          createdAt: now(),
        };
        await tx.run(
          'INSERT INTO report_finals(source_artifact_id,project_id,report_id,revision,record) VALUES(?,?,?,?,?)',
          source.id,
          caller.projectId,
          rev.reportId,
          record.revision,
          JSON.stringify({ ...record, subject: rev.subject, source: rev.source }),
        );
        const after: ReportRevision = {
          ...before,
          revision: before.revision + 1,
          final: record,
          updatedBy: caller.actorId,
          updatedAt: now(),
        };
        await this.append(caller, before, after, tx);
        return record;
      },
    );
    return { revision: final.revision, ...summary, issues: drawn, final, images: [] };
  }

  async finalFor(
    caller: Caller,
    sourceArtifactId: string,
    tx?: Transaction,
  ): Promise<FinalReport | null> {
    return await forRead(
      this.state,
      async (t) => {
        await this.scope.require(caller, 'read', t);
        const row = await t.get<{ report_id: string; record: string }>(
          'SELECT report_id,record FROM report_finals WHERE source_artifact_id=? AND project_id=?',
          sourceArtifactId,
          caller.projectId,
        );
        if (!row) return null;
        const record = JSON.parse(row.record) as ReportFinal & {
          subject: ReportSubjectRef;
          source: string;
        };
        const { answer, note } = resultAnswer(parseReport(record.source));
        return { ...record, reportId: row.report_id, answer, note };
      },
      tx,
    );
  }
}

/** Reads the Chromium binary from config or MERV_REPORTS_CHROMIUM; the image installs it. */
export interface ReportsConfig {
  chromium?: string;
}
export const reportsPlugin = {
  name: 'merv-reports',
  inject: ['state', 'scope', 'artifacts'],
  async apply(ctx: Context, config: ReportsConfig = {}) {
    await ctx.effect(async function* () {
      const executable = config.chromium ?? process.env.MERV_REPORTS_CHROMIUM ?? undefined;
      const service = await createService(
        new ReportService(ctx.state, ctx.scope, ctx.artifacts, new ReportRenderer(executable)),
      );
      yield async () => await service.close();
      yield ctx.provide('reports', service);
    });
  },
};
export default reportsPlugin;
