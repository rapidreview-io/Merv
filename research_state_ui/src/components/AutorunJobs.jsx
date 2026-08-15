import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectPath } from '../store/useProjectStore';
import TracePeek from './TracePeek';
import { runnerPresentation } from './runnerPresentation';
import {
  assignmentFor,
  formatTokens,
  isLiveSession,
  sessionAgent,
  sessionDestination,
  sessionDurationMs,
  sessionOutcome,
} from './agentSessionPresentation';
import { fmtDayTime, fmtDuration } from '../utils/format';
import { worktreeLineage } from './autorunWorktree';

/**
 * AutorunJobs — the jobs console: what agents are doing or did.
 *
 * One row per brain session; the twist opens the trace drawer (the page's
 * instrument) with the one action a running job has — Stop. Title navigates
 * to the record it belongs to via the trailing link, the way Sandboxes rows
 * do. Waiting rows (the brain's dispatch queue, when it reports one) sit in
 * Active with the reason in words and no dot: nothing is alive yet.
 *
 * When the runner reported a worktree for a job, the drawer names it —
 * branch, base → head, path on the machine — and lists the other jobs that
 * worked in the same one: that is what continuity looks like (agents picking
 * up each other's work) versus separate things. Optional by construction:
 * jobs without a worktree simply do not carry the line.
 */

export function jobBucket(session) {
  if (isLiveSession(session)) return 'active';
  return sessionOutcome(session).tone === 'error' ? 'failed' : 'done';
}

const DOT_BY_TONE = {
  live: 'running',
  starting: 'starting',
  complete: 'done',
  quiet: 'quiet',
  error: 'failed',
};

function closedAt(session) {
  return Date.parse(session?.closed_at || session?.last_activity_at || session?.created_at || '') || 0;
}

function waitingReason({ dispatch, runners, running, now }) {
  if (dispatch === null) return 'checking dispatch…';
  if (dispatch === false) return 'dispatch is off';
  const live = runners.filter((runner) => runnerPresentation(runner, now).live);
  if (live.length === 0) return 'no live machine';
  const capacity = live.reduce((total, runner) => total + (Number(runner.capacity) || 0), 0);
  if (capacity === 0) return 'no agent enabled';
  if (running >= capacity) return 'no free slot';
  return 'starting soon';
}

