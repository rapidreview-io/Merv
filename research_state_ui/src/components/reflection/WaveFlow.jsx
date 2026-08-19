import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { ReactFlow, Background, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MeasureSync } from '../ExperimentFigure';
import { PanelResizer } from '../DetailPanelShell';
import GraphExpandButton from '../GraphExpandButton';
import GraphDrawer from '../GraphDrawer';
import { usePanelWidth } from '../../store/usePanelWidth';
import { useProjectHref } from '../../store/useProjectStore';
import { fmtSpan } from '../../utils/format';
import { buildBraid } from './braidModel.js';
import WaveFlowPanel from './WaveFlowPanel';

/**
 * WaveFlow — the project graph: reflection/consolidation waves as the narrow
 * waists of the stream, experiments fanning between them. Each wave consumes
 * the experiments that finished since the previous wave and produces the next
 * wave of experiments; unfinished work dangles dashed toward the open wave —
 * or toward a ghost "next" node when no wave is open (the reflection debt).
 *
 * Interaction model: clicking a node SELECTS it into the right sidebar
 * (WaveFlowPanel, same split-body grammar as ExperimentFigure/LogicGraph);
 * the sidebar's giant Open button is what navigates. Same canvas conventions
 * as the figure/map: static layered layout, invisible handles, MeasureSync.
 */

// Layered layout: exp column c sits at EXPX(c); reflection i sits in the gap
// between column i-1 (what it consumed) and column i (what it produced).
// EXP_H is a CONTRACT with .wflow-fig { height } in CSS: layout math assumes
// exact card centers, and smoothstep edges jog visibly for even a 3px
// mismatch — a card must never auto-size.
const EXP_W = 190;
const EXP_H = 70;
const ROW = 132;
const STEP = 420;
const REFL_W = 48;
const REFL_H = 148;
const X0 = 40;
const SPINE = 200;
// Breathing room on BOTH sides of a wave pill: whatever the step leaves after
// a card and a pill, split evenly.
const REFL_GAP = (STEP - EXP_W - REFL_W) / 2;
const expX = (c) => X0 + (c + 1) * STEP;
const reflX = (i) => X0 + i * STEP + EXP_W + REFL_GAP;

const statusWord = (s) => String(s || '').replace(/_/g, ' ') || '—';

// Lifecycle tone → the figure graph's status-tint vocabulary (fig-st--*).
// Queued work stays neutral: no tint is what "not judged yet" looks like.
const FIG_ST = { done: 'done', failed: 'failed', live: 'open', abandoned: 'faded' };

