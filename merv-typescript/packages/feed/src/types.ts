import type { Caller, StoredEvent, Transaction } from '@merv/contracts';
import type {} from 'cordis';
import type { FeedPost } from './models.js';

export type { FeedPost } from './models.js';

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
