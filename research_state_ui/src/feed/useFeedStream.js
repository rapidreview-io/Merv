import { useCallback, useEffect, useRef, useState } from 'react';
import { feedApi } from './feedApi';

const PAGE_SIZE = 20;
const POLL_MS = 10000;

/**
 * Own the feed's remote state: initial load, newer-post polling, cursor
 * pagination, project-switch race protection, last-seen persistence, and
 * optimistic researcher actions. Presentation stays in Feed.jsx.
 */
export function useFeedStream(projectId) {
  const [stateCycleId, setStateCycleId] = useState(-1);
  const [posts, setPosts] = useState([]);
  const [pending, setPending] = useState([]);
  const [lastSeenSeq, setLastSeenSeq] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [nudge, setNudge] = useState(null);
  const [voices, setVoices] = useState([]);
  const loadingMoreRef = useRef(null);
  const sentinelRef = useRef(null);
  const topSeqRef = useRef(0);
  const pendingRef = useRef([]);
  const cycleRef = useRef({ projectId, retryKey, id: 0 });
  if (
    cycleRef.current.projectId !== projectId
    || cycleRef.current.retryKey !== retryKey
  ) {
    cycleRef.current = {
      projectId,
      retryKey,
      id: cycleRef.current.id + 1,
    };
  }
  const renderCycle = cycleRef.current;
  const ownsVisibleState = Boolean(
    projectId && stateCycleId === renderCycle.id,
  );

  useEffect(() => {
    topSeqRef.current = pending[0]?.created_seq ?? posts[0]?.created_seq ?? 0;
    pendingRef.current = pending;
  }, [posts, pending]);

  const seenKey = projectId ? `rsui:feed:lastSeen:${projectId}` : null;

  useEffect(() => {
    if (!projectId) {
      setStateCycleId(cycleRef.current.id);
      setPosts([]);
      setPending([]);
      setLastSeenSeq(null);
      setCursor(null);
      setHasMore(false);
      setNudge(null);
      setVoices([]);
      setError('');
      setStatus('ready');
      loadingMoreRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const requestCycle = cycleRef.current;
    setStateCycleId(requestCycle.id);
    loadingMoreRef.current = null;
    setStatus('loading');
    setError('');
    setPosts([]);
    setPending([]);
    setCursor(null);
    setHasMore(false);
    setNudge(null);
    setVoices([]);
    const stored = Number(localStorage.getItem(`rsui:feed:lastSeen:${projectId}`));
    setLastSeenSeq(Number.isFinite(stored) && stored > 0 ? stored : null);
    feedApi.getFeed(projectId, { limit: PAGE_SIZE })
      .then((data) => {
        if (cancelled || cycleRef.current !== requestCycle) return;
        setPosts(data.posts || []);
        setCursor(data.next_cursor ?? null);
        setHasMore(data.next_cursor != null);
        setNudge(data.nudge || null);
        setVoices(data.voices || []);
        setStatus('ready');
        feedApi.trackFeed(
          projectId,
          'feed_opened',
          { count: (data.posts || []).length },
        ).catch(() => {});
      })
      .catch((e) => {
        if (cancelled || cycleRef.current !== requestCycle) return;
        setError(e.message || 'Failed to load feed');
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [projectId, retryKey]);

  useEffect(() => {
    if (!ownsVisibleState || status !== 'ready' || !seenKey) return;
    const top = posts[0]?.created_seq;
    if (top == null) return;
    const stored = Number(localStorage.getItem(seenKey)) || 0;
    if (top > stored) localStorage.setItem(seenKey, String(top));
  }, [posts, status, seenKey, ownsVisibleState]);

  useEffect(() => {
    if (!ownsVisibleState || !projectId || status !== 'ready') return undefined;
    const requestCycle = cycleRef.current;
    const controller = new AbortController();
    const timer = setInterval(() => {
      feedApi.getFeed(projectId, { limit: PAGE_SIZE, signal: controller.signal })
        .then((data) => {
          if (cycleRef.current !== requestCycle) return;
          setNudge(data.nudge || null);
          if (Array.isArray(data.voices)) setVoices(data.voices);
          const fresh = (data.posts || [])
            .filter((post) => post.created_seq > topSeqRef.current);
          if (!fresh.length) return;
          setPending((previous) => {
            const seen = new Set(previous.map((post) => post.id));
            const additions = fresh.filter((post) => !seen.has(post.id));
            return additions.length ? [...additions, ...previous] : previous;
          });
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [projectId, status, ownsVisibleState]);

  const revealPending = useCallback((scroll) => {
    const buffered = pendingRef.current;
    if (buffered.length) {
      setPosts((previous) => {
        const seen = new Set(previous.map((post) => post.id));
        const additions = buffered.filter((post) => !seen.has(post.id));
        return additions.length ? [...additions, ...previous] : previous;
      });
      setPending([]);
    }
    if (scroll) window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    if (!ownsVisibleState || !pending.length) return undefined;
    if (window.scrollY <= 80) {
      revealPending(false);
      return undefined;
    }
    const onScroll = () => {
      if (window.scrollY <= 80) revealPending(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [pending, revealPending, ownsVisibleState]);

  const loadMore = useCallback(() => {
    if (
      !projectId
      || cycleRef.current.projectId !== projectId
      || loadingMoreRef.current === cycleRef.current
      || cursor == null
    ) return;
    const requestCycle = cycleRef.current;
    loadingMoreRef.current = requestCycle;
    feedApi.getFeed(projectId, { limit: PAGE_SIZE, cursor })
      .then((data) => {
        if (cycleRef.current !== requestCycle) return;
        const older = data.posts || [];
        setPosts((previous) => {
          const seen = new Set(previous.map((post) => post.id));
          return [...previous, ...older.filter((post) => !seen.has(post.id))];
        });
        setCursor(data.next_cursor ?? null);
        setHasMore(data.next_cursor != null);
      })
      .catch(() => {})
      .finally(() => {
        if (loadingMoreRef.current === requestCycle) {
          loadingMoreRef.current = null;
        }
      });
  }, [projectId, cursor]);

  useEffect(() => {
    if (!ownsVisibleState || !hasMore || !sentinelRef.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore, posts.length, ownsVisibleState]);

  const onView = useCallback((postId) => {
    if (projectId && cycleRef.current.projectId === projectId) {
      feedApi.trackFeed(projectId, 'post_viewed', { post_id: postId })
        .catch(() => {});
    }
  }, [projectId]);

  const onReact = useCallback((post, kind) => {
    if (!projectId || cycleRef.current.projectId !== projectId) return;
    const requestCycle = cycleRef.current;
    const on = !post.reactions?.[kind];
    const update = (id, value) => setPosts((previous) => previous.map((item) => (
      item.id === id
        ? { ...item, reactions: { ...(item.reactions || {}), [kind]: value } }
        : item
    )));
    update(post.id, on);
    feedApi.setReaction(projectId, post.id, kind, on)
      .then((data) => {
        if (cycleRef.current !== requestCycle) return;
        const view = data?.post || data;
        if (!view?.id || !view.reactions) return;
        setPosts((previous) => previous.map((item) => (
          item.id === view.id ? { ...item, reactions: view.reactions } : item
        )));
      })
      .catch(() => {
        if (cycleRef.current === requestCycle) update(post.id, !on);
      });
  }, [projectId]);

  const onReply = useCallback(async (post, text) => {
    if (!projectId || cycleRef.current.projectId !== projectId) {
      throw new Error('Project changed; please retry the reply');
    }
    const requestCycle = cycleRef.current;
    const data = await feedApi.reply(projectId, post.id, text);
    const view = data?.post || data;
    if (cycleRef.current === requestCycle && view?.id) {
      setPosts((previous) => (
        previous.some((item) => item.id === view.id)
          ? previous
          : [view, ...previous]
      ));
    }
    return view;
  }, [projectId]);

  return {
    posts: ownsVisibleState ? posts : [],
    pending: ownsVisibleState ? pending : [],
    lastSeenSeq: ownsVisibleState ? lastSeenSeq : null,
    status: projectId ? (ownsVisibleState ? status : 'loading') : 'ready',
    error: ownsVisibleState ? error : '',
    nudge: ownsVisibleState ? nudge : null,
    voices: ownsVisibleState ? voices : [],
    hasMore: ownsVisibleState ? hasMore : false,
    sentinelRef,
    revealPending,
    loadMore,
    onView,
    onReact,
    onReply,
    retry: () => setRetryKey((key) => key + 1),
  };
}
