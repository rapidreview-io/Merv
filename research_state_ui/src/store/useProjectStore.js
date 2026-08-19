import { create } from 'zustand';
import { api, CLIENT_VERSION } from '../api';

const PROJECT_KEY = 'rsui:projectId';

function loadInitialProjectId() {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch { return null; }
}

// Last-seen ETags for the three snapshot endpoints, scoped to one project.
// Module state, not store state: no component renders off it.
const etags = { pid: null, home: null, sandboxes: null, events: null };
function etagsFor(pid) {
  if (etags.pid !== pid) Object.assign(etags, { pid, home: null, sandboxes: null, events: null });
  return etags;
}

export const useProjectStore = create((set, get) => ({
  // Identity
  projectId: loadInitialProjectId(),
  projects: [],          // [{id, name, summary, created_at}]
  projectsLoaded: false,

  // Bootstrap state
  bootError: null,

  // Version/compat handshake (GET /api/meta). serverMeta holds the backend's
  // reported versions; compat is a {level, message, action?} banner descriptor
  // or null. Both are inert in local mode (versions match, no auth gate).
  serverMeta: null,
  compat: null,
  compatDismissed: false,

  // Live snapshot from GET /home
  home: null,            // {project, claims, experiments, artifacts, reviews, recent_events, stats, workflow, active_experiment, active_experiments, active_processes}
  sandboxes: [],         // project-wide sandbox list from GET /sandboxes (one per experiment)
  events: [],            // longer event window from GET /events?limit=500 — powers dashboard sparklines
  // GET /reflections — the waves + staleness signal Home's project graph is
  // built from. Fetched WITH a project's first /home snapshot (refreshHome)
  // so the graph paints complete on Home's first frame, instead of drawing
  // an experiments-only braid and reflowing when the waves land; kept fresh
  // afterwards by refreshReflections at the panel's own slow cadence.
  reflections: null,     // {reflections, signal} — null until the first fetch for this project settles
  lastSyncedAt: null,    // epoch ms of last successful refresh
  lastSyncError: null,
  isPolling: false,

  setProjectId(pid) {
    try {
      if (pid) localStorage.setItem(PROJECT_KEY, pid);
      else localStorage.removeItem(PROJECT_KEY);
    } catch {}
    set({ projectId: pid, home: null, sandboxes: [], events: [], reflections: null, lastSyncedAt: null, lastSyncError: null });
  },

  // Fetch the backend version/compat floor and derive a banner descriptor.
  // Best-effort: a backend too old to serve /api/meta just leaves it null.
  // The check is informational in local mode (versions match); it earns its
  // keep against a hosted control plane that has been upgraded under a stale
  // browser bundle, or one that hard-gates an old client (426).
  async checkMeta() {
    try {
      const meta = await api.getMeta();
      const server = meta?.server_version;
      let compat = null;
      if (server && server !== CLIENT_VERSION) {
        compat = {
          level: 'info',
          message: `Backend is v${server}; this UI was built for v${CLIENT_VERSION}. Reload to pick up the latest UI.`,
          action: 'reload',
        };
      }
      set({ serverMeta: meta, compat: compat && !get().compatDismissed ? compat : get().compat });
      return meta;
    } catch (err) {
      // A 426 means the control plane refuses this client version outright.
      if (err.code === 'client_too_old') {
        set({ compat: { level: 'error', message: err.message || 'This UI is too old for the backend; upgrade required.', action: 'reload' } });
      }
      return null;
    }
  },

  async loadProjects() {
    // Fetch version metadata before the first project render.
    await get().checkMeta();
    try {
      const data = await api.listProjects();
      const list = data.projects || [];
      // Clear any prior boot failure so Retry (or a recovered backend) can
      // actually leave the error page.
      set({ projects: list, projectsLoaded: true, bootError: null });
      // If the persisted project id is gone, fall back to the first one.
      const current = get().projectId;
      if (current && !list.some(p => p.id === current)) {
        get().setProjectId(list[0]?.id || null);
      } else if (!current && list.length > 0) {
        get().setProjectId(list[0].id);
      }
      return list;
    } catch (err) {
      // Distinguish the control-plane auth/version gates from a dead backend
      // so the banner can say something actionable instead of "not reachable".
      if (err.code === 'unauthorized') {
        set({ compat: { level: 'error', message: 'The backend requires sign-in. Set an API token to continue.', action: null } });
      } else if (err.code === 'client_too_old') {
        set({ compat: { level: 'error', message: err.message, action: 'reload' } });
      }
      set({ bootError: err.message, projectsLoaded: true });
      return [];
    }
  },

  dismissCompat() { set({ compat: null, compatDismissed: true }); },

  async createProject({ name, summary }) {
    const created = await api.createProject({ name, summary });
    const projectRow = created.project || created;
    await get().loadProjects();
    get().setProjectId(projectRow.id);
    await get().refreshHome();
    return projectRow;
  },

  async patchProject(pid, patch) {
    const updated = await api.patchProject(pid, patch);
    const row = updated.project || updated;
    set((state) => ({
      projects: state.projects.map(p => (p.id === pid ? { ...p, ...row } : p)),
    }));
    if (get().projectId === pid) await get().refreshHome();
    return row;
  },

  async refreshHome() {
    const pid = get().projectId;
    if (!pid) return null;
    // Fetch /home, /sandboxes, and a deeper /events window in parallel,
    // conditionally (If-None-Match): a 304 slice keeps its current state and
    // skips the write, so an unchanged backend costs no re-render.
    // /home's recent_events is capped at ~25, too few for the Events page;
    // the deeper window powers anything that needs ≥1h of history.
    const tags = etagsFor(pid);
    try {
      // A failed side-fetch must read as "unchanged", not "changed to empty":
      // notModified:false here would blank the last-good list and drop its ETag.
      const failedFetch = { notModified: true, etag: null, data: null };
      // The waves ride a project's FIRST snapshot (the slice is null until
      // then) and land in the same write as /home, so Home never renders
      // with the experiments in hand but the waves still on the wire — the
      // project graph would draw a different picture and then reflow. A
      // failed first fetch must not hold Home hostage: it settles the slice
      // as "no waves" and refreshReflections retries at its cadence.
      const wantReflections = get().reflections === null;
      const [home, sandboxesResp, eventsResp, reflections] = await Promise.all([
        api.getHomeIfChanged(pid, tags.home),
        api.listSandboxesIfChanged(pid, tags.sandboxes).catch(() => failedFetch),
        api.listEventsIfChanged(pid, 500, tags.events).catch(() => failedFetch),
        wantReflections ? api.getReflections(pid).catch(() => EMPTY_REFLECTIONS) : null,
      ]);
      // Drop the write if the active project changed while this fetch was in
      // flight, so a late response for the previous project can't clobber the
      // one the URL now points at (the project id lives in the URL; switching
      // leaves the prior poll outstanding).
      if (get().projectId !== pid) return null;
      const patch = { lastSyncedAt: Date.now(), lastSyncError: null };
      if (!home.notModified) {
        patch.home = home.data;
        tags.home = home.etag;
      }
      // A concurrent first refresh may have settled the slice already; the
      // later arrival is no fresher, so leave it be.
      if (reflections && get().reflections === null) {
        patch.reflections = reflections;
      }
      if (!sandboxesResp.notModified) {
        patch.sandboxes = Array.isArray(sandboxesResp.data?.sandboxes) ? sandboxesResp.data.sandboxes : [];
        tags.sandboxes = sandboxesResp.etag;
      }
      if (!eventsResp.notModified) {
        patch.events = Array.isArray(eventsResp.data?.events) ? eventsResp.data.events : [];
        tags.events = eventsResp.etag;
      }
      set(patch);
      return patch.home ?? get().home;
    } catch (err) {
      if (get().projectId !== pid) return null;
      set({ lastSyncError: err.message });
      return null;
    }
  },

  // Steady-state refresh of the reflections slice, at whatever cadence the
  // caller (Home's project graph) chooses — waves change on the order of
  // days, not seconds. Identity-stable: an unchanged payload is dropped so
  // nothing downstream re-renders; a failed fetch keeps the last good one.
  async refreshReflections() {
    const pid = get().projectId;
    if (!pid) return null;
    try {
      const payload = await api.getReflections(pid);
      if (get().projectId !== pid) return null;
      const prev = get().reflections;
      if (JSON.stringify(prev) !== JSON.stringify(payload)) set({ reflections: payload });
      return payload;
    } catch {
      return null;
    }
  },

  setPolling(on) { set({ isPolling: on }); },

  // True while the SSE event stream is open; pollers slow down or pause and
  // rely on stream signals instead.
  streamHealthy: false,
  setStreamHealthy(on) {
    if (get().streamHealthy !== on) set({ streamHealthy: on });
  },
}));

