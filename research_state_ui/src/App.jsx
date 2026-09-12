import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet, Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useProjectStore, projectPath, useProjectHref, selectActiveExperiments, selectSandboxes } from './store/useProjectStore';
import { usePolling } from './store/usePolling';
import { useEventStream } from './store/useEventStream';
import { useViewport } from './store/useViewport';
import Sidebar, { SIDEBAR_KB, IconSidebar } from './components/Sidebar';
import CompatBanner from './components/CompatBanner';
import Connecting, { FullPageStatus } from './components/Connecting';
import ErrorBoundary from './components/ErrorBoundary';
import { bootErrorView, retryDelayMs } from './utils/bootError';
import AppBackdrop from './bg/AppBackdrop';
import MobileShell from './mobile/MobileShell';
import HomeScreen from './mobile/HomeScreen';
import ExperimentCardList from './mobile/ExperimentCardList';
import MobileExperimentDetail from './mobile/MobileExperimentDetail';
import SandboxCardList from './mobile/SandboxCardList';
import MobileArtifacts from './mobile/MobileArtifacts';
import MobileClaims from './mobile/MobileClaims';
import MobileClaimDetail from './mobile/MobileClaimDetail';
import MobileReviews from './mobile/MobileReviews';
import MobileProjects from './mobile/MobileProjects';
import MobileProjectCreateNotice from './mobile/MobileProjectCreateNotice';
import MobileReflectionScreen from './mobile/MobileReflectionScreen';
import Home from './pages/Home';
import Feed from './feed/Feed';
import CreateProject from './pages/CreateProject';
import Projects from './pages/Projects';
import Claims from './pages/Claims';
import ClaimDetail from './pages/ClaimDetail';
import LitReview from './pages/LitReview';
import Experiments from './pages/Experiments';
import ExperimentDetail from './pages/ExperimentDetail';
import Tasks from './pages/Tasks';
import TaskDetail from './pages/TaskDetail';
import Reflection from './pages/Reflection';
import ReflectionDetail from './pages/ReflectionDetail';
import Artifacts from './pages/Artifacts';
import Storage from './pages/Storage';
import Reviews from './pages/Reviews';
import Events from './pages/Events';
import Sandboxes from './pages/Sandboxes';
import AutoRun from './pages/AutoRun';
import Debug from './pages/Debug';
import Settings from './pages/Settings';

// The project-scoped pages, one row each: path, desktop page, and the mobile
// screen where a card/segment version replaces the desktop-physics page.
const PAGES = [
  ['', Home, HomeScreen], ['feed', Feed], ['claims', Claims, MobileClaims],
  ['claims/:claimId', ClaimDetail, MobileClaimDetail], ['litreview', LitReview],
  ['experiments', Experiments, ExperimentCardList], ['experiments/:experimentId', ExperimentDetail, MobileExperimentDetail],
  ['tasks', Tasks], ['tasks/:taskId', TaskDetail],
  ['reflection', Reflection, MobileReflectionScreen], ['reflection/:reflectionId', ReflectionDetail, MobileReflectionScreen],
  ['artifacts', Artifacts, MobileArtifacts], ['artifacts/:artifactId', Artifacts, MobileArtifacts],
  ['storage', Storage], ['storage/:objectId', Storage], ['reviews', Reviews, MobileReviews], ['events', Events],
  ['sandboxes', Sandboxes, SandboxCardList], ['auto-run', AutoRun], ['settings', Settings],
  ['activity', Debug], ['debug', DebugRedirect],
];

// /debug merged into /activity. Preserve ?tool= (v6 <Navigate> drops search).
// Lives under /p/:projectId, so redirect into the same project's /activity.
function DebugRedirect() {
  const px = useProjectHref();
  const [sp] = useSearchParams();
  const q = sp.toString();
  return <Navigate to={`${px('/activity')}${q ? `?${q}` : ''}`} replace />;
}

