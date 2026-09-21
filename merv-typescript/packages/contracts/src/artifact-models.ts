/** The metadata of one immutable file; kept apart so browser-side models can name it. */
export interface Artifact {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
  createdAt: string;
}
