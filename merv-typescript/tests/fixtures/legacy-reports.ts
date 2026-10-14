/**
 * Reports for tests about something other than reports: it treats a test's own report artifact as
 * already rendered final, so a submission's other checks run without a browser. An experiment's
 * report is whatever artifact it holds in the report role; anything else is claimed explicitly.
 * tests/reports.test.ts and tests/reports-experiments.test.ts exercise the real service.
 */
import type { Context } from 'cordis';
import type { Caller, State, Transaction } from '@merv/contracts';
import type { FinalReport, ReportSubjectRef, Reports } from '@merv/reports/types';
import { postgresMigrations } from '../../packages/reports/src/storage.postgres.js';

export interface LegacyReports extends Pick<Reports, 'finalFor' | 'registerSubject'> {
  /** Treat this artifact as the final report of a subject. */
  claim(artifactId: string, subject: ReportSubjectRef): void;
}

export function legacyReports(state: State): LegacyReports {
  const claimed = new Map<string, ReportSubjectRef>();
  const final = (id: string, subject: ReportSubjectRef, pages: string[] = []): FinalReport => ({
    reportId: `rep_${id}`,
    subject,
    revision: 1,
    sourceArtifactId: id,
    // An experiment's test report has no separate PDF: its Markdown stays the reviewed text.
    pdfArtifactId: subject.kind === 'experiment' ? '' : id,
    pageArtifactIds: pages,
    createdAt: new Date(0).toISOString(),
    source: '',
    answer: '',
    note: null,
  });
  return {
    registerSubject: () => () => {},
    claim: (id, subject) => void claimed.set(id, subject),
    async finalFor(_caller: Caller, id: string, tx?: Transaction) {
      const subject = claimed.get(id);
      if (subject) return final(id, subject);
      // A test report's images stand for its rendered pages, as a report's figures.
      const query = async (sql: Pick<Transaction, 'get'>) =>
        await sql.get<{ experiment_id: string; content: Uint8Array | null }>(
          `SELECT e.experiment_id, a.content FROM experiment_evidence e JOIN artifacts a ON a.id=e.record::jsonb->>'artifactId'
           WHERE e.role='report' AND e.record::jsonb->>'artifactId'=? LIMIT 1`,
          id,
        );
      const row = await (tx ? query(tx) : state.read(query)).catch(() => undefined);
      if (!row) return null;
      const text = row.content ? Buffer.from(row.content).toString('utf8') : '';
      const pages = [...text.matchAll(/!\[[^\]]*\]\((art_[^)\s]+)\)/g)].map((m) => m[1]);
      return final(id, { kind: 'experiment', id: row.experiment_id }, pages);
    },
  };
}

/** Stands in for @merv/reports in an app a test composes. */
export const legacyReportsPlugin = {
  name: 'merv-test-legacy-reports',
  inject: ['state'],
  async apply(ctx: Context) {
    // The same tables as production, so a test database migrates as a real one does.
    await ctx.state.migrate('reports', postgresMigrations);
    await ctx.effect(async function* () {
      yield ctx.provide('reports', legacyReports(ctx.state) as unknown as Reports);
    });
  },
};
export default legacyReportsPlugin;
