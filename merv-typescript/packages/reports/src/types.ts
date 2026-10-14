import type { Caller, Transaction } from '@merv/contracts';
export interface Issue {
  level: 'error' | 'warning';
  where?: string;
  message: string;
}
/** What a report is about: one experiment, or one customer experiment request. */
export interface ReportSubjectRef {
  kind: string;
  id: string;
}
/** A kind of subject, registered by the package that owns it. */
export interface ReportSubject {
  /** Throws unless the caller may read or edit this subject's report now. */
  authorize(caller: Caller, id: string, mode: 'read' | 'write', tx: Transaction): Promise<void>;
  /** The approved plan as a first draft: the sections it fixes and placeholders for the rest. */
  prefill(caller: Caller, id: string, tx: Transaction): Promise<ReportPrefill>;
}
export interface ReportPrefill {
  source: string;
  /** Section names (and 'title') the agent may not change. */
  locked: string[];
}
export interface ReportFinal {
  revision: number;
  sourceArtifactId: string;
  pdfArtifactId: string;
  pageArtifactIds: string[];
  createdAt: string;
}
/** One retained revision of a report draft. */
export interface ReportRevision {
  reportId: string;
  subject: ReportSubjectRef;
  revision: number;
  source: string;
  files: Record<string, string>;
  /** Chart id → hash of the spec and its data when it was approved. */
  approvals: Record<string, string>;
  locked: string[];
  /** The prefilled draft `clear` returns to. */
  base: string;
  final: ReportFinal | null;
  updatedBy: string;
  updatedAt: string;
}
export interface ReportView {
  reportId: string;
  subject: ReportSubjectRef;
  revision: number;
  source: string;
  files: { name: string; bytes: number }[];
  locked: string[];
  charts: { id: string; section: string; approved: boolean }[];
  final: ReportFinal | null;
  /** Whether the latest final render matches the current revision. */
  finalCurrent: boolean;
}
export interface ReportCheck {
  revision: number;
  issues: Issue[];
  charts: { id: string; section: string; approved: boolean }[];
}
/** The final report a submission names by its source artifact. */
export interface FinalReport extends ReportFinal {
  reportId: string;
  subject: ReportSubjectRef;
  source: string;
  /** The one-line answer and optional description under the result chart. */
  answer: string;
  note: string | null;
}
export interface Reports {
  registerSubject(kind: string, subject: ReportSubject): () => void;
  open(caller: Caller, input: unknown): Promise<ReportView>;
  write(caller: Caller, input: unknown): Promise<ReportView>;
  clear(caller: Caller, input: unknown): Promise<ReportView>;
  check(caller: Caller, input: unknown): Promise<ReportCheck>;
  reviewVisual(caller: Caller, input: unknown): Promise<VisualReview>;
  approveVisual(caller: Caller, input: unknown): Promise<ReportView>;
  render(caller: Caller, input: unknown): Promise<RenderResult>;
  /** The final report whose Markdown source is this artifact, if it is one. */
  finalFor(caller: Caller, sourceArtifactId: string, tx?: Transaction): Promise<FinalReport | null>;
}
export interface VisualReview {
  revision: number;
  chart: string;
  section: string;
  message: string;
  width: number;
  height: number;
  approved: boolean;
  issues: Issue[];
  remaining: string[];
  /** PNG, base64: the chart alone at twice its page size, and its section on the page. */
  image: string;
  context: string;
}
export interface RenderResult {
  revision: number;
  pages: number;
  unfilled: number[][];
  issues: Issue[];
  final: ReportFinal | null;
  /** PNG, base64, one per page; omitted from a final render, whose pages are artifacts. */
  images: string[];
}
declare module 'cordis' {
  interface Context {
    reports: Reports;
  }
}
