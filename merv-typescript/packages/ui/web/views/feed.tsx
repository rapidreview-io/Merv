import { Link } from 'react-router-dom';
import { useTool } from '../api';
import { Ago, KindLabel, words } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import type { Row } from '../shell';
import type { ViewProps } from './index';
import { useActorNames } from './people';

interface Post {
  id: string;
  authorId: string;
  body: string;
  artifactIds: string[];
  createdAt: string;
}
interface Event {
  id: number;
  type: string;
  subjectId: string;
  data: Record<string, unknown>;
  createdAt: string;
}
/** A record the column can name, and where reading it continues. */
interface Named {
  name: string;
  to?: string;
}

const POSTS = 30;
const LINES = 50;
/** Ids a post body may mention. A claim id is left alone: on a review it is a lease, not a claim. */
const MENTION = /((?:wf|review|art|claim)_[0-9a-f]{6,})/;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * Names for the ids posts and lines mention. One list per registered row,
 * best effort: an id no list names stays an id. A review is named by what it
 * judges, so reviews are read after the records they point at.
 */
function useRecordNames(rows: Row[]): Map<string, Named> {
  const rowOf = (kind: string) => rows.find((row) => row.view.kind === kind);
  const tasks = rowOf('tasks');
  const experiments = rowOf('experiments');
  const cycles = rowOf('research');
  const reviews = rowOf('reviews');
  const artifacts = rowOf('artifacts');
  const taskList = useTool<{ id: string; title: string }[]>(tasks ? 'task.list' : null);
  const experimentList = useTool<{ id: string; name: string }[]>(
    experiments ? 'experiment.list' : null,
  );
  const cycleList = useTool<{ id: string; name: string }[]>(cycles ? 'research.list' : null);
  const reviewList = useTool<{ id: string; subjectId: string }[]>(reviews ? 'review.list' : null);
  const artifactList = useTool<{ id: string; title: string }[]>(artifacts ? 'artifact.list' : null);
  const names = new Map<string, Named>();
  // A cycle has no page of its own; its name leads back to the cycle list.
  const add = (row: Row | undefined, id: string, name: string, detail = true) =>
    names.set(id, { name, to: row && (detail ? `${row.path}/${id}` : row.path) });
  for (const task of taskList.data ?? []) add(tasks, task.id, task.title);
  for (const experiment of experimentList.data ?? [])
    add(experiments, experiment.id, experiment.name);
  for (const cycle of cycleList.data ?? []) add(cycles, cycle.id, cycle.name, false);
  for (const artifact of artifactList.data ?? []) add(artifacts, artifact.id, artifact.title);
  for (const review of reviewList.data ?? []) {
    const subject = names.get(review.subjectId);
    if (subject) add(reviews, review.id, `Review of ${subject.name}`);
  }
  return names;
}

/** A name you can click where the id resolved, and nothing at all where it did not. */
/** An id no list names stays the author's text: a post reads as it was written. */
function Name({ id, names }: { id: string; names: Map<string, Named> }) {
  const found = names.get(id);
  if (!found) return <span className="mono">{id}</span>;
  return found.to ? <Link to={found.to}>{found.name}</Link> : <span>{found.name}</span>;
}

const VERDICTS: Record<string, string> = {
  pass: 'passed',
  needs_changes: 'came back for changes',
  fail: 'did not pass',
};
/**
 * The only state changes that earn a line, and the words each one reads in.
 * A verdict, a workflow state change (a task, an experiment or a research
 * cycle) and an agent joining or being handed work are what a reader would
 * otherwise have to go looking for. `artifact.created` and `feed.posted`
 * never appear: an artifact arrives named under the post that attaches it,
 * and the post is its own entry. `research.advanced`, `task.review_applied`
 * and `experiment.review_applied` restate a transition that already has its
 * line, and everything else stays in the event log where agents read it.
 */
