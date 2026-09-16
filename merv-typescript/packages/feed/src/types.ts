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
  post(caller: Caller, input: FeedInput, tx?: Transaction): Promise<FeedPost>;
  get(caller: Caller, postId: string): Promise<FeedPost>;
  list(caller: Caller, input?: FeedListInput): Promise<FeedPost[]>;
  activity(caller: Caller, after?: number): Promise<StoredEvent[]>;
}
declare module 'cordis' {
  interface Context {
    feed: Feed;
  }
}
