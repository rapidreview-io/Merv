/** The metadata of one immutable file; kept apart so browser-side models can name it. */
export interface ArtifactFile {
  name: string;
  size: number;
  hash: string;
  provider: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
  createdAt: string;
  /** Collection members; provider references remain server-side. */
  files?: ArtifactFile[];
  metadata?: Record<string, unknown>;
}
/** artifact.get and artifact.list: the record, and whether this deployment can prepare a
 * download of it. */
export interface ArtifactListing extends Artifact {
  downloadAvailable?: boolean;
}
/** Artifact bytes as tool text; `offset` and `total` are set for a range. */
export interface ArtifactContent {
  artifact: Artifact;
  content: string;
  encoding: 'utf8' | 'base64';
  offset?: number;
  total?: number;
}
