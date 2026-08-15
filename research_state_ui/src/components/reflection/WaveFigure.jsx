import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MeasureSync } from '../ExperimentFigure';
import DetailPanelShell, { PanelResizer } from '../DetailPanelShell';
import GraphExpandButton from '../GraphExpandButton';
import StatusPill from '../StatusPill';
import { layoutFigure, FIG_NODE_W } from '../../utils/figureLayout';
import { readableViewport, visibleWidth } from '../../utils/graphCamera';
import { motionMs } from '../../utils/motion';
import { usePanelWidth } from '../../store/usePanelWidth';
import { buildWaveFigure } from './waveModel.js';

/**
 * WaveFigure — the wave's PROCESS graph, the reflection sibling of
 * ExperimentFigure: the attempt spine with its revision loops, lens fan-in,
 * synthesis, review verdict, consolidation, publication. Derived client-side
 * (buildWaveFigure) from the wave payload the /reflections poll already
 * carries — no extra endpoint. Same canvas conventions as the figure:
 * layoutFigure, MeasureSync, JSON-keyed identity, click-to-open panel.
 */

const GLYPH = {
  attempt: '◇', review: '☑', submission: '▣',
  artifact_group: '▣', consolidation: '▦', conclusion: '∴',
};

// Same normalization as the experiment figure, for the subset of statuses a
// wave process graph produces.
function statusClass(node) {
  const s = String(node.status || '');
  if (node.type === 'review') {
    return { pass: 'done', needs_changes: 'revise', fail: 'failed', open: 'open' }[s] || 'neutral';
  }
  if (node.type === 'submission') {
    return { open: 'open', done: 'done' }[s] || 'done';
  }
  return {
    active: 'open', done: 'done', failed: 'failed',
    superseded: 'faded', abandoned: 'faded',
  }[s] || 'neutral';
}

/**
 * Selection reaches the nodes through context, not node data: threading it
 * through toFlow rebuilt every node object on every click, which wipes
 * react-flow's measured handle bounds and silently drops the edges. The
 * selecting callback rides along because react-flow's own Enter/Space handler
 * talks to its internal store and never calls our onNodeClick.
 */
const WaveFigCtx = createContext({ selectedId: null, select: () => {} });

