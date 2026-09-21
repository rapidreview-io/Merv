export interface PaperPatch {
  kind: 'problem' | 'literature' | 'methods' | 'results';
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
