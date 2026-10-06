import type { Verdict } from '@merv/contracts/types';
export type PaperKind = 'problem' | 'literature' | 'methods' | 'results';
export interface PaperPatch {
  kind: PaperKind;
  expectedRevision: number;
  requestId: string;
  changes: {
    id: string;
    title?: string;
    content?: string;
    afterId?: string | null;
    remove?: boolean;
  }[];
}
export type PaperChanges = {
  documents: {
    kind: 'methods' | 'results';
    expectedRevision: number;
    changes: PaperPatch['changes'];
  }[];
};
export interface PaperSection {
  id: string;
  title: string;
  content: string;
}
export interface PaperRevision {
  projectId: string;
  kind: PaperKind;
  revision: number;
  sections: PaperSection[];
  updatedBy: string | null;
  updatedAt: string | null;
  proposalId?: string;
  review?: { id: string; source: PaperSource; verdict: Verdict };
}
/** A retained revision as history lists it: its section bodies are read with its number. */
export type PaperRevisionSummary = Omit<PaperRevision, 'sections'> & {
  sections: Pick<PaperSection, 'id' | 'title'>[];
};
export interface PaperCitation {
  id: string;
  projectId: string;
  revision: number;
  identifier: string;
  title: string;
  authors: string[];
  year: number | null;
  url: string | null;
  notes: string;
  sectionIds: string[];
  refs: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}
export interface PaperSource {
  kind: 'experiment' | 'reflection';
  id: string;
  revision: number;
}
export interface PaperEdit {
  kind: 'methods' | 'results';
  expectedRevision: number;
  changes: PaperPatch['changes'];
}
export interface PaperPublication {
  id: string;
  projectId: string;
  kind: 'methods' | 'results';
  revision: number;
  proposalId?: string;
  sectionIds?: string[];
  verdict?: Verdict;
  source: PaperSource;
  reviewId: string;
  evidence: { id: string; hash: string }[];
  createdBy: string;
  createdAt: string;
}
export interface PaperProposal {
  id: string;
  projectId: string;
  source: PaperSource;
  artifact: { id: string; hash: string };
  documents: { edit: PaperEdit }[];
  evidence: { id: string; hash: string }[];
  createdBy: string;
  createdAt: string;
  acceptance: { reviewId: string; reviewerId: string; publications: PaperPublication[] } | null;
}
export interface PaperDocument {
  current: PaperRevision;
  published: { publication: PaperPublication; document: PaperRevision } | null;
}
export interface PaperWorkspace {
  documents: Record<PaperKind, PaperDocument>;
  citations: PaperCitation[];
  proposals: PaperProposal[];
}
export interface PaperCite {
  id?: string;
  expectedRevision: number;
  requestId: string;
  identifier: string;
  title: string;
  authors?: string[];
  year?: number | null;
  url?: string | null;
  notes?: string;
  sectionIds?: string[];
  /** Project-scoped artifact:<id> evidence references. */
  refs?: string[];
}
/** Trusted owner input: the owner verifies the live, independent review in the same transaction. */
export interface PaperReview extends PaperChanges {
  source: PaperSource;
  reviewId: string;
  verdict: Verdict;
  evidenceIds: string[];
}