// Card metadata line: duration (elapsed for live work, span for finished),
// then claim/artifact counts when there are any. Same coarse register as the
// sidebar's meta line (fmtSpan), so the card and the panel never disagree.
function expMetaLine(data) {
  const parts = [];
  const t0 = data.createdAt ? Date.parse(data.createdAt) : NaN;
  const t1 = data.tone === 'live'
    ? Date.now()
    : (data.updatedAt ? Date.parse(data.updatedAt) : NaN);
  const dur = fmtSpan(t1 - t0);
  if (dur && dur !== '<1m') parts.push(dur);
  if (data.nClaims) parts.push(`${data.nClaims} claim${data.nClaims > 1 ? 's' : ''}`);
  if (data.nChecks) parts.push(`${data.nChecks} check${data.nChecks > 1 ? 's' : ''}`);
  if (data.nArt) parts.push(`${data.nArt} artifact${data.nArt > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

/**
 * Pure braid → react-flow nodes/edges. Nodes carry only serializable facts so
 * the component can key identity on JSON (react-flow drops edges when node
 * objects are recreated with unchanged content — the Figure gotcha).
 * expMeta: {id: {updatedAt, nArt, nClaims}} — card metadata from the live
 * experiment rows (the braid itself only carries name/status/created).
 */
export function buildFlowModel(braid, signal, expMeta = {}) {
  const { epochs, strands } = braid;
  const openIdx = epochs.findIndex(e => e.isOpen);
  // Frontier strands (consumed by nothing yet) sit just left of the open wave
  // so their dashed edges flow INTO it; with no open wave they trail past the
  // last published one, toward the ghost.
  const frontierCol = openIdx >= 0 ? openIdx - 1 : epochs.length - 1;
  const colOf = (s) => {
    if (s.spawnIdx >= 0) return s.spawnIdx;
    if (s.coverIdx >= 0) return s.coverIdx - 1;
    return frontierCol;
  };

  const nodes = [];
  const edges = [];
  // The origin every braid grows from: project creation, the "epoch -1" that
  // seeded the pre-wave experiments. Always present — a brand-new project IS
  // this one node, so the graph never blanks out.
  nodes.push({
    id: 'w:origin',
    type: 'wrefl',
    position: { x: reflX(-1), y: SPINE - REFL_H / 2 },
    data: { origin: true, label: '◆', sub: 'created', title: 'Project created' },
  });
  epochs.forEach((e, i) => {
    nodes.push({
      id: `w:${e.id}`,
      type: 'wrefl',
      position: { x: reflX(i), y: SPINE - REFL_H / 2 },
      data: {
        waveId: e.id,
        label: `R${e.ordinal}`,
        isOpen: e.isOpen,
        sub: e.isOpen
          ? statusWord(e.status)
          : (e.attemptIndex > 1 ? `attempt ${e.attemptIndex}` : 'published'),
        title: `${e.title} · ${statusWord(e.status)}`
          + (e.revisionContext ? ` · ↩ ${e.revisionContext}` : ''),
      },
    });
  });

  const uncovered = strands.filter(s => s.coverIdx < 0);
  let ghostId = null;
  if (openIdx < 0 && uncovered.length) {
    ghostId = 'w:next';
    const n = signal?.new_terminal_since_publish;
    const m = signal?.block_new_terminal_threshold;
    nodes.push({
      id: ghostId,
      type: 'wrefl',
      position: { x: reflX(epochs.length), y: SPINE - REFL_H / 2 },
      data: {
        ghost: true,
        label: 'next',
        sub: n != null && m ? `${n} of ${m}` : '',
        title: signal?.hint || 'Next reflection',
      },
    });
  }

  const cols = new Map();
  for (const s of strands) {
    const c = colOf(s);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c).push(s);
  }
  // Dead work folds into a stack: within a column, failed/abandoned strands
  // sharing provenance (same spawn + same cover target) collapse into ONE
  // compact group node when there are 2+, so a wave with many casualties
  // doesn't stretch the column. Live/queued/complete work always stays
  // individual; the stack sinks to the bottom of the fan.
  const DEAD = new Set(['failed', 'abandoned']);
  const groupOf = new Map();
  const groups = [];
  const rowsOf = new Map();
  for (const [c, list] of cols) {
    const rows = list.filter(s => !DEAD.has(s.tone));
    const byKey = new Map();
    for (const s of list.filter(s => DEAD.has(s.tone))) {
      const key = `${s.spawnIdx}|${s.coverIdx}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    }
    for (const members of byKey.values()) {
      if (members.length < 2) { rows.push(...members); continue; }
      const g = {
        id: `g:${c}:${members[0].id}`,
        col: c,
        members,
        spawnIdx: members[0].spawnIdx,
        coverIdx: members[0].coverIdx,
      };
      groups.push(g);
      members.forEach(m => groupOf.set(m.id, g.id));
      rows.push(g);
    }
    rowsOf.set(c, rows);
  }
  for (const [c, rows] of rowsOf) {
    rows.forEach((r, k) => {
      const cy = SPINE + (k - (rows.length - 1) / 2) * ROW;
      if (r.members) {
        const nF = r.members.filter(m => m.tone === 'failed').length;
        const nA = r.members.length - nF;
        nodes.push({
          id: r.id,
          type: 'wexpg',
          position: { x: expX(c), y: cy - EXP_H / 2 },
          data: {
            ids: r.members.map(m => m.id),
            count: r.members.length,
            noun: r.members.every(m => m.kind === 'task')
              ? 'tasks'
              : r.members.some(m => m.kind === 'task') ? 'nodes' : 'experiments',
            label: [nF && `${nF} failed`, nA && `${nA} abandoned`]
              .filter(Boolean).join(' · '),
            sub: r.members.map(m => m.name).join(', '),
          },
        });
        return;
      }
      const s = r;
      const meta = expMeta[s.id] || {};
      nodes.push({
        id: `e:${s.id}`,
        type: 'wexp',
        position: { x: expX(c), y: cy - EXP_H / 2 },
        data: {
          expId: s.id,
          kind: s.kind || 'experiment',
          name: s.name,
          tone: s.tone,
          sub: (s.kind === 'task' ? 'task · ' : '') + statusWord(s.status)
            + (s.attemptIndex > 1 ? ` · attempt ${s.attemptIndex}` : ''),
          createdAt: s.createdAt || null,
          updatedAt: meta.updatedAt || null,
          nArt: meta.nArt || 0,
          nClaims: meta.nClaims || 0,
          nChecks: meta.nChecks || 0,
        },
      });
    });
  }

  // Same edge grammar as the figure/logic graphs: smoothstep shape, closed
  // arrowheads. Work still in flight flows as an ANIMATED marching dash.
  const EDGE = {
    type: 'smoothstep',
    pathOptions: { borderRadius: 10 },
    markerEnd: { type: 'arrowclosed', width: 13, height: 13 },
  };
  // Origin feeds the column -1 strands (the pre-wave seeds); if the braid has
  // waves but no seeds, it feeds R1 directly so the stream stays connected.
  const seeds = strands.filter(s => colOf(s) === -1);
  for (const s of seeds) {
    if (groupOf.has(s.id)) continue;
    edges.push({
      id: `og:${s.id}`,
      source: 'w:origin',
      target: `e:${s.id}`,
      ...EDGE,
      className: 'wflow-edge',
    });
  }
  for (const g of groups) {
    if (g.col === -1 && g.spawnIdx < 0) {
      edges.push({
        id: `og:${g.id}`,
        source: 'w:origin',
        target: g.id,
        ...EDGE,
        className: 'wflow-edge',
      });
    }
  }
  if (!seeds.length && epochs.length) {
    edges.push({
      id: 'og:w0',
      source: 'w:origin',
      target: `w:${epochs[0].id}`,
      ...EDGE,
      className: 'wflow-edge',
    });
  }
  for (const s of strands) {
    if (groupOf.has(s.id)) continue;
    if (s.spawnIdx >= 0) {
      edges.push({
        id: `sp:${s.id}`,
        source: `w:${epochs[s.spawnIdx].id}`,
        target: `e:${s.id}`,
        ...EDGE,
        className: 'wflow-edge',
      });
    }
    if (s.coverIdx >= 0) {
      edges.push({
        id: `cv:${s.id}`,
        source: `e:${s.id}`,
        target: `w:${epochs[s.coverIdx].id}`,
        ...EDGE,
        className: 'wflow-edge',
      });
    } else {
      const target = openIdx >= 0 ? `w:${epochs[openIdx].id}` : ghostId;
      if (target) {
        edges.push({
          id: `pd:${s.id}`,
          source: `e:${s.id}`,
          target,
          ...EDGE,
          animated: s.tone === 'live',
          className: 'wflow-edge wflow-edge--pending',
        });
      }
    }
  }
  // A stack carries one edge per relationship its members share.
  for (const g of groups) {
    if (g.spawnIdx >= 0) {
      edges.push({
        id: `sp:${g.id}`,
        source: `w:${epochs[g.spawnIdx].id}`,
        target: g.id,
        ...EDGE,
        className: 'wflow-edge',
      });
    }
    if (g.coverIdx >= 0) {
      edges.push({
        id: `cv:${g.id}`,
        source: g.id,
        target: `w:${epochs[g.coverIdx].id}`,
        ...EDGE,
        className: 'wflow-edge',
      });
    } else {
      const target = openIdx >= 0 ? `w:${epochs[openIdx].id}` : ghostId;
      if (target) {
        edges.push({
          id: `pd:${g.id}`,
          source: g.id,
          target,
          ...EDGE,
          className: 'wflow-edge wflow-edge--pending',
        });
      }
    }
  }
  return { nodes, edges };
}

