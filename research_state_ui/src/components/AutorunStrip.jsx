import { Link } from 'react-router-dom';
import { useProjectHref } from '../store/useProjectStore';
import { useAutorunStatus } from '../store/useAutorunStatus';

/**
 * AutorunStrip — one line on Home saying what auto-run is doing right now.
 *
 * Shown only once auto-run is a thing for this project (a runner has ever
 * paired, or dispatch is on). Reads the shared ambient status and links to
 * the Auto-run page. Same light grammar as the sidebar and Sandboxes: the
 * pulsing dot only while a job is running; otherwise the words carry it.
 */
export default function AutorunStrip({ project }) {
  const px = useProjectHref();
  const status = useAutorunStatus(project?.id);
  const dispatch = Boolean(project?.settings?.agent_dispatch);
  if (!status.known || (status.runnerCount === 0 && !dispatch)) return null;

  let detail;
  if (status.running > 0) {
    detail = `${status.running} ${status.running === 1 ? 'job' : 'jobs'} running on ${status.machineName}`;
  } else if (status.liveRunnerCount > 0) {
    detail = dispatch
      ? `${status.machineName} is live and waiting for work · ${status.capacity} ${status.capacity === 1 ? 'slot' : 'slots'}`
      : `${status.machineName} is live · dispatch is off`;
  } else if (status.runnerCount > 0) {
    detail = `${status.machineName} is ${status.state.toLowerCase()}`;
  } else {
    detail = 'Dispatch is on but no runner is paired';
  }

  return (
    <Link to={px('/auto-run')} className="autorun-strip" aria-label="Auto-run status">
      {status.running > 0 && <span className="sidebar-live-dot" aria-hidden="true" />}
      <span className="autorun-strip-title">Auto-run</span>
      <span className="autorun-strip-detail">{detail}</span>
      <span className="autorun-strip-open">Open →</span>
    </Link>
  );
}
