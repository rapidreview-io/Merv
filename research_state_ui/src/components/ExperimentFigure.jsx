import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useStoreApi } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import StatusPill from './StatusPill';
import DetailPanelShell, { PanelResizer } from './DetailPanelShell';
import GraphExpandButton from './GraphExpandButton';
import ArtifactContentView from './ArtifactContentView';
import { visibleWidth } from '../utils/graphCamera';
import { layoutFigure, figureBounds, FIG_NODE_W } from '../utils/figureLayout';
import { TERMINAL_STATUSES } from '../utils/experiment';
import { usePanelWidth } from '../store/usePanelWidth';
import { useProjectHref } from '../store/useProjectStore';
import { useStreamAwarePoll } from '../store/useEventStream';

const TYPE_GLYPH = {
  attempt: '◇',
  submission: '▣',
  artifact: '▤',
  artifact_group: '▣',
  review: '☑',
  sandbox: '▶',
  conclusion: '∴',
  claim: '◎',
};

/**
 * Normalize per-type statuses from the figure document into the small set of
 * visual states the CSS knows: done | open | revise | failed | faded | neutral.
 * (`open` = blue/in-motion, `revise` = amber, `faded` = superseded history.)
 */
function statusClass(node) {
  const s = String(node.status || '');
  if (node.type === 'review') {
    return { pass: 'done', needs_changes: 'revise', fail: 'failed', open: 'open' }[s] || 'neutral';
  }
  if (node.type === 'claim') {
    return {
      supported: 'done', weakened: 'revise', contradicted: 'failed',
      active: 'open', draft: 'neutral', abandoned: 'faded',
    }[s] || 'open';
  }
  if (node.type === 'submission') {
    return { open: 'open', done: 'done', returned: 'revise', failed: 'failed' }[s] || 'done';
  }
  return {
    pending: 'neutral', active: 'open', done: 'done', failed: 'failed',
    superseded: 'faded', abandoned: 'faded', none: 'neutral',
  }[s] || 'neutral';
}

// Attachment edges that are shown as placement, not lines: an execution-lane
// file or the sandbox simply sits next to the beat it trails. Evidence edges
// (`feeds`) ARE drawn — files lead into the marker they were submitted with.
const ATTACHMENT_EDGES = new Set(['produced', 'ran_on']);
const ROUND_TYPES = new Set(['attempt', 'submission']);

/**
 * What is drawn. Every arrow is a plain "next": the backbone marker → marker,
 * a round straight down to its verdict, files into the marker they were
 * submitted with, the last round on to the conclusion, and the conclusion to
 * the claims it tests. A verdict's own consequences are not drawn as lines —
 * that it sent the round back is on the round itself (amber, "sent back") and
 * the next round sits to the right — so edges the server states from a review
 * to another round are dropped, and edges from a review to what follows the
 * spine (conclusion, claims) are carried by the round the review hangs under.
 */
