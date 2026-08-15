import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api';
import { summarize } from '../components/autorunSummary';

/**
 * Auto-run status shared by the sidebar link, the Home strip, and anything
 * else that wants "is auto-run doing something right now?" without owning a
 * poller. One poll per project (GET agent-sessions), visibility-aware, and
 * only while at least one subscriber is mounted. The Auto-run page itself
 * keeps its own richer 10 s poll; this is the cheap ambient view.
 */

const POLL_MS = 15_000;
const EMPTY = Object.freeze([]);

export const useAutorunStatusStore = create((set, get) => ({
  projectId: null,
  runners: EMPTY,
  sessions: EMPTY,
  fetchedAt: 0,
  error: '',
  subscribers: 0,
  timer: null,

  async refresh() {
    const pid = get().projectId;
    if (!pid) return;
    try {
      const response = await api.listAgentSessions(pid);
      if (get().projectId !== pid) return;
      const runners = Array.isArray(response?.runners)
        ? response.runners
        : (response?.runner ? [response.runner] : EMPTY);
      set({ runners, sessions: response?.sessions || EMPTY, fetchedAt: Date.now(), error: '' });
    } catch (err) {
      if (get().projectId !== pid) return;
      set({ error: err?.message || 'unavailable' });
    }
  },

  attach(pid) {
    const state = get();
    if (state.projectId !== pid) {
      set({ projectId: pid, runners: EMPTY, sessions: EMPTY, fetchedAt: 0, error: '' });
    }
    set({ subscribers: state.subscribers + 1 });
    // Always fetch once so a background tab (or a headless pane) still gets a
    // first answer; only the repeating poll is gated on visibility.
    get().refresh();
    if (!get().onVisibility) {
      const start = () => {
        if (get().timer) return;
        set({ timer: setInterval(() => get().refresh(), POLL_MS) });
      };
      const stop = () => {
        const { timer } = get();
        if (timer) clearInterval(timer);
        set({ timer: null });
      };
      const onVisibility = () => {
        if (document.visibilityState === 'visible') start(); else stop();
      };
      document.addEventListener('visibilitychange', onVisibility);
      set({ onVisibility });
      if (document.visibilityState === 'visible') start();
    }
  },

  detach() {
    const remaining = Math.max(get().subscribers - 1, 0);
    set({ subscribers: remaining });
    if (remaining === 0) {
      const { timer, onVisibility } = get();
      if (timer) clearInterval(timer);
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
      set({ timer: null, onVisibility: null });
    }
  },
}));

/** Subscribe the calling component to ambient auto-run status for a project. */
export function useAutorunStatus(projectId) {
  const attach = useAutorunStatusStore((s) => s.attach);
  const detach = useAutorunStatusStore((s) => s.detach);
  useEffect(() => {
    if (!projectId) return undefined;
    attach(projectId);
    return () => detach();
  }, [projectId, attach, detach]);
  const runners = useAutorunStatusStore((s) => (s.projectId === projectId ? s.runners : EMPTY));
  const sessions = useAutorunStatusStore((s) => (s.projectId === projectId ? s.sessions : EMPTY));
  const fetchedAt = useAutorunStatusStore((s) => (s.projectId === projectId ? s.fetchedAt : 0));
  return summarize({ runners, sessions, fetchedAt });
}
