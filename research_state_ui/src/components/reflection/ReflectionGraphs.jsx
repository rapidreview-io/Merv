import { useCallback, useState } from 'react';
import { GraphTabs, useGraphAvailability, useGraphExpand } from '../GraphExpandButton';
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
  const [avail, report] = useGraphAvailability({ process: false, logic: false });
  const { expanded, toggleExpand, collapse } = useGraphExpand();
  const reportProcess = useCallback(v => report('process', v), [report]);
  const reportLogic = useCallback(v => report('logic', v), [report]);

  const view = avail[chosen]
    ? chosen
    : (chosen === 'process' ? (avail.logic ? 'logic' : null) : (avail.process ? 'process' : null));

  const titleTabs = (
    <GraphTabs
      tabs={[['process', 'Process'], ['logic', 'Logic']]}
      view={view}
      avail={avail}
      onChoose={setChosen}
    />
  );

  const shared = { titleTabs, expanded, onToggleExpand: toggleExpand };
  return (
    <>
      {expanded && (
        <div className="fig-backdrop" onClick={collapse} aria-hidden="true" />
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
