import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useProjectStore, useProjectHref, selectExperiments, selectProject, selectReflections,
  selectTasks,
} from '../store/useProjectStore';
import WaveFlow from './reflection/WaveFlow';

const NO_WAVES = Object.freeze([]);

/**
 * ProjectReflectionPanel — Home's project graph. Just the graph: reflection
 * waves as the narrow waists of the stream, experiments fanning between them,
 * project creation as the origin every braid grows from. Node details live in
 * the graph's own drawer; a wave's Open button deep-links to its page
 * (/reflection/<id>), the ghost's to the reflection list.
 */
export default function ProjectReflectionPanel({ projectId }) {
  const navigate = useNavigate();
  const px = useProjectHref();
  const experiments = useProjectStore(selectExperiments);
  const tasks = useProjectStore(selectTasks);
  const project = useProjectStore(selectProject);
  // The waves arrive WITH the home snapshot (refreshHome fetches them for a
  // project's first load), so the graph is built from the whole braid on
  // Home's first frame — it used to fetch here, draw the experiments alone,
  // then reflow when the waves landed. From here on this panel only keeps
  // them fresh, at its own slow cadence.
  const data = useProjectStore(selectReflections);
  const refreshReflections = useProjectStore(s => s.refreshReflections);

  useEffect(() => {
    // Insurance only: the snapshot normally hands the slice over settled.
    if (!useProjectStore.getState().reflections) refreshReflections();
    const t = setInterval(refreshReflections, 8000);
    return () => clearInterval(t);
  }, [refreshReflections, projectId]);

  const waves = data?.reflections || NO_WAVES;
  const signal = data?.signal || null;

  // A wave's Open button lands on its page; the ghost (no wave yet) lands on
  // the list.
  const onSelectWave = useCallback((id) => {
    navigate(px(id ? `/reflection/${id}` : '/reflection'));
  }, [navigate, px]);

  // No braid until the waves are known: the experiments alone would draw a
  // different picture that reflows the moment the waves land.
  if (!data) return null;

  return (
    <section className="section" id="project-reflection">
      <WaveFlow
        waves={waves}
        experiments={experiments}
        tasks={tasks}
        signal={signal}
        project={project}
        onSelect={onSelectWave}
        height="clamp(520px, 62vh, 760px)"
      />
    </section>
  );
}
