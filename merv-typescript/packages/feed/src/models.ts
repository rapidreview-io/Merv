/** Portable feed read models, shared by the server and the browser. */
export interface FeedPost {
  id: string;
  sequence: number;
  projectId: string;
  authorId: string;
  body: string;
  artifactIds: string[];
  createdAt: string;
}
