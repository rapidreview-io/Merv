import { Link } from 'react-router-dom';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { expName } from '../utils/experiment';
import StatusPill from './StatusPill';

/** A standalone experiment reference continues the Methods narrative with live state. */
export default function ExperimentCard({ id }) {
  const px = useProjectHref();
  const experiment = useProjectStore(s => s.home?.experiments?.find(e => e.id === id));
  if (!experiment) return <p className="muted">Experiment unavailable: {id}</p>;
  return <Link className="method-experiment-card" to={px(`/experiments/${id}`)}>
    <span className="method-experiment-heading">
      <strong>{expName(experiment)}</strong>
      <StatusPill value={experiment.status} />
    </span>
    {experiment.intent && <span>{experiment.intent}</span>}
    {experiment.attempt_index != null && <span className="muted">Attempt {experiment.attempt_index}</span>}
  </Link>;
}