/**
 * Selector helpers — keep components from re-rendering on unrelated slices.
 *
 * NOTE: every selector must return an *identity-stable* reference when the
 * underlying slice is missing. Zustand's getSnapshot contract requires this:
 * returning a fresh `[]` / `{}` every call would re-trigger React's external
 * store and cause "Maximum update depth exceeded".
 */
const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);
// What a settled-but-empty reflections slice looks like (a first fetch that
// failed): a project with no waves, so Home renders and the graph draws the
// pre-wave braid it would draw for a young project.
const EMPTY_REFLECTIONS = Object.freeze({ reflections: EMPTY_ARR, signal: null });

export const selectStats = (s) => s.home?.stats || EMPTY_OBJ;
export const selectClaims = (s) => s.home?.claims || EMPTY_ARR;
export const selectExperiments = (s) => s.home?.experiments || EMPTY_ARR;
export const selectTasks = (s) => s.home?.tasks || EMPTY_ARR;
export const selectActiveTasks = (s) => s.home?.active_tasks || EMPTY_ARR;
// Server returns reviews as { requests, reviews } on /home and on /reviews.
export const selectReviewRequests = (s) => {
  const r = s.home?.reviews;
  if (r && !Array.isArray(r) && typeof r === 'object') return r.requests || EMPTY_ARR;
  return EMPTY_ARR;
};
export const selectEvents = (s) => s.home?.recent_events || EMPTY_ARR;
export const selectActiveExperiments = (s) => s.home?.active_experiments || EMPTY_ARR;
export const selectActiveProcesses = (s) => s.home?.active_processes || EMPTY_ARR;
export const selectSandboxes = (s) => s.sandboxes || EMPTY_ARR;
export const selectEventsAll = (s) => s.events || EMPTY_ARR;
export const selectProject = (s) => s.home?.project || null;
// null until the project's first reflections fetch has settled (see refreshHome).
export const selectReflections = (s) => s.reflections;

/**
 * Project-scoped routing. The active project id lives in the URL under
 * `/p/<projectId>/…`; <ProjectScope> in App.jsx mirrors it into the store, so
 * every component keeps reading `projectId` from the store unchanged.
 *
 * projectPath('proj_1', '/claims')  -> '/p/proj_1/claims'
 * projectPath('proj_1')             -> '/p/proj_1'
 * Builds an absolute in-app path; sub is a route under the project root.
 */
export function projectPath(projectId, sub = '') {
  if (!projectId) return sub || '/';
  if (!sub || sub === '/') return `/p/${projectId}`;
  return `/p/${projectId}${sub.startsWith('/') ? sub : `/${sub}`}`;
}

/**
 * Hook returning a prefixer bound to the active project: `const px =
 * useProjectHref()` then `to={px('/claims')}`. Use inside components; for plain
 * helper functions that cannot call hooks, use
 * `projectPath(useProjectStore.getState().projectId, …)` instead.
 */
export function useProjectHref() {
  const projectId = useProjectStore((s) => s.projectId);
  return (sub = '') => projectPath(projectId, sub);
}
