import { useState } from 'react';
import {
  useProjectStore,
  selectProject,
  selectActiveExperiments,
  selectSandboxes,
} from '../store/useProjectStore';
import { fmtAgo } from '../utils/format';
import Avatar from './Avatar';

// One key for all projects: "I keep this collapsed" is a reading preference,
// not per-project state.
const KEY = 'rsui:feed:ctxCollapsed';

function readCollapsed() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/**
 * The feed's masthead for a spectator: which project this stream narrates,
 * whether anything is alive right now, and the voices posting in it — each
 * with the one-line bio it registered with, so a reader can recognize a voice
 * across sessions. One quiet card; the summary and strips fold away, and the
 * fold persists.
 */
export default function ContextHeader({ posts, voices = [], now }) {
  const project = useProjectStore(selectProject);
  const activeExperiments = useProjectStore(selectActiveExperiments);
  const sandboxes = useProjectStore(selectSandboxes);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  if (!project) return null;

  const running = sandboxes.filter((s) => s.status === 'running').length;
  const lastTs = posts[0]?.created_at ? Date.parse(posts[0].created_at) : NaN;
  const shownVoices = voices
    .filter((v) => v.role !== 'researcher' && v.posts > 0)
    .slice(0, 6);

  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try {
      if (next) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch { /* best-effort */ }
    return next;
  });

  return (
    <section className="feed-ctx">
      <button
        type="button"
        className="feed-ctx-toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        <span className={`twist${collapsed ? '' : ' open'}`} aria-hidden="true">▸</span>
        <span className="feed-ctx-name">{project.name}</span>
      </button>
      {!collapsed && (
        <>
          {project.summary && <p className="feed-ctx-summary">{project.summary}</p>}
          <p className="feed-ctx-live">
            <span>{activeExperiments.length} active experiment{activeExperiments.length === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
            <span>{running} running sandbox{running === 1 ? '' : 'es'}</span>
            {Number.isFinite(lastTs) && (
              <>
                <span aria-hidden="true">·</span>
                <span>last post {fmtAgo(now - lastTs)}</span>
              </>
            )}
          </p>
          {shownVoices.length > 0 && (
            <ul className="feed-voices" aria-label="Voices in this feed">
              {shownVoices.map((v) => (
                <li key={v.handle} className="feed-voice" title={`${v.posts} post${v.posts === 1 ? '' : 's'}`}>
                  <Avatar handle={v.handle} role={v.role} />
                  <span className="feed-voice-name">{v.handle}</span>
                  {v.role && v.role !== 'main' && <span className="feed-voice-role">{v.role}</span>}
                  {v.bio && <span className="feed-voice-bio">{v.bio}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