function WaveFigNode({ data }) {
  const { selectedId, select } = useContext(WaveFigCtx);
  return (
    <div
      className={[
        'fig-node',
        `fig-node--${data.type}`,
        `fig-st--${data.statusClass}`,
        selectedId === data.id ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ width: FIG_NODE_W }}
      role="button"
      tabIndex={0}
      aria-label={`${data.label} — ${String(data.status || data.type).replace(/_/g, ' ')}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(data.id); }
      }}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">{GLYPH[data.type] || '•'}</span>
        <span className="fig-node-type">{data.type.replace(/_/g, ' ')}</span>
        {data.statusClass === 'open' && <span className="fig-node-live" aria-hidden="true" />}
      </div>
      <div className="fig-node-label" title={data.label}>{data.label}</div>
      {data.sublabel ? <div className="fig-node-sub" title={data.sublabel}>{data.sublabel}</div> : null}
      <Handle type="source" position={Position.Right} className="fig-handle" />
    </div>
  );
}

const nodeTypes = { wavefig: WaveFigNode };

function toFlow(figure) {
  const laid = layoutFigure(figure);
  const liveIds = new Set(laid.nodes.filter(n => statusClass(n) === 'open').map(n => n.id));
  const nodes = laid.nodes.map(n => ({
    id: n.id,
    type: 'wavefig',
    position: { x: n.x, y: n.y },
    data: { ...n, statusClass: statusClass(n) },
    draggable: false,
    connectable: false,
  }));
  const edges = laid.edges.map(e => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: 'smoothstep',
    className: `fig-edge fig-edge--${e.type}`,
    animated: liveIds.has(e.from) || liveIds.has(e.to),
    markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
  }));
  return { nodes, edges };
}

export default function WaveFigure({
  wave, active = true, titleTabs = null, onAvailability = null,
  expanded = false, onToggleExpand = null,
}) {
  // JSON identity discipline: unchanged polls must not recreate node objects
  // (react-flow keys measurements to identity — the Figure gotcha).
  const figureJson = useMemo(() => JSON.stringify(buildWaveFigure(wave)), [wave]);
  const figure = useMemo(() => JSON.parse(figureJson), [figureJson]);
  const [selectedId, setSelectedId] = useState(null);
  const rfRef = useRef(null);
  const { width: panelWidth } = usePanelWidth();

  const { nodes, edges } = useMemo(() => toFlow(figure), [figure]);
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);
  const select = useCallback((id) => setSelectedId(id), []);
  const waveFigCtx = useMemo(() => ({ selectedId, select }), [selectedId, select]);

  // The process spine is a wide flat ribbon; fitting it to WIDTH crushes the
  // zoom (the LogicGraph readableFit problem). Inline: fill the height up to
  // 1x, never below a legible floor, anchor the start at the left. Expanded
  // has room, so it keeps plain fit-everything.
  const canvasRef = useRef(null);
  const applyView = useCallback(() => {
    const inst = rfRef.current;
    if (!inst) return;
    if (expanded) {
      inst.fitView({ padding: 0.18, maxZoom: 1.6 });
      return;
    }
    const vp = readableViewport({
      xs: nodes.map(n => n.position.x),
      ys: nodes.map(n => n.position.y),
      nodeW: FIG_NODE_W,
      cw: visibleWidth(canvasRef.current),
      ch: canvasRef.current?.clientHeight || 400,
    });
    if (vp) inst.setViewport(vp, { duration: motionMs(200) });
  }, [expanded, nodes]);
  useEffect(() => {
    const t = setTimeout(applyView, 350);
    return () => clearTimeout(t);
  }, [topologyKey, applyView]);
  useEffect(() => {
    const t = setTimeout(applyView, 120);
    return () => clearTimeout(t);
  }, [expanded, applyView]);

  // Escape closes the sidebar first; the graph slot's handler then gets the
  // next Escape to leave fullscreen.
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId]);

  const selected = useMemo(
    () => figure.nodes.find(n => n.id === selectedId) || null,
    [figure, selectedId],
  );

  const available = figure.nodes.length >= 2;
  useEffect(() => { onAvailability?.(available); }, [available, onAvailability]);
  if (!available || !active) return null;

  return (
    <section className={`exp-figure${expanded ? ' exp-figure--expanded' : ''}`} id="wave-figure">
      <div className="fig-head">
        <div className="fig-title">
          {titleTabs || 'Process'}
          <span className="fig-title-hint">derived from wave state</span>
        </div>
        <div className="fig-head-right">
          <div className="fig-legend" aria-hidden="true">
            <span className="fig-chip fig-st--done">done</span>
            <span className="fig-chip fig-st--open">in motion</span>
            <span className="fig-chip fig-st--revise">needs changes</span>
            <span className="fig-chip fig-st--faded">superseded</span>
          </div>
          <GraphExpandButton expanded={expanded} onToggle={onToggleExpand} label="process graph" />
        </div>
      </div>
      <div
        className="fig-body"
        style={{ '--fig-panel-w': `${panelWidth}px` }}
      >
        <div className="fig-canvas" ref={canvasRef}>
          <WaveFigCtx.Provider value={waveFigCtx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={inst => { rfRef.current = inst; }}
            onNodeClick={(event, node) => {
              event.stopPropagation();
              setSelectedId(node.id);
            }}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            elementsSelectable={false}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
            zoomOnScroll={expanded}
            zoomOnPinch
            preventScrolling={expanded}
            minZoom={0.3}
            maxZoom={1.6}
          >
            <MeasureSync topologyKey={topologyKey} />
            <Background gap={22} size={1.1} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
          </WaveFigCtx.Provider>
          <div className="fig-canvas-hint" aria-hidden="true">drag to pan · pinch to zoom</div>
        </div>
        {selected && <PanelResizer />}
        {selected && (
          <DetailPanelShell
            typeLabel={selected.type.replace(/_/g, ' ')}
            title={selected.label}
            status={selected.status ? <StatusPill value={String(selected.status)} /> : null}
            onClose={() => setSelectedId(null)}
          >
            {selected.sublabel && <div className="fig-panel-notes">{selected.sublabel}</div>}
            {selected.type === 'review' && selected.status === 'needs_changes' && !selected.sublabel && (
              <div className="fig-panel-meta">Rejected this attempt; the revision reason was not recorded.</div>
            )}
          </DetailPanelShell>
        )}
      </div>
    </section>
  );
}
