import ProjectIntentEditor from '../components/ProjectIntentEditor';
import { useNavigate } from 'react-router-dom';
import { useProjectStore, projectPath } from '../store/useProjectStore';
import ObjId from '../components/ObjId';

/**
 * Mobile project switcher with the shared user-intent editor.
 */
export default function MobileProjects() {
  const navigate = useNavigate();
  const projects = useProjectStore(s => s.projects);
  const projectId = useProjectStore(s => s.projectId);

  // URL drives the active project; <ProjectScope> mirrors it into the store.
  function switchTo(pid) {
    navigate(projectPath(pid));
  }

  return (
    <div className="page-stage">
      <header className="page-header">
        <h1 className="page-title">Projects</h1>
        <p className="page-summary">Tap to switch.</p>
      </header>

      {projects.length === 0 ? (
        <div className="empty-state">
          <h2>No projects yet</h2>
          <p>Create one from desktop or CLI.</p>
        </div>
      ) : (
        <div className="mcard-list">
          {projects.map(p => (
            <div key={p.id}>
              <button
                type="button"
                className={`mcard${p.id === projectId ? ' mcard--attn' : ''}`}
                onClick={() => switchTo(p.id)}
              >
                <div className="mcard-head">
                  <div className="mcard-title">{p.name || 'Untitled'}</div>
                  {p.id === projectId && <span className="proj-active-tag">Active</span>}
                </div>
                {p.summary && <div className="mcard-sub">{p.summary}</div>}
                <div className="mcard-meta">
                  <ObjId id={p.id} strong />
                </div>
              </button>
              <ProjectIntentEditor project={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
