import type { Verdict } from '@merv/contracts/types';
export type PaperKind = 'problem' | 'literature' | 'methods' | 'results';
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
export interface PaperPublication {
  id: string;
  projectId: string;
  kind: 'methods' | 'results';
  revision: number;
  sectionIds?: string[];
  verdict?: Verdict;
  source: PaperSource;
  reviewId: string;
  evidence: { id: string; hash: string }[];
  createdBy: string;
  createdAt: string;
}
export interface PaperDocument {
  current: PaperRevision;
  published: { publication: PaperPublication; document: PaperRevision } | null;
}
export interface PaperWorkspace {
  documents: Record<PaperKind, PaperDocument>;
  citations: PaperCitation[];
}
