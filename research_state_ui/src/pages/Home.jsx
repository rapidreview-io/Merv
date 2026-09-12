import ProjectDocument from '../components/ProjectDocument';
import {
  useProjectStore,
  selectProject,
  selectStats,
  selectClaims,
  selectExperiments,
  selectSandboxes,
  selectEventsAll,
} from '../store/useProjectStore';
import SandboxTable from '../components/SandboxTable';
import ComputeSpend from '../components/ComputeSpend';
import ConnectAgentPanel from '../components/ConnectAgentPanel';
import AutorunStrip from '../components/AutorunStrip';
import ProjectReflectionPanel from '../components/ProjectReflectionPanel';

export default function Home() {
  const project = useProjectStore(selectProject);
  const home = useProjectStore((s) => s.home);
  const stats = useProjectStore(selectStats);
  const claims = useProjectStore(selectClaims);
  const experiments = useProjectStore(selectExperiments);
  const sandboxes = useProjectStore(selectSandboxes);
  const events = useProjectStore(selectEventsAll);
  const runningSandboxes = sandboxes.filter(s => s.status === 'running').length;

  if (!project) {
    return <div className="page-stage"><ProjectDocument /></div>;
  }

  // First run: the home snapshot has loaded and no agent has ever done
  // anything here — no claims, experiments, or artifacts, and no events
  // beyond the project's own metadata (every project is born with
  // project.created). Until then the connect guide leads the page; the first
  // recorded research event retires it for good.
  const firstRun = !!home
    && (stats.claims ?? 0) === 0
    && (stats.experiments ?? 0) === 0
    && (stats.artifacts ?? 0) === 0
    && events.every((e) => typeof e.type === 'string' && e.type.startsWith('project.'));

  return (
    <div className="page-stage">
      <ProjectDocument project={project} />

      {firstRun && <ConnectAgentPanel project={project} />}

      <AutorunStrip project={project} />

      <ProjectReflectionPanel projectId={project.id} />

      <section className="section">
        <div className="section-title">
          Sandboxes
          {runningSandboxes > 0 && (
            <span className="section-title-badge">
              <span className="sidebar-live-dot" />{runningSandboxes} running
            </span>
          )}
        </div>
        <SandboxTable
          sandboxes={sandboxes}
          experiments={experiments}
          events={events}
          projectId={project.id}
          empty={(
            <div className="empty-state empty-state--compact">
              <p>No sandboxes yet.</p>
            </div>
          )}
        />
      </section>

      <ComputeSpend
        projectId={project.id}
        fleetSignal={`${sandboxes.length}:${runningSandboxes}`}
      />

      <section className="section">
        <div className="section-title">Counts</div>
        <div className="stat-grid">
          <StatCard label="Claims" value={stats.claims ?? claims.length} sub={countOf(claims, 'status', 'active') + ' active'} />
          <StatCard label="Experiments" value={stats.experiments ?? experiments.length} sub={countOf(experiments, 'status', 'running') + ' running'} />
          <StatCard label="Artifacts" value={stats.artifacts ?? 0} />
          <StatCard label="Sandboxes" value={runningSandboxes} sub="running" />
          <StatCard label="Open reviews" value={stats.open_reviews ?? stats.reviews ?? 0} />
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-card-key">{label}</div>
      <div className="stat-card-value tabular">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </div>
  );
}

function countOf(arr, key, val) {
  return (arr || []).filter(x => x && x[key] === val).length;
}