const SAID: Record<string, (event: Event, agent?: string) => { subject?: string; said: string }> = {
  'review.submitted': (event) => ({
    subject: event.subjectId,
    said: VERDICTS[text(event.data.verdict) ?? ''] ?? 'was decided',
  }),
  'workflow.transition': (event) => ({
    subject: event.subjectId,
    said: `is now ${words(text(event.data.to) ?? 'changed')}`,
  }),
  'session.offered': (event, agent) => ({
    subject: text(event.data.instanceId),
    said: `went to ${agent ?? 'an agent'}`,
  }),
};

function Line({
  event,
  names,
  agent,
}: {
  event: Event;
  names: Map<string, Named>;
  agent?: string;
}) {
  const { subject, said } = SAID[event.type](event, agent);
  return (
    <p className="feed-line">
      <span>
        {subject && names.has(subject) && (
          <>
            <Name id={subject} names={names} />{' '}
          </>
        )}
        {said}
      </span>
      <Ago at={event.createdAt} className="feed-when" />
    </p>
  );
}

function Entry({
  post,
  names,
  author,
}: {
  post: Post;
  names: Map<string, Named>;
  author?: string;
}) {
  return (
    <article className="record feed-post">
      <p className="feed-by">
        <span className="feed-who">
          <KindLabel kind="feed" />
          <span className="feed-author">{author}</span>
        </span>
        <Ago at={post.createdAt} className="feed-when" />
      </p>
      {post.body.split(/\n{2,}/).map((paragraph, index) => (
        <p className="feed-body" key={index}>
          {paragraph
            .split(MENTION)
            .map((piece, at) => (at % 2 ? <Name key={at} id={piece} names={names} /> : piece))}
        </p>
      ))}
      {post.artifactIds
        .filter((id) => names.has(id))
        .map((id) => (
          <p className="feed-file" key={id}>
            <Name id={id} names={names} />
          </p>
        ))}
    </article>
  );
}

/**
 * One reverse-chronological column: posts in their author's voice, state
 * changes as quiet lines between them. Both tools page forward from the
 * oldest record, so there is no way to ask for anything earlier than the
 * head of the log and the column offers no control that pretends otherwise.
 */
export function FeedView({ shell }: ViewProps) {
  const names = useRecordNames(shell.rows);
  const nameOf = useActorNames();
  const events = useTool<Event[]>('feed.activity', {}, { every: 6000 });
  // Both tools answer their newest page without a cursor, which is this column.
  const posts = useTool<Post[]>('feed.list', { limit: POSTS }, { every: 6000 });
  const named = (event: Event) => {
    const { subject } = SAID[event.type]!(event);
    return subject === undefined || names.has(subject);
  };
  const entries = [
    ...(posts.data ?? []).map((post) => ({
      id: post.id,
      at: post.createdAt,
      said: `${nameOf(post.authorId) ?? ''} ${post.body}`,
      node: <Entry key={post.id} post={post} names={names} author={nameOf(post.authorId)} />,
    })),
    ...(events.data ?? [])
      // A line names its subject; an event whose subject this page cannot name is not a line.
      .filter((event) => SAID[event.type] && named(event))
      .slice(-LINES)
      .map((event) => {
        const agent = nameOf(text(event.data.workerActorId));
        const { subject, said } = SAID[event.type](event, agent);
        return {
          id: `event-${event.id}`,
          at: event.createdAt,
          said: `${names.get(subject ?? '')?.name ?? ''} ${said}`,
          node: <Line key={`event-${event.id}`} event={event} names={names} agent={agent} />,
        };
      }),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const filter = useListFilter(entries, { labels: (entry) => [entry.said] });
  return (
    <ListPage
      load={{
        loading: posts.loading || events.loading,
        error: posts.error ?? events.error,
        data: posts.data,
      }}
      noun="the feed"
      placeholder="Anything said here"
      filter={filter}
      emptyTitle="Nothing has been posted yet"
      // The column is a designed surface: an entry is a paragraph, not a row.
      cards={{ className: 'feed', render: (entry) => entry.node }}
    />
  );
}
