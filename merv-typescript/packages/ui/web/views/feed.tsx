import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTool } from '../api';
import { Ago, cx, words } from '../components';
import { Icon, type IconName } from '../icons';
import { ListPage, useListFilter } from '../list-filters';
import { Markdown, RecordLink, recordNames, type RecordNames } from '../markdown';
import type { ViewProps } from './index';
import { fileType, type Artifact } from './artifacts';
import { useHome } from './map-data';
import { initials, namesOf } from './people';

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

const POSTS = 30;
const LINES = 50;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
/** What a line says, the glyph that says what kind of line it is, and the tone a verdict carries. */
interface Said {
  subject?: string;
  said: string;
  icon: IconName;
  tone?: 'ok' | 'warn' | 'bad';
}
const VERDICTS: Record<string, Omit<Said, 'subject'>> = {
  pass: { said: 'passed', icon: 'check', tone: 'ok' },
  needs_changes: { said: 'came back for changes', icon: 'edit', tone: 'warn' },
  fail: { said: 'did not pass', icon: 'close', tone: 'bad' },
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
const SAID: Record<string, (event: Event, agent?: string) => Said> = {
  'review.submitted': (event) => ({
    subject: event.subjectId,
    ...(VERDICTS[text(event.data.verdict) ?? ''] ?? { said: 'was decided', icon: 'check' }),
  }),
  'workflow.transition': (event) => ({
    subject: event.subjectId,
    said: `is now ${words(text(event.data.to) ?? 'changed')}`,
    icon: 'arrow-right',
  }),
  'session.offered': (event, agent) => ({
    subject: text(event.data.instanceId),
    said: `went to ${agent ?? 'an agent'}`,
    icon: 'sessions',
  }),
};

/**
 * Every entry is the same two columns: a gutter that says whose entry it is — an
 * author's initials, or the glyph of a state change — and the words, with the
 * time at the one right edge the whole column shares.
 */
function Line({ event, names, agent }: { event: Event; names: RecordNames; agent?: string }) {
  const { subject, said, icon, tone } = SAID[event.type]!(event, agent);
  return (
    <div className="feed-entry feed-line">
      <span className={cx('feed-mark', tone && `status--${tone}`)}>
        <Icon name={icon} size={14} />
      </span>
      <p className="feed-said">
        {subject && names.has(subject) && (
          <>
            <RecordLink id={subject} names={names} />{' '}
          </>
        )}
        {said}
      </p>
      <Ago at={event.createdAt} className="feed-when" />
    </div>
  );
}

/** A file a post attaches: its type's glyph and its name, which is the way to it. */
function Attached({ file }: { file: Artifact }) {
  const type = fileType(file);
  return (
    <Link className="feed-file" to={`/artifacts/${file.id}`} title={type.label}>
      <Icon name={type.icon} size={14} />
      <span>{file.title}</span>
    </Link>
  );
}

function Entry({
  post,
  names,
  files,
  author,
}: {
  post: Post;
  names: RecordNames;
  files: Map<string, Artifact>;
  author?: string;
}) {
  const attached = post.artifactIds.flatMap((id) => files.get(id) ?? []);
  return (
    <article className="feed-entry feed-post">
      <span className="feed-avatar" aria-hidden="true">
        {initials(author)}
      </span>
      <div className="feed-text">
        <p className="feed-by">
          <span className="feed-author">{author}</span>
          <Ago at={post.createdAt} className="feed-when" />
        </p>
        <div className="feed-body">
          <Markdown source={post.body} names={names} />
        </div>
        {attached.length > 0 && (
          <div className="feed-files">
            {attached.map((file) => (
              <Attached key={file.id} file={file} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * One reverse-chronological column: posts in their author's voice, state
 * changes as quiet lines between them. Both tools page forward from the
 * oldest record, so there is no way to ask for anything earlier than the
 * head of the log and the column offers no control that pretends otherwise.
 * Names come from the two reads the app already makes — the home read the rail
 * shares and the file list — so naming what the column mentions costs no list
 * of its own.
 */
export function FeedView({ shell }: ViewProps) {
  const home = useHome();
  const listed = useTool<Artifact[]>(
    shell.rows.some((row) => row.view.kind === 'artifacts') ? 'artifact.list' : null,
  );
  const names = useMemo(() => recordNames(listed.data, home.data), [listed.data, home.data]);
  const files = useMemo(
    () => new Map((listed.data ?? []).map((file) => [file.id, file])),
    [listed.data],
  );
  const nameOf = namesOf(home.data?.actors);
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
      node: (
        <Entry
          key={post.id}
          post={post}
          names={names}
          files={files}
          author={nameOf(post.authorId)}
        />
      ),
    })),
    ...(events.data ?? [])
      // A line names its subject; an event whose subject this page cannot name is not a line.
      .filter((event) => SAID[event.type] && named(event))
      .slice(-LINES)
      .map((event) => {
        const agent = nameOf(text(event.data.workerActorId));
        const { subject, said } = SAID[event.type]!(event, agent);
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
      kind="feed"
      filter={filter}
      emptyTitle="No posts yet"
      // The column is a designed surface: an entry is a paragraph, not a row.
      cards={{ className: 'feed', render: (entry) => entry.node }}
    />
  );
}
