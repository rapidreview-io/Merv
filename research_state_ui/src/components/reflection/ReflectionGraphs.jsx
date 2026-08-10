import { useCallback, useEffect, useState } from 'react';
import LogicGraph from '../LogicGraph';
import WaveFigure from './WaveFigure';

/**
 * ReflectionGraphs — one canvas slot, two graphs, exactly like the
 * experiment page: the derived PROCESS graph (the wave's attempt story) and
 * the agent-authored LOGIC graph (the project's belief state this wave
 * published). The section title is the toggle; both stay mounted so each
 * keeps its polling and reports availability; an empty graph's tab disables
 * and the other view shows instead.
 */
export default function ReflectionGraphs({ projectId, reflectionId, wave, isOpen, fetcher }) {
  const [chosen, setChosen] = useState('process');
  const [avail, setAvail] = useState({ process: false, logic: false });
  const [expanded, setExpanded] = useState(false);
  const toggleExpand = useCallback(() => setExpanded(v => !v), []);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = e => { if (e.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  const report = useCallback((key, value) => {
    setAvail(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const reportProcess = useCallback(v => report('process', v), [report]);
  const reportLogic = useCallback(v => report('logic', v), [report]);

  const view = avail[chosen]
    ? chosen
    : (chosen === 'process' ? (avail.logic ? 'logic' : null) : (avail.process ? 'process' : null));

  const titleTabs = (
    <span className="fig-title-tabs" role="tablist" aria-label="Graph view">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'process'}
        className={`fig-title-tab${view === 'process' ? ' fig-title-tab--on' : ''}`}
        disabled={!avail.process}
        onClick={() => setChosen('process')}
      >
        Process
      </button>
      <span className="fig-title-tab-sep" aria-hidden="true">/</span>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'logic'}
        className={`fig-title-tab${view === 'logic' ? ' fig-title-tab--on' : ''}`}
        disabled={!avail.logic}
        onClick={() => setChosen('logic')}
      >
        Logic
      </button>
    </span>
  );

  const shared = { titleTabs, expanded, onToggleExpand: toggleExpand };
  return (
    <>
      {expanded && (
        <div className="fig-backdrop" onClick={() => setExpanded(false)} aria-hidden="true" />
      )}
      <WaveFigure
        {...shared}
        wave={wave}
        active={view === 'process'}
        onAvailability={reportProcess}
      />
      <LogicGraph
        {...shared}
        key={`logic-${reflectionId}`}
        projectId={projectId}
        fetcher={fetcher}
        live={isOpen}
        attemptIndex={wave?.attempt_index}
        active={view === 'logic'}
        onAvailability={reportLogic}
        readableFit
      />
    </>
  );
}