export default function AutorunJobs({ projectId, sessions, queue, queueTotal = null, workspaces = {}, tab, now, dispatch, runners, onStop }) {
  const [expanded, setExpanded] = useState('');
  const [stopping, setStopping] = useState('');
  const [stopError, setStopError] = useState({ id: '', message: '' });

  const rows = useMemo(() => {
    const all = (sessions || []).slice().sort((a, b) => {
      const al = isLiveSession(a) ? 0 : 1;
      const bl = isLiveSession(b) ? 0 : 1;
      if (al !== bl) return al - bl;
      if (al === 0) {
        return String(b.activated_at || b.created_at || '').localeCompare(String(a.activated_at || a.created_at || ''));
      }
      return closedAt(b) - closedAt(a);
    });
    if (tab === 'all') return all;
    return all.filter((session) => jobBucket(session) === tab);
  }, [sessions, tab]);

  const running = (sessions || []).filter(isLiveSession).length;
  const waiting = tab === 'active' || tab === 'all' ? (queue || []) : [];
  const reason = waiting.length ? waitingReason({ dispatch, runners, running, now }) : '';

  async function stop(sessionId) {
    setStopping(sessionId);
    setStopError({ id: '', message: '' });
    try {
      await onStop(sessionId);
    } catch (err) {
      setStopError({ id: sessionId, message: err?.message || 'Could not stop that job.' });
    } finally {
      setStopping('');
    }
  }

  if (rows.length === 0 && waiting.length === 0) {
    return (
      <div className="empty-state empty-state--compact arun-jobs-empty">
        <h2>{tab === 'all' ? 'No jobs yet' : `No ${tab} jobs`}</h2>
        {tab === 'all' && <p>Jobs appear here as soon as a live machine picks up work.</p>}
      </div>
    );
  }

  return (
    <div className="arj-scroll">
      <div className="arj" role="table" aria-label="Jobs">
        <div className="arj-head con-head" role="row">
          <span aria-hidden="true" />
          <span className="th th--con">Status</span>
          <span className="th th--con">Work</span>
          <span className="th th--con">Agent</span>
          <span className="th th--con">Machine</span>
          <span className="th th--con">Started</span>
          <span className="th th--con th--r">Elapsed</span>
          <span className="th th--con th--r" aria-label="Links" />
        </div>
        {rows.map((session) => (
          <JobRow
            key={session.id}
            session={session}
            projectId={projectId}
            lineage={worktreeLineage(session, sessions)}
            workspace={session.experiment_id ? workspaces[session.experiment_id] : null}
            now={now}
            open={expanded === session.id}
            onToggle={() => setExpanded(expanded === session.id ? '' : session.id)}
            onStop={() => stop(session.id)}
            stopping={stopping === session.id}
            stopError={stopError.id === session.id ? stopError.message : ''}
          />
        ))}
        {waiting.map((item) => (
          <WaitingRow key={`${item.kind}:${item.target_id}:${item.review_request_id || ''}`} item={item} reason={reason} projectId={projectId} />
        ))}
        {waiting.length > 0 && queueTotal > waiting.length && (
          <div className="arj-more">
            {queueTotal - waiting.length} more waiting — the list shows the next {waiting.length}.
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ session, projectId, lineage, workspace, now, open, onToggle, onStop, stopping, stopError }) {
  const assignment = assignmentFor(session);
  const outcome = sessionOutcome(session);
  const live = isLiveSession(session);
  const destination = sessionDestination(projectId, session);
  const started = fmtDayTime(session.activated_at || session.created_at);
  const attempt = Number(assignment?.packet?.attempt || session.attempt_index || 0);
  const tokens = formatTokens(session?.telemetry?.total_tokens);
  const tools = Number(session?.telemetry?.tool_calls || 0);
  const machine = session?.agent_setup?.machine || '';
  const rail = outcome.tone === 'error' ? ' arj-rowgroup--failed' : '';

  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <div className={`arj-rowgroup${open ? ' open' : ''}${rail}`}>
      <div
        className="arj-rowhead"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKey}
      >
        <div className="arj-row" role="row">
          <span className={`twist${open ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span className="arj-status">
            <span className={`arj-dot arj-dot--${DOT_BY_TONE[outcome.tone] || 'quiet'}`} />
            <span className="arj-status-label">{outcome.label}</span>
          </span>
          <span className="arj-work">
            <span className="arj-work-title">{assignment.subtitle || assignment.title || 'Agent task'}</span>
            <span className="arj-work-kind">
              {assignment.title || 'Agent task'}
              {attempt > 0 && ` · attempt ${attempt}`}
              {lineage.before.length > 0 && (
                <span className="arj-continues" title={`Continues ${lineage.before.length} earlier ${lineage.before.length === 1 ? 'job' : 'jobs'} in the same worktree`}>
                  {` · continues ${lineage.before.length}`}
                </span>
              )}
            </span>
          </span>
          <span className="arj-agent" title={sessionAgent(session)}>{sessionAgent(session)}</span>
          <span className="arj-machine" title={machine}>{machine || '—'}</span>
          <span className="arj-when">
            {started ? (
              <>
                <span className="arj-when-day">{started.day}</span>
                <span className="arj-when-time">{started.time}</span>
              </>
            ) : '—'}
          </span>
          <span className={`arj-num${live ? ' arj-num--live' : ''}`}>
            {fmtDuration(sessionDurationMs(session, now))}
          </span>
          <span className="arj-links" onClick={(e) => e.stopPropagation()}>
            {destination && <Link to={destination.to} className="arj-link">open ↗</Link>}
          </span>
        </div>
      </div>
      {open && (
        <div className="arj-drawer">
          {lineage.branch && (
            <WorktreeLine session={session} lineage={lineage} workspace={workspace} machine={machine} now={now} />
          )}
          <TracePeek projectId={projectId} sessionId={session.id} live={live} machine={machine} />
          <div className="arj-drawer-foot">
            <span className="arj-drawer-facts">
              {sessionAgent(session)}
              {tokens && ` · ${tokens} tokens`}
              {tools > 0 && ` · ${tools} ${tools === 1 ? 'tool call' : 'tool calls'}`}
              {machine && ` · on ${machine}`}
              {!live && session.close_reason && ` · ${String(session.close_reason).replace(/_/g, ' ')}`}
            </span>
            <span className="arj-drawer-actions">
              {stopError && <span className="arj-stop-error" role="alert">{stopError}</span>}
              {live && (
                <button type="button" className="btn btn--ghost btn--sm" disabled={stopping} onClick={onStop}>
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingRow({ item, reason, projectId }) {
  const kind = item.kind === 'review'
    ? 'Review'
    : item.kind === 'consolidation' ? 'Consolidate' : 'Run experiment';
  const to = projectPath(
    projectId,
    item.target_type === 'reflection' ? `/reflection/${item.target_id}` : `/experiments/${item.target_id}`,
  );
  return (
    <div className="arj-rowgroup arj-rowgroup--waiting">
      <div className="arj-row arj-row--waiting" role="row">
        <span aria-hidden="true" />
        <span className="arj-status">
          <span className="arj-dot arj-dot--waiting" />
          <span className="arj-status-label">Waiting</span>
        </span>
        <span className="arj-work">
          <span className="arj-work-title">{item.title || item.target_id}</span>
          <span className="arj-work-kind">{kind}{item.status ? ` · ${String(item.status).replace(/_/g, ' ')}` : ''}</span>
        </span>
        <span className="arj-agent arj-waiting-reason">{reason}</span>
        <span className="arj-machine">—</span>
        <span className="arj-when">—</span>
        <span className="arj-num">—</span>
        <span className="arj-links">
          <Link to={to} className="arj-link">open ↗</Link>
        </span>
      </div>
    </div>
  );
}

function shortSha(value) {
  return String(value || '').slice(0, 7);
}

/**
 * One line naming the worktree, then who else worked in it. Rendered only when
 * the runner reported a branch for this job.
 */
function WorktreeLine({ session, lineage, workspace, machine, now }) {
  const base = shortSha(session.base_sha);
  const head = shortSha(workspace?.head_sha || session.head_sha);
  const path = session?.agent_setup?.workspace_path || '';
  const commits = Number(workspace?.commit_count || 0);
  const files = Number(workspace?.files_changed || 0);
  const others = [...lineage.before, ...lineage.after];
  return (
    <div className="arj-worktree" aria-label="Worktree">
      <div className="arj-worktree-line">
        <span className="arj-worktree-glyph" aria-hidden="true">⎇</span>
        <code className="mono arj-worktree-branch" title={lineage.branch}>{lineage.branch}</code>
        {base && (
          <span className="arj-worktree-shas mono">
            {base}{head && head !== base ? ` → ${head}` : ''}
          </span>
        )}
        {(commits > 0 || files > 0) && (
          <span className="arj-worktree-stats">
            {commits > 0 && `${commits} ${commits === 1 ? 'commit' : 'commits'}`}
            {commits > 0 && files > 0 && ' · '}
            {files > 0 && `${files} ${files === 1 ? 'file' : 'files'}`}
            {(Number(workspace?.insertions) || Number(workspace?.deletions)) ? ` (+${Number(workspace?.insertions) || 0} −${Number(workspace?.deletions) || 0})` : ''}
          </span>
        )}
        {path && (
          <code className="mono arj-worktree-path" title={path}>{path}{machine ? ` on ${machine}` : ''}</code>
        )}
      </div>
      {others.length > 0 && (
        <div className="arj-worktree-others">
          {lineage.before.length > 0
            ? `Continues ${lineage.before.length === 1 ? 'the work of' : `${lineage.before.length} earlier jobs:`} `
            : 'Also worked here: '}
          {[...lineage.before].reverse().slice(0, 4).map((other) => (
            <span key={other.id} className="arj-worktree-other" title={sessionAgent(other)}>
              {String(other?.agent_setup?.platform || other?.platform || 'agent')}
              {' · '}{fmtDayTime(other.activated_at || other.created_at)?.day || ''}
              {' · '}{sessionOutcome(other).label}
            </span>
          ))}
          {lineage.before.length > 4 && <span className="arj-worktree-other">{lineage.before.length - 4} more</span>}
          {lineage.after.length > 0 && (
            <span className="arj-worktree-after">
              {`${lineage.after.length} later ${lineage.after.length === 1 ? 'job continued' : 'jobs continued'} from here`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
