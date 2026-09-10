import { Link } from 'react-router-dom';
import { useProjectStore, projectPath } from '../store/useProjectStore';
import ObjId from './ObjId';
import EntityChip from './EntityChip';
import { entityRoute, entityType } from '../utils/entityResolve';
import { PARACHUTE_CHIPS } from '../utils/parachute';

function shortTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + ' · ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return iso; }
}

/**
 * Routes an event's target_id to the right detail page. Returns null when
 * we don't have a navigable destination (renders as plain text instead).
 * `project` is the one target that isn't inside a project.
 */
function targetHref(targetType, targetId) {
  if (targetType === 'project') return '/projects';
  const route = entityRoute(targetType, targetId);
  return route ? projectPath(useProjectStore.getState().projectId, route) : null;
}

export default function EventTimeline({ events, limit = 20 }) {
  const rows = (events || []).slice(0, limit);
  if (rows.length === 0) {
    return <div className="empty">No events yet.</div>;
  }
  return (
    <div className="timeline">
      {rows.map((e, i) => {
        const type = e.event_type || e.type;
        const chip = PARACHUTE_CHIPS[type];
        // Research-entity targets become chips (name + hover detail); non-entity
        // targets (project, sandbox) keep the plain id + route.
        const href = targetHref(e.target_type, e.target_id);
        return (
          <div key={e.id || i} className="timeline-row">
            <div className="timeline-time">{shortTime(e.created_at)}</div>
            <div className="timeline-event">
              <span className="timeline-event-type">{type}</span>
              {chip && <span className={`parachute-chip parachute-chip--${chip.variant}`}>{chip.label}</span>}
              {e.target_id && (
                entityType(e.target_id)
                  ? <EntityChip id={e.target_id} compact />
                  : (href
                      ? <Link to={href}><ObjId id={e.target_id} className="timeline-event-target timeline-event-target--link" /></Link>
                      : <ObjId id={e.target_id} className="timeline-event-target" />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
