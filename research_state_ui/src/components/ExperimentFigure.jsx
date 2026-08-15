import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, useStoreApi } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api';
import StatusPill from './StatusPill';
import DetailPanelShell from './DetailPanelShell';
import ArtifactContentView from './ArtifactContentView';
import { layoutFigure, figureBounds, FIG_NODE_W, FIG_CARD_H } from '../utils/figureLayout';
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
  working: '◌',
};
// Head-line wording where the raw type is not the best word.
const TYPE_LABEL = { working: 'in progress' };

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

// Attachment edges (a beat → the files / sandbox that belong to it) are shown
// as placement — the satellite sits in its beat's column — not as lines. Lines
// are reserved for the spine, so what remains readable is the temporal story.
const ATTACHMENT_EDGES = new Set(['proposed', 'submitted', 'produced', 'ran_on']);

// Card geometry the layout needs before anything renders: a plain card, and
// the extra height each accumulated item row adds (kept in step with the CSS).
const ITEM_ROW_H = 20;
const ITEMS_PAD = 10;
const MAX_ITEM_ROWS = 6;
// Where the spine passes through every card: a fixed offset from the top, so a
// tall accumulating card and a plain one still sit on one straight line.
const HANDLE_TOP = 38;

// Which node's detail is open. Read by the card so it can highlight itself or
// the one accumulated row that is selected, without recreating node objects
// (react-flow keys its handle measurements to node identity).
const SelectedContext = createContext(null);

function FigureNode({ data }) {
  const selectedId = useContext(SelectedContext);
  const items = data.items || [];
  const shown = items.slice(0, MAX_ITEM_ROWS);
  const overflow = items.length - shown.length;
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
    >
      <Handle type="target" position={Position.Left} className="fig-handle" style={{ top: HANDLE_TOP }} />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">{TYPE_GLYPH[data.type] || '•'}</span>
        <span className="fig-node-type">{TYPE_LABEL[data.type] || String(data.type || '').replace(/_/g, ' ')}</span>
        {data.statusClass === 'open' && <span className="fig-node-live" aria-hidden="true" />}
        {/* Which round this node is about ("attempt 2", "round 3.1"): the
            qualifier that keeps four `Experiment review`s apart without
            tracing an edge. Markers ARE their round, so they carry none. */}
        {data.qualifier && <span className="fig-node-qual">{data.qualifier}</span>}
      </div>
      <div className="fig-node-label" title={data.label}>{data.label}</div>
      {data.sublabel ? <div className="fig-node-sub" title={data.sublabel}>{data.sublabel}</div> : null}
      {/* What this beat accumulated: the files a submission sealed, the plan an
          attempt proposed. Each row opens that artifact (see onNodeClick). */}
      {items.length > 0 && (
        <ul className="fig-node-items">
          {shown.map(item => (
            <li
              key={item.id}
              data-item-id={item.id}
              className={[
                'fig-node-item',
                item.faded ? 'fig-node-item--faded' : '',
                selectedId === item.id ? 'fig-node-item--selected' : '',
              ].filter(Boolean).join(' ')}
              title={item.title}
            >
              <span className="fig-node-item-glyph" aria-hidden="true">{item.glyph}</span>
              <span className="fig-node-item-label">{item.label}</span>
              {item.hint && <span className="fig-node-item-hint">{item.hint}</span>}
            </li>
          ))}
          {overflow > 0 && <li className="fig-node-item fig-node-item--more">+{overflow} more</li>}
        </ul>
      )}
      <Handle type="source" position={Position.Right} className="fig-handle" style={{ top: HANDLE_TOP }} />
    </div>
  );
}

const nodeTypes = { figure: FigureNode };

/** Estimated rendered height of a card, for the layout and the viewport math. */
function cardHeight(itemCount) {
  if (!itemCount) return FIG_CARD_H;
  const rows = Math.min(itemCount, MAX_ITEM_ROWS) + (itemCount > MAX_ITEM_ROWS ? 1 : 0);
  return FIG_CARD_H + ITEMS_PAD + rows * ITEM_ROW_H;
}

