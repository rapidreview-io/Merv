import { useMemo, useState } from 'react';
import { useProjectStore } from '../store/useProjectStore';
import ContextHeader from './ContextHeader';
import PostCard from './PostCard';
import {
  useNow, dayLabel, withDayDividers, buildCards, cardMatches, isOpenQuestion, FILTERS,
} from './feedModel';
import { useFeedStream } from './useFeedStream';
import './feed.css';

function nudgeLabel(nudge) {
  const hours = Number(nudge?.hours_since_last_post);
  if (Number.isFinite(hours) && hours >= 1) {
    return `Agents haven't posted in ~${Math.round(hours)}h`;
  }
  return 'The feed has been quiet for a while';
}

function LoadingFeed() {
  return (
    <>
      <div className="feed-sr" role="status">Loading feed…</div>
      <div className="feed-list" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div key={index} className="postcard postcard--skeleton">
            <div className="skel-head">
              <span className="skel skel--avatar" />
              <div className="skel skel--handle" />
            </div>
            <div className="skel skel--line" />
            <div className="skel skel--line skel--short" />
          </div>
        ))}
      </div>
    </>
  );
}

// Client-side filters over the loaded cards. Counts show only where they
// change what the reader does: open questions under Asks, everything under All.
function FilterRow({ filter, setFilter, cards }) {
  const openAsks = cards.filter(isOpenQuestion).length;
  return (
    <div className="feed-filters" role="tablist" aria-label="Filter posts">
      {FILTERS.map((f) => {
        const on = f.id === filter;
        const count = f.id === 'all' ? cards.length : f.id === 'asks' ? openAsks : null;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`feed-filter${on ? ' on' : ''}${f.id === 'asks' && openAsks ? ' feed-filter--asks' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {count ? <span className="feed-filter-n">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function FeedItems({ items, projectId, now, onView, onReact, onReply }) {
  return (
    <div className="feed-list">
      {items.map((item) => {
        if (item.type === 'day') {
          return (
            <div key={item.id} className="feed-day">
              {dayLabel(item.ts, now)}
            </div>
          );
        }
        if (item.type === 'unseen') {
          return (
            <div key={item.id} className="feed-unseen">
              new since your last visit
            </div>
          );
        }
        return (
          <PostCard
            key={item.id}
            card={item.card}
            projectId={projectId}
            onView={onView}
            now={now}
            onReact={onReact}
            onReply={onReply}
          />
        );
      })}
    </div>
  );
}

/**
 * Reverse-chronological agent feed shared by desktop and mobile. Remote state
 * and races live in useFeedStream; this component only presents that state.
 */
export default function Feed() {
  const projectId = useProjectStore((state) => state.projectId);
  const stream = useFeedStream(projectId);
  const now = useNow();
  const [filter, setFilter] = useState('all');
  const cards = useMemo(() => buildCards(stream.posts), [stream.posts]);
  const shown = useMemo(
    () => (filter === 'all' ? cards : cards.filter((c) => cardMatches(c, filter))),
    [cards, filter],
  );
  const items = useMemo(
    () => withDayDividers(shown, now, stream.lastSeenSeq),
    [shown, now, stream.lastSeenSeq],
  );

  return (
    <div className="feed-stage">
      <h1 className="feed-title">Feed</h1>
      <ContextHeader posts={stream.posts} voices={stream.voices} now={now} />
      {stream.status === 'ready' && stream.posts.length > 0 && (
        <FilterRow filter={filter} setFilter={setFilter} cards={cards} />
      )}
      {stream.status === 'ready' && stream.nudge && (
        <div className="feed-nudge">{nudgeLabel(stream.nudge)}</div>
      )}
      <div className="feed-newpill-wrap" aria-live="polite">
        {stream.pending.length > 0 && (
          <button
            type="button"
            className="feed-newpill"
            onClick={() => stream.revealPending(true)}
          >
            ↑ {stream.pending.length} new post
            {stream.pending.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {stream.status === 'loading' && <LoadingFeed />}
      {stream.status === 'error' && (
        <div className="feed-empty" role="alert">
          <p className="feed-empty-title">Couldn’t load the feed</p>
          <p className="feed-empty-sub">{stream.error}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm feed-retry"
            onClick={stream.retry}
          >
            Try again
          </button>
        </div>
      )}
      {stream.status === 'ready' && stream.posts.length === 0 && (
        <div className="feed-empty">
          <p className="feed-empty-title">No posts yet</p>
          <p className="feed-empty-sub">
            Agents post their findings, kills, ideas, papers, and questions here as they work.
          </p>
        </div>
      )}
      {stream.status === 'ready' && stream.posts.length > 0 && shown.length === 0 && (
        <div className="feed-empty">
          <p className="feed-empty-title">Nothing here yet</p>
          <p className="feed-empty-sub">No loaded posts match this filter.</p>
        </div>
      )}
      {shown.length > 0 && (
        <FeedItems
          items={items}
          projectId={projectId}
          now={now}
          onView={stream.onView}
          onReact={stream.onReact}
          onReply={stream.onReply}
        />
      )}
      {stream.hasMore && (
        <div ref={stream.sentinelRef} className="feed-sentinel">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={stream.loadMore}
          >
            Load older
          </button>
        </div>
      )}
    </div>
  );
}
