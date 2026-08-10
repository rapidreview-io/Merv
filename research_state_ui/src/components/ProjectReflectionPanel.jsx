import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useProjectStore, useProjectHref, selectExperiments, selectProject } from '../store/useProjectStore';
import WaveFlow from './reflection/WaveFlow';

/**
 * ProjectReflectionPanel — Home's project graph. Just the graph: reflection
 * waves as the narrow waists of the stream, experiments fanning between them,
 * project creation as the origin every braid grows from. Node details live in
 * the graph's own drawer; a wave's Open button deep-links to its page
 * (/reflection/<id>), the ghost's to the reflection list.
 */
export default function ProjectReflectionPanel({ projectId }) {
  const [data, setData] = useState(null);
  const navigate = useNavigate();
  const px = useProjectHref();
  const experiments = useProjectStore(selectExperiments);
  const project = useProjectStore(selectProject);

  const fetchReflections = useCallback(async () => {
    try {
      const payload = await api.getReflections(projectId);
      setData(prev => (JSON.stringify(prev) === JSON.stringify(payload) ? prev : payload));
    } catch {
      // Non-fatal: Home still works without the panel's metadata.
    }
  }, [projectId]);

  useEffect(() => {
    fetchReflections();
    const t = setInterval(fetchReflections, 8000);
    return () => clearInterval(t);
  }, [fetchReflections]);

  const waves = data?.reflections || [];
  const signal = data?.signal || null;

  // A wave's Open button lands on its page; the ghost (no wave yet) lands on
  // the list.
  const onSelectWave = useCallback((id) => {
    navigate(px(id ? `/reflection/${id}` : '/reflection'));
  }, [navigate, px]);

  return (
    <section className="section" id="project-reflection">
      <WaveFlow
        waves={waves}
        experiments={experiments}
        signal={signal}
        project={project}
        onSelect={onSelectWave}
        height="clamp(520px, 62vh, 760px)"
      />
    </section>
  );
}