// Selection reaches nodes via context, not node data — recreating node
// objects on selection would wipe measured handle bounds (Map/Figure gotcha).
const FlowCtx = createContext({ sel: null, select: () => {} });

// react-flow's own Enter/Space handler drives its internal store and never
// reaches our onNodeClick, so keyboard activation is each card's own business
// — the same contract the figure, logic, and process graphs carry.
const keyActivate = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
};

function ExpNode({ data }) {
  const { sel, select } = useContext(FlowCtx);
  const isTask = data.kind === 'task';
  const selKind = isTask ? 'task' : 'exp';
  const selected = sel?.kind === selKind && sel.id === data.expId;
  const figSt = FIG_ST[data.tone];
  return (
    <div
      className={[
        'fig-node', 'wflow-fig', isTask ? 'fig-node--task' : 'fig-node--experiment',
        figSt ? `fig-st--${figSt}` : '',
        selected ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      title={`${data.name} · ${data.sub}`}
      role="button"
      tabIndex={0}
      aria-label={`${data.name} — ${data.sub}`}
      onKeyDown={keyActivate(() => select({ kind: selKind, id: data.expId }))}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">{isTask ? '◇' : '◈'}</span>
        <span className="fig-node-type">{data.sub}</span>
        {data.tone === 'live' && <span className="fig-node-live" aria-hidden="true" />}
      </div>
      <div className="fig-node-label">{data.name}</div>
      <div className="fig-node-sub">{expMetaLine(data)}</div>
      <Handle type="source" position={Position.Right} className="fig-handle" />
    </div>
  );
}

// A stack of set-aside work: one passive card standing in for N dead
// experiments. Clicking it lists the members in the drawer.
function ExpGroupNode({ id, data }) {
  const { sel, select } = useContext(FlowCtx);
  const selected = (sel?.kind === 'group' && sel.id === id)
    || ((sel?.kind === 'exp' || sel?.kind === 'task') && data.ids.includes(sel.id));
  return (
    <div
      className={[
        'fig-node', 'wflow-fig', 'fig-node--experiment', 'wflow-fig--group',
        'fig-st--failed',
        selected ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      title={data.sub}
      role="button"
      tabIndex={0}
      aria-label={`${data.count} ${data.noun} set aside — ${data.label}`}
      onKeyDown={keyActivate(() => select({ kind: 'group', id, ids: data.ids }))}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">⧉</span>
        <span className="fig-node-type">{data.count} {data.noun}</span>
      </div>
      <div className="fig-node-label">{data.label}</div>
      <div className="fig-node-sub">{data.sub}</div>
      <Handle type="source" position={Position.Right} className="fig-handle" />
    </div>
  );
}

function ReflNode({ data }) {
  const { sel, select } = useContext(FlowCtx);
  const selected = data.origin
    ? sel?.kind === 'origin'
    : data.ghost
      ? sel?.kind === 'ghost'
      : sel?.kind === 'wave' && sel.id === data.waveId;
  const kind = data.origin
    ? 'origin'
    : data.ghost ? 'ghost' : (data.isOpen ? 'open' : 'published');
  const target = data.origin
    ? { kind: 'origin' }
    : data.ghost ? { kind: 'ghost' } : { kind: 'wave', id: data.waveId };
  return (
    <div
      className={`wflow-refl wflow-refl--${kind}${selected ? ' wflow-node--selected' : ''}`}
      title={data.title}
      role="button"
      tabIndex={0}
      aria-label={data.title}
      onKeyDown={keyActivate(() => select(target))}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="wflow-refl-label">{data.label}</div>
      <Handle type="source" position={Position.Right} className="fig-handle" />
      {data.sub && <div className="wflow-refl-sub">{data.sub}</div>}
    </div>
  );
}

const nodeTypes = { wexp: ExpNode, wexpg: ExpGroupNode, wrefl: ReflNode };

export default function WaveFlow({
  waves, experiments, tasks = [], signal, project, onSelect, height = 420,
  title = 'Project graph',
}) {
  const px = useProjectHref();
  const navigate = useNavigate();
  const [sel, setSel] = useState(null); // {kind: 'exp'|'wave'|'ghost', id?}
  const [expanded, setExpanded] = useState(false);
  // The drawer reads the same shared width as every other graph sidebar.
  const { width: panelWidth } = usePanelWidth();
  // Identity discipline: rebuild braid/node objects only when the underlying
  // facts change, not on every poll tick or store-array replacement.
  const braidJson = useMemo(
    () => JSON.stringify(buildBraid(waves, experiments, tasks)),
    [waves, experiments, tasks],
  );
  const braid = useMemo(() => JSON.parse(braidJson), [braidJson]);
  // Card metadata from the live rows, JSON-keyed for the same identity
  // discipline (store arrays are replaced every poll tick).
  const expMetaJson = useMemo(() => JSON.stringify(Object.fromEntries([
    ...(experiments || []).map(e => [e.id, {
      updatedAt: e.updated_at || null,
      nArt: (e.artifacts || []).length,
      nClaims: (e.tested_claims || []).length,
    }]),
    ...(tasks || []).map(t => [t.id, {
      updatedAt: t.updated_at || null,
      nArt: (t.artifacts || []).length,
      nChecks: (t.checks || []).length,
    }]),
  ])), [experiments, tasks]);
  const expMeta = useMemo(() => JSON.parse(expMetaJson), [expMetaJson]);
  const { nodes, edges } = useMemo(
    () => buildFlowModel(braid, signal, expMeta),
    [braid, signal, expMeta],
  );
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);
  // The camera re-fits when the PICTURE changes — a node added, removed, or
  // moved to another column — never on a poll tick that only refreshed card
  // text, so a reader's own pan or zoom survives polling.
  const layoutKey = useMemo(
    () => nodes.map(n => `${n.id}@${n.position.x},${n.position.y}`).join('|'),
    [nodes],
  );
  const rfRef = useRef(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // The canvas wrapper fitCanvas measures. (The drawer's own hidden-document
  // problem — a transition that never advances in a background tab — is the
  // shared GraphDrawer's business now: it resolves its duration to 0 there.)
  const shiftRef = useRef(null);
  // The canvas stays hidden until the camera has been placed once, so the
  // first frame the reader sees is the final framing. It used to show
  // react-flow's own auto-fit (a different framing) for ~120ms, then jump to
  // ours — one of several "size tweaks" the graph went through on load.
  const [framed, setFramed] = useState(false);
  // Canvas size at the last camera placement; the resize observer below
  // refits only when the size has really moved on from it.
  const fittedSizeRef = useRef(null);
  // Deterministic fit from DOM-measured canvas size and the layout's FIXED
  // node dimensions (EXP_W/H, REFL_W/H): no measure pass, no rAF, no timer.
  // react-flow's own fitView reads dimensions fed by a ResizeObserver→rAF
  // pipeline that starves in hidden documents, so it can fit against a stale
  // size; the DOM's clientWidth/Height never lies.
  const fitCanvas = useCallback(() => {
    const rf = rfRef.current;
    const el = shiftRef.current;
    const ns = nodesRef.current;
    if (!rf || !el || !ns.length) return;
    // Fullscreen has room to spare, so it may enlarge a small braid a little.
    const maxZoom = expandedRef.current ? 1.15 : 1;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of ns) {
      const w = n.type === 'wrefl' ? REFL_W : EXP_W;
      const h = n.type === 'wrefl' ? REFL_H : EXP_H;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const W = el.clientWidth;
    const H = el.clientHeight;
    fittedSizeRef.current = { w: W, h: H };
    const zoom = Math.min(maxZoom, (W * 0.86) / (maxX - minX), (H * 0.8) / (maxY - minY));
    // A braid much narrower than the canvas anchors LEFT (a young project
    // reads from its origin, not from the middle of a wide emptiness); snug
    // fits stay centered.
    const dispW = (maxX - minX) * zoom;
    const x = (W - dispW > W * 0.3 ? 56 : (W - dispW) / 2) - minX * zoom;
    rf.setViewport({
      x,
      y: (H - (maxY - minY) * zoom) / 2 - minY * zoom,
      zoom,
    }, { duration: 0 });
  }, []);

  // Camera placement is synchronous with layout, never deferred. In a layout
  // effect, a changed braid (an experiment appears, a wave is published) and
  // the container height it implies paint in the same frame as their new
  // framing — instead of 350ms of the new picture under the old camera. Same
  // for entering / leaving fullscreen: the fixed-position slot has its size
  // the moment the class lands. (On first mount react-flow's pan/zoom does
  // not exist yet; onInit places the camera and reveals the canvas.)
  useLayoutEffect(() => { fitCanvas(); }, [layoutKey, expanded, fitCanvas]);
  // …and when the canvas itself changes size under the reader (sidebar
  // toggle, window resize): the framing depends on the real width. Only for
  // a size the camera has not already been placed for — the layout effect
  // above handles fullscreen and braid changes synchronously, so this never
  // doubles them — and debounced, so a pan is never yanked back mid-gesture.
  useEffect(() => {
    const el = shiftRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let t = null;
    const ro = new ResizeObserver(() => {
      const last = fittedSizeRef.current;
      if (!last) return; // not placed yet: onInit will read the live size
      if (Math.abs(el.clientWidth - last.w) < 8 && Math.abs(el.clientHeight - last.h) < 8) return;
      clearTimeout(t);
      t = setTimeout(fitCanvas, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [fitCanvas]);
  // The drawer neither resizes nor moves the canvas — it simply covers it —
  // so opening or closing it changes the camera not at all.
  // Escape peels one layer at a time: drawer first, then fullscreen.
  useEffect(() => {
    if (!sel && !expanded) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (sel) setSel(null);
      else setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, expanded]);
  // Fullscreen: lock page scroll while expanded.
  useEffect(() => {
    if (!expanded) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [expanded]);
  // Nothing pans the camera on select, and nothing restores it on close: the
  // drawer covers the graph rather than displacing it, so there is no
  // displacement to undo. Both used to animate the viewport on every open and
  // every close.

  const openExp = useCallback(
    (id) => navigate(px(`/experiments/${id}`)),
    [navigate, px],
  );
  const openTask = useCallback(
    (id) => navigate(px(`/tasks/${id}`)),
    [navigate, px],
  );
  // A wave id opens that wave's page; null (the ghost) is the caller's call —
  // Home sends it to the reflection list.
  const openWave = useCallback(
    (id) => onSelect?.(id ?? null),
    [onSelect],
  );

  const ctx = useMemo(() => ({ sel, select: setSel }), [sel]);

  // Adaptive height: the `height` prop is a CEILING, not the size. fitCanvas
  // caps zoom at 1 and fits wide braids by WIDTH, so a short (or wide-but-
  // flat) braid displays far shorter than the container — leaving Home a tall
  // empty box. Estimate the displayed height at the zoom the fit will pick
  // and shrink the container to it (floor 340px so the frame never collapses).
  const cssHeight = useMemo(() => {
    if (!nodes.length) return height;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of nodes) {
      const w = n.type === 'wrefl' ? REFL_W : EXP_W;
      const h = n.type === 'wrefl' ? REFL_H : EXP_H;
      minX = Math.min(minX, n.position.x);
      maxX = Math.max(maxX, n.position.x + w);
      minY = Math.min(minY, n.position.y);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const estW = typeof window !== 'undefined' ? Math.max(560, window.innerWidth - 420) : 1000;
    const zoom = Math.min(1, (estW * 0.86) / (maxX - minX));
    const need = Math.max(420, Math.round((maxY - minY) * zoom * 1.25 + 60));
    return `min(${need}px, ${typeof height === 'number' ? `${height}px` : height})`;
  }, [nodes, height]);

  if (!nodes.length) return null;
  return (
    <FlowCtx.Provider value={ctx}>
      {expanded && (
        <div className="fig-backdrop" onClick={() => setExpanded(false)} aria-hidden="true" />
      )}
      {/* Header and canvas share one slot, and the SLOT is what goes
          fullscreen — the header has to ride along, or expanding buries the
          Collapse button and the legend under the canvas with no way out but
          Escape. Same reason .exp-figure--expanded wraps the other graphs'
          headers. The slot is pure layout inline, so Home keeps its airy,
          card-less presentation. */}
      <div className={`wflow-slot${expanded ? ' wflow-slot--expanded' : ''}`}>
        <div className="fig-head">
          <div className="fig-title">{title}</div>
          <div className="fig-head-right">
            <div className="wflow-legend" aria-hidden="true">
              <span className="fig-chip fig-st--done">done</span>
              <span className="fig-chip fig-st--open">running</span>
              <span className="fig-chip">◇ task</span>
              <span className="fig-chip wflow-chip--failed">failed</span>
              <span className="fig-chip wflow-chip--refl">reflection</span>
              <span className="fig-chip wflow-chip--pending">not yet consolidated</span>
            </div>
            <GraphExpandButton
              expanded={expanded}
              onToggle={() => setExpanded(v => !v)}
              label="project graph"
            />
          </div>
        </div>
        <div
          className="wflow"
          style={{ height: expanded ? undefined : cssHeight, '--fig-panel-w': `${panelWidth}px` }}
        >
        {/* The canvas wrapper: never resized, never moved — the drawer covers
            it, so react-flow never re-lays-out. */}
        <div className="wflow-shift" ref={shiftRef}>
          <div className={`wflow-canvas${framed ? '' : ' wflow-canvas--unframed'}`}>
            {/* No `fitView`: react-flow's auto-fit frames the picture its own
                way (padding 0.1, centered, up to maxZoom) and would show for
                a beat before ours replaced it. The camera is ours alone —
                placed here the moment pan/zoom exists, then kept in step by
                the layout effect above. */}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={inst => { rfRef.current = inst; fitCanvas(); setFramed(true); }}
              onNodeClick={(event, node) => {
                event.stopPropagation();
                if (node.type === 'wexp') setSel({ kind: node.data.kind === 'task' ? 'task' : 'exp', id: node.data.expId });
                else if (node.type === 'wexpg') setSel({ kind: 'group', id: node.id, ids: node.data.ids });
                else if (node.data.origin) setSel({ kind: 'origin' });
                else if (node.data.ghost) setSel({ kind: 'ghost' });
                else setSel({ kind: 'wave', id: node.data.waveId });
              }}
              onPaneClick={() => setSel(null)}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              // The cards are the focusable, activatable things (role=button
              // above); react-flow's own node focus/selection would add a
              // second tab stop and a second, drifting selection state.
              nodesFocusable={false}
              elementsSelectable={false}
              edgesFocusable={false}
              zoomOnDoubleClick={false}
              zoomOnScroll={expanded}
              zoomOnPinch
              preventScrolling={expanded}
              minZoom={0.3}
              maxZoom={1.4}
            >
              <MeasureSync topologyKey={topologyKey} />
              <Background gap={22} size={1.1} />
            </ReactFlow>
          </div>
        </div>
        {sel && <PanelResizer />}
        {/* The shared drawer: slides in over the canvas, holds its content
            through the slide-out — the same one every graph sidebar rides. */}
        <GraphDrawer open={!!sel}>
          {sel && (
            <WaveFlowPanel
              sel={sel}
              braid={braid}
              waves={waves}
              experiments={experiments}
              tasks={tasks}
              signal={signal}
              project={project}
              onClose={() => setSel(null)}
              onOpenExp={openExp}
              onOpenTask={openTask}
              onOpenWave={openWave}
              onSelectNode={setSel}
            />
          )}
        </GraphDrawer>
        </div>
      </div>
    </FlowCtx.Provider>
  );
}
