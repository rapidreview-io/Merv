import { visible, recorded, createService, plain, receipted } from '@merv/contracts';
import { postgresMigrations } from './index.postgres.js';
import type { Context } from 'cordis';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifacts,
  type Caller,
  type Data,
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
          sql: postgresMigrations[1],
        },
      ]);
    };
  }

  async post(caller: Caller, input: FeedInput, transaction?: Transaction): Promise<FeedPost> {
    caller = structuredClone(caller);
    // The validated attachments, persisted post and retry receipt must describe one input,
    // even when a direct service caller reuses its object while asynchronous checks run.
    input = plain<FeedInput>(input);
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
          visible(input.requestId) &&
          input.requestId.length <= 200,
        'invalid_request',
        'requestId must contain 1–200 characters with visible text',
      );
      // Two descriptions of the same post — artifactIds omitted, or given as the empty default
      // it would take anyway — are one request. Hash the post that gets written, not the words
      // used to ask for it, and still honour a receipt written under the older hash.
      const hash = digest({ ...input, artifactIds: input.artifactIds ?? [] });
      return await receipted(
        tx,
        caller,
        input.requestId,
        hash,
        () => this.write(caller, input, tx),
        {
          table: 'feed_requests',
          actor: 'author_id',
          result: 'response_json',
          legacyHash: digest(input),
        },
      );
    });
  }

  private async write(caller: Caller, input: FeedInput, tx: Transaction): Promise<FeedPost> {
    check(
      typeof input.body === 'string' && visible(input.body) && input.body.length <= 8000,
      'invalid_body',
      'Post body must be nonblank and at most 8000 characters',
    );
    const artifactIds = input.artifactIds === undefined ? [] : input.artifactIds;
    check(
      Array.isArray(artifactIds) &&
        artifactIds.every((id) => typeof id === 'string' && visible(id)),
      'invalid_attachments',
      'Attachments are artifact IDs',
    );
    check(
      artifactIds.length <= 10 && new Set(artifactIds).size === artifactIds.length,
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
    await recorded(this.state, tx, caller, 'feed.posted', id, {
      sequence: post.sequence,
      artifactIds: post.artifactIds,
    });
    return post;
  }

  async get(caller: Caller, postId: string): Promise<FeedPost> {
    caller = structuredClone(caller);
    await this.scope.require(caller, 'read');
    check(typeof postId === 'string' && visible(postId), 'invalid_post', 'A post ID is required');
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
    caller = structuredClone(caller);
    input = structuredClone(input);
    await this.scope.require(caller, 'read');
    check(
      input && typeof input === 'object' && !Array.isArray(input),
      'invalid_input',
      'List input must be an object',
    );
    const { after = 0, limit = 50 } = input;
    check(
      Number.isSafeInteger(after) && after >= 0,
      'invalid_cursor',
      'after must be a nonnegative integer at most 2^53-1',
    );
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'invalid_limit',
      'limit must be an integer from 1 to 100',
    );
    // Without a cursor the newest page answers, oldest first within it; a cursor pages forward.
    return await this.state.read(async (sql) =>
      (input.after === undefined
        ? (
            await sql.all<PostRow>(
              'SELECT * FROM feed_posts WHERE project_id = ? ORDER BY sequence DESC LIMIT ?',
              caller.projectId,
              limit,
            )
          ).reverse()
        : await sql.all<PostRow>(
            'SELECT * FROM feed_posts WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?',
            caller.projectId,
            after,
            limit,
          )
      ).map(hydrate),
    );
  }

  async activity(caller: Caller, after?: number): Promise<StoredEvent[]> {
    caller = structuredClone(caller);
    const actor = await this.scope.require(caller, 'read');
    check(
      after === undefined || (Number.isSafeInteger(after) && after >= 0),
      'invalid_cursor',
      'after must be a nonnegative event ID at most 2^53-1',
    );
    // Without a cursor the newest page answers and older pages follow; a cursor pages forward.
    const forward = after !== undefined;
    const page = async (edge?: number) =>
      forward
        ? await this.state.events(caller.projectId, edge)
        : await this.state.latestEvents(caller.projectId, edge);
    if (actor.role === 'operator') return await page(after);
    let cursor = after;
    while (true) {
      const events = await page(cursor);
      // Credential administration stays with operators: those events are dropped, and an
      // event's source keeps only who acted, not the credential they held.
      const visible = events
        .filter(
          (event) => !event.type.startsWith('actor.') && !event.type.startsWith('membership.'),
        )
        .map((event) => {
          const { source } = event.data as { source?: Data };
          if (!source) return event;
          const { credentialId: _c, keyId: _k, membershipId: _m, expiresAt: _e, ...who } = source;
          return { ...event, data: { ...event.data, source: who as Data } };
        });
      // Pages hold at most 1000 events. Do not signal exhaustion merely because a
      // complete page consists of private actor administration.
      if (visible.length > 0 || events.length < 1000) return visible;
      const next = forward ? events.at(-1)!.id : events[0]!.id;
      check(
        cursor === undefined || (forward ? next > cursor : next < cursor),
        'invalid_event_cursor',
        'Activity event cursor failed to advance',
        500,
      );
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