function itemOf(node) {
  const meta = node.meta || {};
  if (node.type === 'artifact_group') {
    return {
      id: node.id, glyph: TYPE_GLYPH.artifact_group, label: node.label,
      hint: (meta.roles || []).join(' · '), title: node.sublabel || node.label, faded: false,
    };
  }
  return {
    id: node.id, glyph: TYPE_GLYPH.artifact, label: node.label,
    hint: meta.role || '', title: `${node.label} · ${node.sublabel || ''}`,
    faded: Boolean(meta.superseded),
  };
}

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

/**
 * A beat accumulates what belongs to it. Evidence-lane satellites (the files a
 * submission sealed, the plan an attempt proposed) fold into their anchor card
 * as rows; execution-lane files not yet sealed gather into one "Working files"
 * card below the beat they trail. Everything else (spine, sandbox) stays a
 * card of its own. The figure JSON itself is untouched — the folded artifacts
 * remain there for the detail panel and the mobile outline.
 */
function accumulate(figure) {
  const raw = figure?.nodes || [];
  const ids = new Set(raw.map(n => n.id));
  const isFile = (n) => n.type === 'artifact' || n.type === 'artifact_group';
  const byAnchor = new Map();
  const working = new Map();
  const keep = [];
  for (const n of raw) {
    if (n.anchor && ids.has(n.anchor) && isFile(n) && n.lane !== 'execution') {
      if (!byAnchor.has(n.anchor)) byAnchor.set(n.anchor, []);
      byAnchor.get(n.anchor).push(itemOf(n));
    } else if (n.anchor && ids.has(n.anchor) && isFile(n)) {
      if (!working.has(n.anchor)) working.set(n.anchor, { items: [], qualifier: n.qualifier, group: n.group });
      working.get(n.anchor).items.push(itemOf(n));
    } else {
      keep.push(n);
    }
  }
  const nodes = keep.map(n => {
    const items = byAnchor.get(n.id) || [];
    return { ...n, items, h: cardHeight(items.length) };
  });
  for (const [anchor, w] of working.entries()) {
    const count = w.items.reduce((acc, it) => acc + (it.id.startsWith('artifact_group:') ? 0 : 1), 0);
    const more = w.items.length - count;
    nodes.push({
      id: `working:${anchor}`,
      type: 'working',
      label: 'Working files',
      sublabel: `${count}${more ? '+' : ''} not yet submitted`,
      status: 'active',
      anchor,
      lane: 'execution',
      qualifier: w.qualifier,
      group: w.group,
      items: w.items,
      h: cardHeight(w.items.length),
    });
  }
  return { nodes, edges: figure?.edges || [] };
}

function toFlow(figure) {
  const laid = layoutFigure(accumulate(figure), { timeline: true });
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
  const edges = laid.edges
    .filter(e => !ATTACHMENT_EDGES.has(e.type))
    .map(e => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      className: `fig-edge fig-edge--${e.type}`,
      animated: liveIds.has(e.from) || liveIds.has(e.to),
      markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
    }));
  // The reader's reference point: the beat the server marks as "now", else
  // the rightmost card on the spine.
  const spine = laid.nodes.filter(n => !n.anchor);
  const current = spine.find(n => n.current)
    || spine.slice().sort((a, b) => b.x - a.x || a.y - b.y)[0]
    || null;
  return { nodes, edges, laid: laid.nodes, currentId: current ? current.id : null };
}

// Readable framing. Fit everything only when that keeps cards legible;
// otherwise show the timeline at 1× and anchor the view on the current beat —
// near the right edge, so what led up to it fills the canvas.
const FIT_FLOOR = 0.85;
const READABLE_ZOOM = 1;
const VIEW_PAD = 28;
const CURRENT_AT = 0.78; // current card's right edge, as a fraction of canvas width

