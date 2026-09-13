import type { Caller, StoredEvent, Transaction } from '@merv/contracts';
import type {} from 'cordis';

export interface FeedPost {
  id: string;
  sequence: number;
  projectId: string;
  authorId: string;
  body: string;
  artifactIds: string[];
  createdAt: string;
}
export interface FeedInput {
  body: string;
  artifactIds?: string[];
  requestId: string;
}
export interface FeedListInput {
  after?: number;
  limit?: number;
}
export interface Feed {
  post(caller: Caller, input: FeedInput, tx?: Transaction): FeedPost;
  get(caller: Caller, postId: string): FeedPost;
  list(caller: Caller, input?: FeedListInput): FeedPost[];
  activity(caller: Caller, after?: number): StoredEvent[];
}
declare module 'cordis' {
  interface Context {
    feed: Feed;
  }
}