function drawnEdges(nodes, edges) {
  const at = new Map(nodes.map(n => [n.id, n]));
  const roundOf = (review) => nodes.find(n => ROUND_TYPES.has(n.type) && n.x === review.x) || null;
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (ATTACHMENT_EDGES.has(e.type)) continue;
    let from = at.get(e.from);
    const to = at.get(e.to);
    if (!from || !to) continue;
    if (from.type === 'review' && to.type !== 'review') {
      if (ROUND_TYPES.has(to.type)) continue;
      from = roundOf(from) || from;
    }
    const key = `${from.id}→${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e, from: from.id, to: to.id, type: e.type === 'revised_to' ? 'then' : e.type, vertical: from.x === to.x });
  }
  return out;
}

// Where the spine passes through every card: a fixed offset from the top, so
// cards of slightly different heights still sit on one straight line.
const HANDLE_TOP = 38;

// Which node's detail is open (and how to open one). Read by the card so it
// can ring itself without recreating node objects (react-flow keys its handle
// measurements to node identity) and without a second, drifting selection
// state in react-flow's own store.
const SelectedContext = createContext(null);

function FigureNode({ data }) {
  const { selectedId, select } = useContext(SelectedContext);
  return (
    <div
      className={[
        'fig-node',
        `fig-node--${data.type}`,
        `fig-st--${data.statusClass}`,
        data.anchor ? 'fig-node--satellite' : '',
        data.current ? 'fig-node--current' : '',
        selectedId === data.id ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      style={{ width: FIG_NODE_W }}
      // react-flow's own Enter/Space handler drives its internal store and
      // never reaches our onNodeClick, so keyboard activation is the card's
      // own business — without this the whole canvas is mouse-only.
      role="button"
      tabIndex={0}
      aria-label={`${data.label} — ${String(data.status || data.type).replace(/_/g, ' ')}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(data.id); }
      }}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" style={{ top: HANDLE_TOP }} />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">{TYPE_GLYPH[data.type] || '•'}</span>
        <span className="fig-node-type">{String(data.type || '').replace(/_/g, ' ')}</span>
        {data.statusClass === 'open' && <span className="fig-node-live" aria-hidden="true" />}
        {/* Which round this node is about ("attempt 2", "round 3.1"): the
            qualifier that keeps three `report.md`s and four `Experiment
            review`s apart without tracing an edge. Markers ARE their round,
            so they carry none. */}
        {data.qualifier && <span className="fig-node-qual">{data.qualifier}</span>}
      </div>
      <div className="fig-node-label" title={data.label}>{data.label}</div>
      {data.sublabel ? <div className="fig-node-sub" title={data.sublabel}>{data.sublabel}</div> : null}
      <Handle type="source" position={Position.Right} className="fig-handle" style={{ top: HANDLE_TOP }} />
      {/* Within-column connectors (a round down to its verdict). Declared
          after the left/right pair: edges that name no handle get the first
          one of their type, so the row handles stay the default. */}
      <Handle type="target" position={Position.Top} id="up" className="fig-handle" />
      <Handle type="source" position={Position.Bottom} id="down" className="fig-handle" />
    </div>
  );
}

const nodeTypes = { figure: FigureNode };

/**
 * Force a node re-measure after mount and on topology changes. Edge rendering
 * depends on measured handle bounds, which react-flow fills in via a
 * ResizeObserver + requestAnimationFrame pipeline — and browsers throttle
 * both to "never" in background tabs and headless previews, leaving every
 * edge silently unrendered. This dashboard is expected to live in background
 * tabs, so re-measure on plain timers (which do fire) by driving the store
 * action directly. Must live inside <ReactFlow> to reach its store context.
 */