function frameFigure(inst, canvasEl, laid, currentId, { expanded }) {
  if (!inst || !laid?.length) return;
  const b = figureBounds(laid);
  const cw = canvasEl?.clientWidth || 1000;
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
  const y = gH <= ch - VIEW_PAD * 2
    ? (ch - gH) / 2 - b.minY * zoom
    : VIEW_PAD - b.minY * zoom;
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
      onClose={onClose}
    >
      {node.status && node.status !== 'none' && (
        <div style={{ margin: '6px 0' }}><StatusPill value={String(node.status)} /></div>
      )}

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

      {node.type === 'working' && (
        <div className="fig-panel-meta">
          Files registered after the latest beat and not yet sealed into a
          result submission. Click a row on the card to open one.
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
  const { width: panelWidth, startResize } = usePanelWidth();

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
  const { nodes, edges, laid, currentId } = useMemo(() => toFlow(figure), [figure]);

  // Frame the view: readable zoom, current beat in sight (see frameFigure).
  const frame = useCallback(() => {
    frameFigure(rfRef.current, canvasRef.current, laid, currentId, { expanded });
  }, [laid, currentId, expanded]);

  // Re-frame when the topology grows (new nodes), not on every poll tick.
  // Plain timer + no animation duration: animated moves ride rAF, which is
  // throttled to never in background tabs — see MeasureSync. 350ms lands
  // after MeasureSync's second measure pass.
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);
  useEffect(() => {
    const t = setTimeout(frame, 350);
    return () => clearTimeout(t);
  }, [topologyKey, frame]);

  // Cards that accumulate files keep those artifacts out of the canvas node
  // list, but their detail lives in the raw figure — look up there so a row
  // click and a card click resolve the same way.
  const selected = useMemo(
    () => (figure?.nodes || []).find(n => n.id === selectedId)
      || (selectedId?.startsWith('working:') ? nodes.find(n => n.id === selectedId)?.data : null)
      || null,
    [figure, nodes, selectedId],
  );

  const available = Boolean(figure && (figure.nodes || []).length >= 2);
  useEffect(() => { onAvailability?.(available); }, [available, onAvailability]);

  // Re-frame after the canvas resizes between inline and expanded modes.
  useEffect(() => {
    const t = setTimeout(frame, 120);
    return () => clearTimeout(t);
  }, [expanded, frame]);

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
          <div className="fig-legend">
            <span className="fig-chip fig-st--done">done</span>
            <span className="fig-chip fig-st--open">in motion</span>
            <span className="fig-chip fig-st--revise">needs changes</span>
            <span className="fig-chip fig-st--failed">failed</span>
            <span className="fig-chip fig-st--faded">superseded</span>
            <span className="fig-legend-sep" aria-hidden="true" />
            <span className="fig-chip fig-chip--edge fig-chip--edge-then">→ next</span>
            <span className="fig-chip fig-chip--edge fig-chip--edge-revised">⇢ sent back</span>
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
        {/* Inline, the page owns the wheel: plain scrolling over the canvas
            scrolls the page (preventScrolling=false, zoomOnScroll=false) and
            zooming is reserved for unambiguous gestures — pinch / ctrl+wheel,
            the +/- controls. Expanded, page scroll is locked, so the wheel
            zooms the canvas instead. */}
        <div className="fig-canvas" ref={canvasRef}>
          <SelectedContext.Provider value={selectedId}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={inst => { rfRef.current = inst; frame(); }}
            onNodeClick={(event, node) => {
              // Non-draggable nodes get no d3-drag click suppression, so the
              // click would bubble to the pane and immediately deselect.
              event.stopPropagation();
              // A click on an accumulated row opens that artifact; anywhere
              // else on the card opens the card.
              const row = event.target.closest?.('[data-item-id]');
              setSelectedId(row ? row.getAttribute('data-item-id') : node.id);
            }}
            onPaneClick={() => setSelectedId(null)}
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
          </SelectedContext.Provider>
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