/**
 * Layout for the /p/:projectId subtree. The URL is the source of truth for the
 * active project: mirror the route param into the store (so every consumer that
 * reads `projectId` keeps working untouched). An id that is not in the
 * workspace (a link from another workspace, a removed project) says so above
 * the project picker rather than silently landing on some other project.
 * Holds a frame while syncing so children never fetch the previous project.
 */
function ProjectScope() {
  const { projectId: routePid } = useParams();
  const projects = useProjectStore(s => s.projects);
  const storePid = useProjectStore(s => s.projectId);
  const setProjectId = useProjectStore(s => s.setProjectId);
  const isMobile = useViewport();
  const known = projects.some(p => p.id === routePid);

  // Mirror the URL's project into the store. usePolling re-kicks an immediate
  // refresh whenever projectId changes, so we deliberately don't fetch here —
  // that avoids a double load, and refreshHome's identity guard drops any poll
  // still in flight for the project we just left.
  useEffect(() => {
    if (known && routePid && routePid !== storePid) {
      setProjectId(routePid);
    }
  }, [known, routePid, storePid, setProjectId]);

  if (!known) {
    return (
      <>
        <div className="page-stage" style={{ paddingBottom: 0 }}>
          <div className="empty-state" style={{ textAlign: 'left' }}>
            <h2>Project <span className="mono">{routePid}</span> isn’t in your workspace</h2>
            <p>It belongs to another workspace or was removed. Open one of yours instead.</p>
          </div>
        </div>
        {isMobile ? <MobileProjects /> : <Projects />}
      </>
    );
  }
  if (routePid !== storePid) return <FullPageStatus>Loading project…</FullPageStatus>;
  return <Outlet />;
}