export function MeasureSync({ topologyKey }) {
  const store = useStoreApi();
  useEffect(() => {
    const measure = () => {
      const { domNode, updateNodeInternals } = store.getState();
      const updates = new Map();
      domNode?.querySelectorAll('.react-flow__node[data-id]').forEach(el => {
        const id = el.getAttribute('data-id');
        updates.set(id, { id, nodeElement: el, force: true });
      });
      if (updates.size) updateNodeInternals(updates);
    };
    const t1 = setTimeout(measure, 0);
    const t2 = setTimeout(measure, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [topologyKey, store]);
  return null;
}

function toFlow(figure) {
  const laid = layoutFigure(figure, { timeline: true });
  const liveIds = new Set(
    laid.nodes.filter(n => statusClass(n) === 'open').map(n => n.id),
  );
  const nodes = laid.nodes.map(n => ({
    id: n.id,
    type: 'figure',
    position: { x: n.x, y: n.y },
    data: { ...n, statusClass: statusClass(n) },
    draggable: false,
    connectable: false,
  }));
  const edges = drawnEdges(laid.nodes, laid.edges)
    .map(e => ({
      id: `${e.from}→${e.to}`,
      source: e.from,
      target: e.to,
      // Same column: a round straight down to its verdict.
      ...(e.vertical ? { sourceHandle: 'down', targetHandle: 'up' } : {}),
      type: 'smoothstep',
      className: `fig-edge fig-edge--${e.type}`,
      animated: e.type !== 'feeds' && (liveIds.has(e.from) || liveIds.has(e.to)),
      // Evidence arrows are many and quiet; spine arrows are few and loud.
      markerEnd: e.type === 'feeds'
        ? { type: MarkerType.ArrowClosed, width: 10, height: 10 }
        : { type: MarkerType.ArrowClosed, width: 13, height: 13 },
    }));
  // The reader's reference point: the beat the server marks as "now", else
  // the rightmost card on the spine.
  const spine = laid.nodes.filter(n => !n.anchor);
  const current = spine.find(n => n.current)
    || spine.slice().sort((a, b) => b.x - a.x || a.y - b.y)[0]
    || null;
  return { nodes, edges, laid: laid.nodes, backboneY: laid.backboneY, currentId: current ? current.id : null };
}

// Readable framing. Fit everything only when that keeps cards legible;
// otherwise show the timeline at a readable zoom and anchor the view on the
// current beat — near the right edge, so what led up to it fills the canvas.
const FIT_FLOOR = 0.7;
const READABLE_ZOOM = 0.85;
const VIEW_PAD = 28;
const CURRENT_AT = 0.78; // current card's right edge, as a fraction of canvas width
const SPINE_AT = 0.5;    // backbone row, as a fraction of canvas height, when the graph is taller than the canvas

function frameFigure(inst, canvasEl, laid, currentId, { expanded, reserved = 0, backboneY = null }) {
  if (!inst || !laid?.length) return;
  const b = figureBounds(laid);
  // The detail sidebar overlays the canvas rather than shrinking it, so frame
  // against the width still visible beside it — otherwise the current beat
  // lands underneath the panel.
  const cw = visibleWidth(canvasEl, reserved);
  const ch = canvasEl?.clientHeight || 400;
  const fitZoom = Math.min((cw - VIEW_PAD * 2) / b.width, (ch - VIEW_PAD * 2) / b.height);
  if (fitZoom >= FIT_FLOOR) {
    inst.fitView({ padding: 0.12, maxZoom: expanded ? 1.6 : 1, duration: 0 });
    return;
  }
  const zoom = READABLE_ZOOM;
  const cur = laid.find(n => n.id === currentId) || laid[laid.length - 1];
  const gW = b.width * zoom;
  const gH = b.height * zoom;
  let x;
  if (gW <= cw - VIEW_PAD * 2) {
    x = (cw - gW) / 2 - b.minX * zoom;
  } else {
    x = CURRENT_AT * cw - (cur.x + FIG_NODE_W) * zoom;
    // Never leave dead space before the story starts; room after the current
    // beat is fine (a finished experiment simply ends there).
    x = Math.min(VIEW_PAD - b.minX * zoom, x);
  }
  // Vertically: everything, centered, when it fits; otherwise put the
  // backbone row mid-canvas — evidence above it, verdicts and execution below
  // — falling back to the current card's row when the layout has no backbone.
  const rowY = Number.isFinite(backboneY) ? backboneY : cur.y;
  const y = gH <= ch - VIEW_PAD * 2
    ? (ch - gH) / 2 - b.minY * zoom
    : SPINE_AT * ch - (rowY + HANDLE_TOP) * zoom;
  inst.setViewport({ x, y, zoom }, { duration: 0 });
}

function FigurePanel({ projectId, node, onClose }) {
  const px = useProjectHref();
  const ref = node.ref || {};
  const meta = node.meta || {};

  const typeLabel = String(node.type || '').replace(/_/g, ' ');
  return (
    <DetailPanelShell
      typeLabel={node.qualifier ? `${typeLabel} · ${node.qualifier}` : typeLabel}
      title={node.label}
      status={node.status && node.status !== 'none'
        ? <StatusPill value={String(node.status)} />
        : null}
      onClose={onClose}
    >

      {ref.kind === 'artifact' && ref.id && (
        <>
          {meta.path && <div className="fig-panel-meta">{meta.path}</div>}
          {/* Native rendering (markdown / json / code / pdf / binary) through
              the same dispatcher the Artifacts page uses — not a raw text
              slice. ArtifactContentView owns the fetch, loading/error states,
              and per-type renderer selection. dedupeTitle keeps the panel
              header to just name + path: no leading H1 echoing the title
              already shown above. */}
          <div className="fig-panel-render">
            <ArtifactContentView
              projectId={projectId}
              artifactId={ref.id}
              size={meta.size_bytes}
              path={meta.path}
              dedupeTitle={node.label}
            />
          </div>
          <Link className="btn btn--sm" to={px(`/artifacts/${ref.id}`)}>Open in artifacts →</Link>
        </>
      )}

      {ref.kind === 'artifact_group' && (
        <>
          <div className="fig-panel-meta">
            {meta.count} additional files ({(meta.roles || []).join(', ')}) submitted for this attempt.
          </div>
          <Link className="btn btn--sm" to={px('/artifacts')}>Open artifacts →</Link>
        </>
      )}

      {ref.kind === 'claim' && (
        <>
          <div className="fig-panel-meta">{node.label}</div>
          <Link className="btn btn--sm" to={px(`/claims/${ref.id}`)}>Open claim →</Link>
        </>
      )}

      {node.type === 'submission' && (
        <div className="fig-panel-meta">
          Round {meta.submission_index} of experiment attempt {meta.attempt_index}.
          Everything submitted up to this point was frozen here.
        </div>
      )}

      {ref.kind === 'review' && meta.notes && (
        <div className="fig-panel-notes">{meta.notes}</div>
      )}

      {ref.kind === 'sandbox' && (
        <>
          {meta.sandbox_status && <div className="fig-panel-meta">sandbox: {meta.sandbox_status}</div>}
          <a className="btn btn--sm" href="#execution">Jump to terminal →</a>
        </>
      )}

      {node.type === 'conclusion' && node.sublabel && (
        <div className="fig-panel-notes">{node.sublabel}</div>
      )}
    </DetailPanelShell>
  );
}

/**
 * ExperimentFigure — the derived figure canvas (Phase 0).
 *
 * Renders the graph served by GET /experiments/{id}/figure: the attempt
 * spine, inputs, review verdicts (with revision loops), sandbox liveness,
 * conclusion, and tested claims. Everything shown is derived server-side.
 * The agent-authored logic graph is a sibling component (LogicGraph) that
 * shares this canvas slot via ExperimentGraphs: `active` decides whether
 * this view renders, `headerExtra` carries the shared view switch, and
 * `onAvailability` tells the parent whether there is anything to show.
 */
export default function ExperimentFigure({
  projectId, experimentId, experimentStatus, attemptIndex,
  active = true, titleTabs = null, onAvailability = null,
  expanded = false, onToggleExpand = null,
}) {
  // Stored as a JSON string and only swapped when the content actually
  // changes: react-flow keys its node measurements to object identity, so
  // recreating identical node objects on every poll tick would wipe the
  // measured handle bounds and silently drop every edge.
  const [figureJson, setFigureJson] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const rfRef = useRef(null);
  const canvasRef = useRef(null);
  const { width: panelWidth } = usePanelWidth();
  const select = useCallback((id) => setSelectedId(id), []);
  const selCtx = useMemo(() => ({ selectedId, select }), [selectedId, select]);

  const fetchFigure = useCallback(async () => {
    try {
      const data = await api.getExperimentFigure(projectId, experimentId);
      const json = JSON.stringify(data);
      setFigureJson(prev => (prev === json ? prev : json));
    } catch {
      // Non-fatal: the rest of the page still works without the figure.
      setFigureJson(null);
    }
  }, [projectId, experimentId]);

  // Terminal experiments fetch once; live ones poll 3s only while the event
  // stream is down, otherwise refetching rides this experiment's events.
  useStreamAwarePoll(fetchFigure, {
    enabled: !TERMINAL_STATUSES.includes(experimentStatus),
    refetchKey: `${experimentStatus}:${attemptIndex}`,
    matches: (row) => row.target_id === experimentId || row.payload?.experiment_id === experimentId,
  });

  const figure = useMemo(() => (figureJson ? JSON.parse(figureJson) : null), [figureJson]);
  const { nodes, edges, laid, backboneY, currentId } = useMemo(() => toFlow(figure), [figure]);

  // Frame the view: readable zoom, current beat in sight (see frameFigure).
  // `reserved` is the gutter the overlaying sidebar covers when one is open.
  const reserved = selectedId ? panelWidth : 0;
  const frame = useCallback(() => {
    frameFigure(rfRef.current, canvasRef.current, laid, currentId, { expanded, reserved, backboneY });
  }, [laid, currentId, expanded, reserved, backboneY]);

  // Re-frame when the topology grows (new nodes), not on every poll tick.
  // Plain timer + no animation duration: animated moves ride rAF, which is
  // throttled to never in background tabs — see MeasureSync. 350ms lands
  // after MeasureSync's second measure pass.
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);
  useEffect(() => {
    const t = setTimeout(frame, 350);
    return () => clearTimeout(t);
  }, [topologyKey, frame]);

  const selected = useMemo(
    () => (figure?.nodes || []).find(n => n.id === selectedId) || null,
    [figure, selectedId],
  );

  const available = Boolean(figure && (figure.nodes || []).length >= 2);
  useEffect(() => { onAvailability?.(available); }, [available, onAvailability]);

  // Re-frame after the canvas resizes between inline and expanded modes.
  useEffect(() => {
    const t = setTimeout(frame, 120);
    return () => clearTimeout(t);
  }, [expanded, frame]);

  // Escape closes the sidebar first; the graph slot's handler then gets the
  // next Escape to leave fullscreen. Capture phase so this runs before it.
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

  // …and whenever the canvas itself changes size (page layout settling after
  // data arrives, sidebar toggles, window resizes): the framing depends on the
  // real width. Debounced, and only for real size changes, so a pan is never
  // yanked back mid-gesture.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let last = { w: el.clientWidth, h: el.clientHeight };
    let t = null;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (Math.abs(w - last.w) < 8 && Math.abs(h - last.h) < 8) return;
      last = { w, h };
      clearTimeout(t);
      t = setTimeout(frame, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [frame, available]);

  if (!available || !active) return null;

  return (
    <section className={`exp-figure${expanded ? ' exp-figure--expanded' : ''}`} id="figure">
      <div className="fig-head">
        <div className="fig-title">
          {titleTabs || 'Figure'}
          <span className="fig-title-hint">derived from experiment state</span>
        </div>
        <div className="fig-head-right">
          <div className="fig-legend" aria-hidden="true">
            <span className="fig-chip fig-st--done">done</span>
            <span className="fig-chip fig-st--open">in motion</span>
            <span className="fig-chip fig-st--revise">needs changes</span>
            <span className="fig-chip fig-st--failed">failed</span>
            <span className="fig-chip fig-st--faded">superseded</span>
          </div>
          <GraphExpandButton expanded={expanded} onToggle={onToggleExpand} label="figure" />
        </div>
      </div>
      <div
        className="fig-body"
        style={{ '--fig-panel-w': `${panelWidth}px` }}
      >
        {/* Inline, the page owns the wheel: plain scrolling over the canvas
            scrolls the page (preventScrolling=false, zoomOnScroll=false) and
            zooming is reserved for unambiguous gestures — pinch / ctrl+wheel,
            the +/- controls. Expanded, page scroll is locked, so the wheel
            zooms the canvas instead. */}
        <div className="fig-canvas" ref={canvasRef}>
          <SelectedContext.Provider value={selCtx}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={inst => { rfRef.current = inst; frame(); }}
            onNodeClick={(event, node) => {
              // Non-draggable nodes get no d3-drag click suppression, so the
              // click would bubble to the pane and immediately deselect.
              event.stopPropagation();
              select(node.id);
            }}
            onPaneClick={() => setSelectedId(null)}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            // The card paints its own ring from selectedId; react-flow's own
            // selection would be a second state that drifts from it.
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
          </SelectedContext.Provider>
          <div className="fig-canvas-hint" aria-hidden="true">drag to pan · pinch to zoom</div>
        </div>
        {selected && <PanelResizer />}
        {selected && (
          <FigurePanel
            projectId={projectId}
            node={selected}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </section>
  );
}
