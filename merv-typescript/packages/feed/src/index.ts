import { createService } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  eventSource,
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifacts,
  type Caller,
  type Scope,
  type State,
  type StoredEvent,
  type Transaction,
} from '@merv/contracts';

import type { Feed, FeedInput, FeedListInput, FeedPost } from './types.js';

export type { Feed, FeedInput, FeedListInput, FeedPost } from './types.js';

interface PostRow {
  id: string;
  sequence: number;
  project_id: string;
  author_id: string;
  body: string;
  artifact_ids: string;
  created_at: string;
}
const hydrate = (row: PostRow): FeedPost => ({
  id: row.id,
  sequence: row.sequence,
  projectId: row.project_id,
  authorId: row.author_id,
  body: row.body,
  artifactIds: JSON.parse(row.artifact_ids),
  createdAt: row.created_at,
});

/** Project-scoped communication and activity. No knowledge of tasks, reviews, or workflows. */
export class FeedService implements Feed {
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly artifacts: Artifacts,
  ) {
    this.initialize = async () => {
      await state.migrate('feed', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE feed_posts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, author_id TEXT NOT NULL,
        body TEXT NOT NULL, artifact_ids TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX feed_posts_project_sequence ON feed_posts(project_id, sequence);
      CREATE TABLE feed_requests (
        project_id TEXT NOT NULL, author_id TEXT NOT NULL, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, response_json TEXT NOT NULL,
        PRIMARY KEY(project_id, author_id, request_id)
      );
      CREATE TRIGGER feed_posts_no_update BEFORE UPDATE ON feed_posts
        BEGIN SELECT RAISE(ABORT, 'Feed posts are immutable'); END;
      CREATE TRIGGER feed_posts_no_delete BEFORE DELETE ON feed_posts
        BEGIN SELECT RAISE(ABORT, 'Feed posts are immutable'); END;
      CREATE TRIGGER feed_requests_no_update BEFORE UPDATE ON feed_requests
        BEGIN SELECT RAISE(ABORT, 'Feed request records are immutable'); END;
      CREATE TRIGGER feed_requests_no_delete BEFORE DELETE ON feed_requests
        BEGIN SELECT RAISE(ABORT, 'Feed request records are immutable'); END;
    `,
        },
      ]);
    };
  }

  async post(caller: Caller, input: FeedInput, transaction?: Transaction): Promise<FeedPost> {
    return await inTransaction(this.state, transaction, async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      check(
        ['operator', 'producer', 'reviewer'].includes(actor.role),
        'forbidden',
        'Readers cannot post to the feed',
        403,
      );
      check(
        input && typeof input === 'object' && !Array.isArray(input),
        'invalid_input',
        'Feed input must be an object',
      );
      check(
        typeof input.requestId === 'string' &&
          input.requestId.trim().length > 0 &&
          input.requestId.length <= 200,
        'invalid_request',
        'requestId must contain 1–200 characters',
      );
      const hash = digest(input);
      const old = await tx.get<{ input_hash: string; response_json: string }>(
        'SELECT input_hash, response_json FROM feed_requests WHERE project_id = ? AND author_id = ? AND request_id = ?',
        caller.projectId,
        caller.actorId,
        input.requestId,
      );
      if (old) {
        check(
          old.input_hash === hash,
          'request_conflict',
          'requestId was already used with different input',
          409,
        );
        return JSON.parse(old.response_json) as FeedPost;
      }
      check(
        typeof input.body === 'string' && input.body.trim().length > 0 && input.body.length <= 8000,
        'invalid_body',
        'Post body must be nonblank and at most 8000 characters',
      );
      const artifactIds = input.artifactIds === undefined ? [] : input.artifactIds;
      check(
        Array.isArray(artifactIds) &&
          artifactIds.length <= 10 &&
          artifactIds.every((id) => typeof id === 'string' && id.trim().length > 0) &&
          new Set(artifactIds).size === artifactIds.length,
        'invalid_attachments',
        'Attach at most 10 distinct artifact IDs',
      );
      // Attachments may be authored by anyone in this project; access comes from Artifacts.
      for (const id of artifactIds) await this.artifacts.get(caller, id, tx);
      const id = newId('post'),
        createdAt = now();
      const inserted = await tx.get<{ sequence: number }>(
        'INSERT INTO feed_posts (id, project_id, author_id, body, artifact_ids, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING sequence',
        id,
        caller.projectId,
        caller.actorId,
        input.body,
        JSON.stringify(artifactIds),
        createdAt,
      );
      const post: FeedPost = {
        id,
        sequence: Number(inserted!.sequence),
        projectId: caller.projectId,
        authorId: caller.actorId,
        body: input.body,
        artifactIds: [...artifactIds],
        createdAt,
      };
      await this.state.appendEvent(tx, {
        projectId: caller.projectId,
        actorId: caller.actorId,
        type: 'feed.posted',
        subjectId: id,
        data: { sequence: post.sequence, artifactIds: post.artifactIds, ...eventSource(caller) },
      });
      await tx.run(
        'INSERT INTO feed_requests (project_id, author_id, request_id, input_hash, response_json) VALUES (?, ?, ?, ?, ?)',
        caller.projectId,
        caller.actorId,
        input.requestId,
        hash,
        JSON.stringify(post),
      );
      return post;
    });
  }

  async get(caller: Caller, postId: string): Promise<FeedPost> {
    await this.scope.require(caller, 'read');
    check(
      typeof postId === 'string' && postId.trim().length > 0,
      'invalid_post',
      'A post ID is required',
    );
    const row = await this.state.read(
      async (sql) =>
        await sql.get<PostRow>(
          'SELECT * FROM feed_posts WHERE id = ? AND project_id = ?',
          postId,
          caller.projectId,
        ),
    );
    check(row, 'not_found', 'Feed post not found in this project', 404);
    return hydrate(row);
  }

  async list(caller: Caller, input: FeedListInput = {}): Promise<FeedPost[]> {
    await this.scope.require(caller, 'read');
    check(
      input && typeof input === 'object' && !Array.isArray(input),
      'invalid_input',
      'List input must be an object',
    );
    const after = input.after === undefined ? 0 : input.after,
      limit = input.limit === undefined ? 50 : input.limit;
    check(
      Number.isSafeInteger(after) && after >= 0,
      'invalid_cursor',
      'after must be a nonnegative integer',
    );
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'invalid_limit',
      'limit must be an integer from 1 to 100',
    );
    return await this.state.read(async (sql) =>
      (
        await sql.all<PostRow>(
          'SELECT * FROM feed_posts WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
          caller.projectId,
          after,
          limit,
        )
      ).map(hydrate),
    );
  }

  async activity(caller: Caller, after = 0): Promise<StoredEvent[]> {
    const actor = await this.scope.require(caller, 'read');
    check(
      Number.isSafeInteger(after) && after >= 0,
      'invalid_cursor',
      'after must be a nonnegative event ID',
    );
    if (actor.role === 'operator') return await this.state.events(caller.projectId, after);
    let cursor = after;
    while (true) {
      const events = await this.state.events(caller.projectId, cursor);
      const visible = events.filter(
        (event) => !event.type.startsWith('actor.') && !event.type.startsWith('membership.'),
      );
      // State.events pages contain at most 1000 events. Do not signal exhaustion
      // merely because a complete page consists of private actor administration.
      if (visible.length > 0 || events.length < 1000) return visible;
      const next = events.at(-1)!.id;
      check(next > cursor, 'invalid_event_cursor', 'Activity event cursor failed to advance', 500);
      cursor = next;
    }
  }
}

export const feedPlugin = {
  name: 'merv-feed',
  inject: ['state', 'scope', 'artifacts'],
  async apply(ctx: Context) {
    ctx.provide('feed', await createService(new FeedService(ctx.state, ctx.scope, ctx.artifacts)));
  },
};
export default feedPlugin;