// Desktop sidebar visibility — survives reloads, default open.
const SIDEBAR_KEY = 'rsui:sidebar';
function readSidebarOpen() {
  try { return localStorage.getItem(SIDEBAR_KEY) !== 'closed'; } catch { return true; }
}
function writeSidebarOpen(open) {
  try { localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed'); } catch { /* best-effort */ }
  return open;
}

// Root ("/") lands on the active project's home.
function RootRedirect() {
  const storePid = useProjectStore(s => s.projectId);
  const projects = useProjectStore(s => s.projects);
  const target = storePid || projects[0]?.id;
  return target
    ? <Navigate to={projectPath(target)} replace />
    : <FullPageStatus>Selecting project…</FullPageStatus>;
}

// Anything unmatched is a real 404, not a quiet bounce to Home.
function NotFound() {
  const storePid = useProjectStore(s => s.projectId);
  return (
    <FullPageStatus>
      <h2>Page not found</h2>
      <p>Nothing lives at <span className="mono">{window.location.pathname}</span>.</p>
      <p><Link className="btn" to={storePid ? projectPath(storePid) : '/'}>← Home</Link></p>
    </FullPageStatus>
  );
}

export default function App() {
  const projectId = useProjectStore(s => s.projectId);
  const projects = useProjectStore(s => s.projects);
  const projectsLoaded = useProjectStore(s => s.projectsLoaded);
  const bootError = useProjectStore(s => s.bootError);
  const loadProjects = useProjectStore(s => s.loadProjects);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const isMobile = useViewport();
  const activeExperiments = useProjectStore(selectActiveExperiments);
  const sandboxes = useProjectStore(selectSandboxes);
  // Adaptive cadence on mobile: poll fast only while something is live (a
  // running experiment / sandbox), and decay to 30s
  // on a quiet Now screen where each cellular radio wakeup is the dominant
  // battery cost. Pull-to-refresh is the instant override. Desktop stays 3s.
  const somethingLive =
    activeExperiments.some(e => e.status === 'running') ||
    sandboxes.some(s => s.status === 'running' || s.status === 'provisioning');
  const interval = isMobile ? (somethingLive ? 5000 : 30000) : 3000;
  // Server push first: while the SSE stream is open it triggers refreshHome
  // on demand and the interval poller stands down (it remains the fallback —
  // stream drop → streamHealthy flips → polling resumes at today's cadence).
  useEventStream();
  const streamHealthy = useProjectStore(s => s.streamHealthy);
  usePolling(interval, { enabled: !streamHealthy });
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const toggleSidebar = () => setSidebarOpen(v => writeSidebarOpen(!v));
  const { pathname } = useLocation();

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // A failed boot retries on its own with backoff, so a backend that comes
  // back is noticed without a click; the typed gates (401/426) only reload.
  const bootView = bootError && bootErrorView(bootError, import.meta.env.DEV);
  useEffect(() => {
    if (!bootView?.retry) return undefined;
    const t = setTimeout(loadProjects, retryDelayMs(bootError.tries));
    return () => clearTimeout(t);
  }, [bootError, bootView?.retry, loadProjects]);

  // ⌘B / Ctrl+B toggles the sidebar (desktop shell only) — skipped while
  // typing so contenteditable bold and terminal input stay untouched.
  useEffect(() => {
    if (isMobile) return undefined;
    const onKey = (e) => {
      if (e.key !== 'b' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setSidebarOpen(v => writeSidebarOpen(!v));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile]);

  if (!projectsLoaded) return <Connecting />;
  if (bootError) {
    return (
      <FullPageStatus>
        <h2>{bootView.title}</h2>
        <p>{bootView.body}</p>
        {bootView.hint && <p className="mono" style={{ fontSize: 'var(--text-xs)', marginTop: 8 }}>{bootView.hint}</p>}
        <div style={{ marginTop: 18 }}>
          <button className="btn" onClick={bootView.reload ? () => window.location.reload() : loadProjects}>
            {bootView.reload ? 'Reload' : 'Retry'}
          </button>
        </div>
        {bootError.message !== bootView.title && <div className="error-message" style={{ marginTop: 10 }}>{bootError.message}</div>}
      </FullPageStatus>
    );
  }
  // Bootstrap: no projects yet → render bare CreateProject without the shell.
  // On mobile the directory-path form is unfillable, so show an honest notice.
  if (projects.length === 0) {
    return isMobile ? <MobileProjectCreateNotice bootstrap /> : <CreateProject bootstrap />;
  }
  // Have projects but no active selection (race during setProjectId clearing) → wait.
  if (!projectId) {
    return <FullPageStatus>Selecting project…</FullPageStatus>;
  }

  // Same router and store on both surfaces; a mobile shell and landing, with
  // card/segment screens replacing the desktop-physics pages (min-width
  // tables, hover tooltips, side panels). Each route's boundary is keyed by
  // path so navigating away clears a caught render error.
  const page = (
    <>
      <CompatBanner />
      <ErrorBoundary key={pathname}>
        <Routes>
          {/* Global project picker (unscoped) */}
          <Route path="/projects" element={isMobile ? <MobileProjects /> : <Projects />} />
          <Route path="/projects/new" element={isMobile ? <MobileProjectCreateNotice /> : <CreateProject />} />
          {/* Project-scoped surface */}
          <Route path="/p/:projectId" element={<ProjectScope />}>
            {PAGES.map(([path, Desktop, Mobile = Desktop]) => {
              const Page = isMobile ? Mobile : Desktop;
              return path
                ? <Route key={path} path={path} element={<Page />} />
                : <Route key="index" index element={<Page />} />;
            })}
          </Route>
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </>
  );

  if (isMobile) return <MobileShell onRefresh={refreshHome}>{page}</MobileShell>;

  return (
    <>
      <AppBackdrop />
      <div className={'shell' + (sidebarOpen ? '' : ' shell--nosb')}>
        <Sidebar onHide={toggleSidebar} />
        {!sidebarOpen && (
          <button
            type="button"
            className="sb-edge"
            onClick={toggleSidebar}
            title={`Show sidebar (${SIDEBAR_KB})`}
            aria-label="Show sidebar"
          >
            <span className="sb-edge-glyph" aria-hidden="true"><IconSidebar /></span>
          </button>
        )}
        <main className="shell-main">{page}</main>
      </div>
    </>
  );
}
