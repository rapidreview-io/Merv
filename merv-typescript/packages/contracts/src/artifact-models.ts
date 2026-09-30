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
