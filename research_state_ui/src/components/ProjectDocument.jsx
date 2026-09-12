import { useCallback } from 'react';
import { api } from '../api';
import { Link } from 'react-router-dom';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { entityRoute } from '../utils/entityResolve';
import MarkdownView from './MarkdownView';
import ProjectIntentEditor from './ProjectIntentEditor';
import './project-document.css';

/** The home snapshot is the canonical read; published prose and live states stay distinct. */
export default function ProjectDocument({ project }) {
  const px = useProjectHref();
  // Polling changes reference statuses; only changed artifact IDs should remount figures.
  const figureIds = (project?.references || []).filter(ref => ref.kind === 'artifact').map(ref => ref.id).sort().join('\n');
  const projectId = project?.id;
  const resolveFigure = useCallback(src => figureIds.split('\n').includes(src)
    ? api.artifactFileUrl(projectId, src) : null, [projectId, figureIds]);
  const error = useProjectStore(s => s.lastSyncError);
  const refresh = useProjectStore(s => s.refreshHome);
  if (!project) return <section className="project-document" aria-label="Project document">
    {error ? <div role="alert">Could not load the project document. <button className="btn btn--sm" onClick={refresh}>Retry</button></div>
      : <p role="status">Loading project document…</p>}
  </section>;

  const hasNarrative = Boolean(project.methods || project.results);
  // Maintenance only means something once a narrative exists to maintain.
  const maintenance = hasNarrative ? project.maintenance : null;
  const status = maintenance?.state === 'writing' ? 'Revision pending'
    : maintenance?.pending ? 'Update pending' : 'No pending updates';
  return (
    <section className="project-document" aria-label="Project document">
      <header className="project-document-heading">
        <div><h2>Project document</h2><p className="muted">The project and the research so far.</p></div>
        {maintenance && <span className="project-document-status" role="status">{status}</span>}
      </header>
      {error && <div className="project-document-notice" role="alert">
        Could not refresh. Showing the last loaded document. <button className="btn btn--ghost btn--sm" onClick={refresh}>Retry</button>
      </div>}
      <section className="project-document-section">
        <h3>Introduction</h3>
        {project.summary ? <MarkdownView text={project.summary} />
          : <p className="muted">No Introduction yet. Write one here or develop it with an agent.</p>}
        <ProjectIntentEditor key={project.id} project={project} />
      </section>
      <details className="project-document-section" open>
        <summary>Literature</summary>
        {project.literature?.body || project.literature?.tldr
          ? <MarkdownView text={project.literature.body || project.literature.tldr} />
          : <p className="muted">No literature summary yet.</p>}
        <Link to={px('/litreview')}>Read literature and citations →</Link>
      </details>
      <div className="project-document-note">
        <strong>Agent-authored research</strong>
        <p>{hasNarrative ? 'Methods and Results are the latest published synthesis. Findings, limitations and provisional work are described in the authors’ own words.' : 'Agents maintain Methods and Results as research progresses. No narrative has been published yet.'}</p>
        {maintenance?.pending && <p role="status">Newer changes have not yet been incorporated. The last publication remains visible until an agent publishes an update.</p>}
        {hasNarrative && !maintenance && <p>Document maintenance status is unavailable.</p>}
      </div>
      {['methods', 'results'].map(section => <details key={section} className="project-document-section" open>
        <summary>{section === 'methods' ? 'Methods' : 'Results'}</summary>
        {project[section] ? <MarkdownView text={project[section]} resolveImageSrc={resolveFigure} artifactFigures experimentCards={section === 'methods'} />
          : <p className="muted">No {section} published yet.</p>}

      </details>)}
      <details className="project-document-section" open>
        <summary>Selected evidence <span className="muted">({project.references?.length || 0})</span></summary>
        <p className="muted">Statuses below reflect current workflow progress, not scientific success. They may be newer than the published narrative.</p>
        {project.references?.length ? <ul className="project-document-references">
          {project.references.map(ref => {
            const route = entityRoute(ref.kind, ref.id);
            return <li key={`${ref.kind}:${ref.id}`}>
              <div>{route && ref.status !== 'unavailable'
                ? <Link to={px(route)}>{ref.label || ref.id}</Link>
                : <span>{ref.label || ref.id}</span>}
                <div className="muted">{ref.kind} · {ref.id}</div>
              </div>
              {ref.status && <span className="project-evidence-status">{ref.status.replace(/_/g, ' ')}</span>}
            </li>;
          })}
        </ul> : <p className="muted">No selected evidence yet.</p>}
      </details>
    </section>
  );
}
