import { Link } from 'react-router-dom';
import { useTool } from '../api';
import { LoadState, ObjId, PageHeader, StatusPill, Table, relativeTime } from '../components';
import { useActorNames } from './people';
import type { ViewProps } from './index';

interface Post {
  id: string;
  sequence: number;
  authorId: string;
  body: string;
  artifactIds: string[];
  createdAt: string;
}
interface Event {
  id: number;
  actorId: string;
  type: string;
  subjectId: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export function FeedView({ row }: ViewProps) {
  const posts = useTool<Post[]>('feed.list', { limit: 100 }, { every: 6000 });
  const nameOf = useActorNames();
  return (
    <div className="page-stage">
      <PageHeader
        title={row.label}
        summary="Immutable project messages from producers, reviewers, and operators."
      />
      <LoadState
        loading={posts.loading}
        error={posts.error}
        empty={posts.data?.length === 0}
        emptyTitle="Nothing posted yet"
        emptyHint="Posts arrive through feed.post."
      />
      <div className="stack">
        {[...(posts.data ?? [])].reverse().map((post) => (
          <article key={post.id} className="card post">
            <div className="post-head">
              <span className="post-author">
                {nameOf(post.authorId) ?? <ObjId id={post.authorId} />}
              </span>
              <span className="faint" title={post.createdAt}>
                {relativeTime(post.createdAt)}
              </span>
            </div>
            <p className="post-body">{post.body}</p>
            {post.artifactIds.length > 0 && (
              <div className="cluster">
                {post.artifactIds.map((id) => (
                  <Link key={id} to={`/artifacts/${id}`} className="btn btn--sm">
                    <ObjId id={id} />
                  </Link>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

export function ActivityView({ row }: ViewProps) {
  const events = useTool<Event[]>('feed.activity', {}, { every: 6000 });
  const nameOf = useActorNames();
  return (
    <div className="page-stage">
      <PageHeader
        title={row.label}
        summary="Durable events the domain plugins recorded, newest first."
      />
      <LoadState
        loading={events.loading}
        error={events.error}
        empty={events.data?.length === 0}
        emptyTitle="No activity yet"
      />
      {events.data && events.data.length > 0 && (
        <Table
          rows={[...events.data].reverse()}
          keyOf={(e) => String(e.id)}
          columns={[
            { key: 'type', label: 'Event', render: (e) => <StatusPill value={e.type} /> },
            { key: 'subject', label: 'Subject', render: (e) => <ObjId id={e.subjectId} /> },
            {
              key: 'actor',
              label: 'Actor',
              render: (e) => nameOf(e.actorId) ?? <ObjId id={e.actorId} />,
            },
            {
              key: 'data',
              label: 'Data',
              render: (e) => <span className="mono faint data-cell">{JSON.stringify(e.data)}</span>,
            },
            {
              key: 'when',
              label: 'When',
              render: (e) => <span title={e.createdAt}>{relativeTime(e.createdAt)}</span>,
              width: '90px',
            },
          ]}
        />
      )}
    </div>
  );
}
