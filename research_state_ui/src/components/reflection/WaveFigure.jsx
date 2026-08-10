import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MeasureSync } from '../ExperimentFigure';
import DetailPanelShell from '../DetailPanelShell';
import StatusPill from '../StatusPill';
import { layoutFigure, FIG_NODE_W } from '../../utils/figureLayout';
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

function WaveFigNode({ data }) {
  return (
    <div
      className={[
        'fig-node',
        `fig-node--${data.type}`,
        `fig-st--${data.statusClass}`,
        data.selected ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ width: FIG_NODE_W }}
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

function toFlow(figure, selectedId) {
  const laid = layoutFigure(figure);
  const liveIds = new Set(laid.nodes.filter(n => statusClass(n) === 'open').map(n => n.id));
  const nodes = laid.nodes.map(n => ({
    id: n.id,
    type: 'wavefig',
    position: { x: n.x, y: n.y },
    data: { ...n, statusClass: statusClass(n), selected: n.id === selectedId },
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
  const { width: panelWidth, startResize } = usePanelWidth();

  const { nodes, edges } = useMemo(() => toFlow(figure, selectedId), [figure, selectedId]);
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);

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
    const xs = nodes.map(n => n.position.x);
    const ys = nodes.map(n => n.position.y);
    if (!xs.length) return;
    const cw = canvasRef.current?.clientWidth || 1000;
    const ch = canvasRef.current?.clientHeight || 400;
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const gW = Math.max(1, Math.max(...xs) + FIG_NODE_W - minX);
    const gH = Math.max(1, Math.max(...ys) + 72 - minY);
    const pad = 28;
    const zoom = Math.min(1, Math.max(0.8, Math.max((cw - pad * 2) / gW, (ch - pad * 2) / gH)));
    inst.setViewport(
      { x: pad - minX * zoom, y: (ch - gH * zoom) / 2 - minY * zoom, zoom },
      { duration: document.hidden ? 0 : 200 },
    );
  }, [expanded, nodes]);
  useEffect(() => {
    const t = setTimeout(applyView, 350);
    return () => clearTimeout(t);
  }, [topologyKey, applyView]);
  useEffect(() => {
    const t = setTimeout(applyView, 120);
    return () => clearTimeout(t);
  }, [expanded, applyView]);

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
          <div className="fig-legend">
            <span className="fig-chip fig-st--done">done</span>
            <span className="fig-chip fig-st--open">in motion</span>
            <span className="fig-chip fig-st--revise">needs changes</span>
            <span className="fig-chip fig-st--faded">superseded</span>
          </div>
          {onToggleExpand && (
            <button
              type="button"
              className="fig-expand-btn"
              onClick={onToggleExpand}
              aria-label={expanded ? 'Collapse graph' : 'Expand graph'}
            >
              {expanded ? '✕ Close' : '⤢ Expand'}
            </button>
          )}
        </div>
      </div>
      <div
        className={`fig-body${selected ? ' fig-body--split' : ''}`}
        style={{ '--fig-panel-w': `${panelWidth}px` }}
      >
        <div className="fig-canvas" ref={canvasRef}>
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
          <div className="fig-canvas-hint">drag to pan · pinch to zoom</div>
        </div>
        {selected && (
          <div
            className="fig-resizer"
            onPointerDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize panel"
          />
        )}
        {selected && (
          <DetailPanelShell
            typeLabel={selected.type.replace(/_/g, ' ')}
            title={selected.label}
            onClose={() => setSelectedId(null)}
          >
            {selected.status && (
              <div style={{ margin: '6px 0' }}><StatusPill value={String(selected.status)} /></div>
            )}
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
