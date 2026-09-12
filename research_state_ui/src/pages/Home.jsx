import { Link } from 'react-router-dom';
import ProjectDocument from '../components/ProjectDocument';
import {
  useProjectStore,
  useProjectHref,
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
import { agentPrompt } from '../utils/vocab';

export default function Home() {
  const px = useProjectHref();
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

  // The home workflow is the active experiment's, or the project's own before
  // anything exists; either way its next action is the agent's next sentence.
  const next = agentPrompt(home?.workflow?.next_action, {
    state: home?.workflow?.state, name: home?.active_experiment?.name,
  });
  // First run: no agent has ever done anything here. Until the first
  // experiment exists the connect guide is the page.
  const firstRun = !!home && (stats.claims ?? 0) === 0 && (stats.experiments ?? 0) === 0 && (stats.artifacts ?? 0) === 0;

  const head = (
    <>
      {next && <p className="home-next"><span className="gate-banner-meta-key">Next for your agent</span> {next}</p>}
      {firstRun && <ConnectAgentPanel project={project} />}
      <ProjectDocument project={project} />
    </>
  );
  // Until the first experiment exists the document (and the guide) is the page.
  if (!(stats.experiments ?? 0)) return <div className="page-stage">{head}</div>;

  return (
    <div className="page-stage">
      {head}
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
          <StatCard to={px('/claims')} label="Claims" value={stats.claims ?? claims.length} sub={countOf(claims, 'status', 'active') + ' active'} />
          <StatCard to={px('/experiments')} label="Experiments" value={stats.experiments ?? experiments.length} sub={countOf(experiments, 'status', 'running') + ' running'} />
          <StatCard to={px('/artifacts')} label="Artifacts" value={stats.artifacts ?? 0} />
          <StatCard to={px('/sandboxes')} label="Sandboxes" value={runningSandboxes} sub="running" />
          <StatCard to={px('/reviews')} label="Open reviews" value={stats.open_reviews ?? 0} />
        </div>
      </section>
    </div>
  );
}

function StatCard({ to, label, value, sub }) {
  return (
    <Link to={to} className="stat-card">
      <div className="stat-card-key">{label}</div>
      <div className="stat-card-value tabular">{value}</div>
      {sub && <div className="stat-card-sub">{sub}</div>}
    </Link>
  );
}

function countOf(arr, key, val) {
  return (arr || []).filter(x => x && x[key] === val).length;
}
