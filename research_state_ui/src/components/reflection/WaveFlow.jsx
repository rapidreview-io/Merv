import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ReactFlow, Background, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MeasureSync } from '../ExperimentFigure';
import { useProjectHref } from '../../store/useProjectStore';
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
// Fraction of the drawer width the canvas shifts by — must match the CSS
// `.wflow--panel-open .wflow-shift` translate.
const SHIFT_RATIO = 0.45;
const expX = (c) => X0 + (c + 1) * STEP;
const reflX = (i) => X0 + i * STEP + EXP_W + REFL_GAP;

const statusWord = (s) => String(s || '').replace(/_/g, ' ') || '—';

// Lifecycle tone → the figure graph's status-tint vocabulary (fig-st--*).
// Queued work stays neutral: no tint is what "not judged yet" looks like.
const FIG_ST = { done: 'done', failed: 'failed', live: 'open', abandoned: 'faded' };

// Coarse human duration — the experiments-map register ("4d 15h", "34m").
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// Card metadata line: duration (elapsed for live work, span for finished),
// then claim/artifact counts when there are any.
function expMetaLine(data) {
  const parts = [];
  const t0 = data.createdAt ? Date.parse(data.createdAt) : NaN;
  const t1 = data.tone === 'live'
    ? Date.now()
    : (data.updatedAt ? Date.parse(data.updatedAt) : NaN);
  const dur = fmtDur(t1 - t0);
  if (dur && dur !== '<1m') parts.push(dur);
  if (data.nClaims) parts.push(`${data.nClaims} claim${data.nClaims > 1 ? 's' : ''}`);
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
          name: s.name,
          tone: s.tone,
          sub: statusWord(s.status)
            + (s.attemptIndex > 1 ? ` · attempt ${s.attemptIndex}` : ''),
          createdAt: s.createdAt || null,
          updatedAt: meta.updatedAt || null,
          nArt: meta.nArt || 0,
          nClaims: meta.nClaims || 0,
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
const FlowCtx = createContext({ sel: null, selectedId: null, currentId: null });

function ExpNode({ data }) {
  const { sel } = useContext(FlowCtx);
  const selected = sel?.kind === 'exp' && sel.id === data.expId;
  const figSt = FIG_ST[data.tone];
  return (
    <div
      className={[
        'fig-node', 'wflow-fig', 'fig-node--experiment',
        figSt ? `fig-st--${figSt}` : '',
        selected ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      title={`${data.name} · ${data.sub}`}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">◈</span>
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
  const { sel } = useContext(FlowCtx);
  const selected = (sel?.kind === 'group' && sel.id === id)
    || (sel?.kind === 'exp' && data.ids.includes(sel.id));
  return (
    <div
      className={[
        'fig-node', 'wflow-fig', 'fig-node--experiment', 'wflow-fig--group',
        'fig-st--failed',
        selected ? 'fig-node--selected' : '',
      ].filter(Boolean).join(' ')}
      title={data.sub}
    >
      <Handle type="target" position={Position.Left} className="fig-handle" />
      <div className="fig-node-head">
        <span className="fig-node-glyph" aria-hidden="true">⧉</span>
        <span className="fig-node-type">{data.count} experiments</span>
      </div>
      <div className="fig-node-label">{data.label}</div>
      <div className="fig-node-sub">{data.sub}</div>
      <Handle type="source" position={Position.Right} className="fig-handle" />
    </div>
  );
}

function ReflNode({ data }) {
  const { sel } = useContext(FlowCtx);
  const selected = data.origin
    ? sel?.kind === 'origin'
    : data.ghost
      ? sel?.kind === 'ghost'
      : sel?.kind === 'wave' && sel.id === data.waveId;
  const kind = data.origin
    ? 'origin'
    : data.ghost ? 'ghost' : (data.isOpen ? 'open' : 'published');
  return (
    <div
      className={`wflow-refl wflow-refl--${kind}${selected ? ' wflow-node--selected' : ''}`}
      title={data.title}
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
  waves, experiments, signal, project, onSelect, height = 420,
}) {
  const px = useProjectHref();
  const navigate = useNavigate();
  const [sel, setSel] = useState(null); // {kind: 'exp'|'wave'|'ghost', id?}
  const [expanded, setExpanded] = useState(false);
  // Hold the last selection through the drawer's slide-out so its content
  // doesn't vanish mid-animation.
  const heldRef = useRef(null);
  if (sel) heldRef.current = sel;
  const shown = sel || heldRef.current;
  // Identity discipline: rebuild braid/node objects only when the underlying
  // facts change, not on every poll tick or store-array replacement.
  const braidJson = useMemo(
    () => JSON.stringify(buildBraid(waves, experiments)),
    [waves, experiments],
  );
  const braid = useMemo(() => JSON.parse(braidJson), [braidJson]);
  // Card metadata from the live rows, JSON-keyed for the same identity
  // discipline (store arrays are replaced every poll tick).
  const expMetaJson = useMemo(() => JSON.stringify(Object.fromEntries(
    (experiments || []).map(e => [e.id, {
      updatedAt: e.updated_at || null,
      nArt: (e.artifacts || []).length,
      nClaims: (e.tested_claims || []).length,
    }]),
  )), [experiments]);
  const expMeta = useMemo(() => JSON.parse(expMetaJson), [expMetaJson]);
  const { nodes, edges } = useMemo(
    () => buildFlowModel(braid, signal, expMeta),
    [braid, signal, expMeta],
  );
  const topologyKey = useMemo(() => nodes.map(n => n.id).sort().join('|'), [nodes]);
  const rfRef = useRef(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // Keep the selected node in focus: the shift + drawer cover the right part
  // of the canvas, so if the selected node falls outside the still-visible
  // band, pan the viewport (never zoom) until it sits in the band's middle.
  // Exposed as a callback because a late fitView (measure pass, container
  // resize) can silently undo an earlier pan — every fit re-runs it.
  const selRef = useRef(null);
  selRef.current = sel;
  // Deterministic fit from DOM-measured canvas size. react-flow's own
  // fitView reads dimensions fed by a ResizeObserver→rAF pipeline that
  // starves in hidden documents, so it can fit against a stale size; the
  // DOM's clientWidth/Height never lies.
  const fitCanvas = useCallback((maxZoom = 1) => {
    const rf = rfRef.current;
    const el = shiftRef.current;
    const ns = nodesRef.current;
    if (!rf || !el || !ns.length) return;
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
  const ensureSelVisible = useCallback(() => {
    const s = selRef.current;
    const rf = rfRef.current;
    const wrap = shiftRef.current;
    const drawer = drawerRef.current;
    if (!s || !rf || !wrap || !drawer) return;
    const id = s.kind === 'exp' ? `e:${s.id}`
      : s.kind === 'group' ? s.id
        : s.kind === 'wave' ? `w:${s.id}`
          : s.kind === 'origin' ? 'w:origin' : 'w:next';
    let node = nodesRef.current.find(n => n.id === id);
    // A dead experiment may live inside a stack — focus the stack instead.
    if (!node && s.kind === 'exp') {
      node = nodesRef.current.find(n => n.type === 'wexpg' && n.data.ids.includes(s.id));
    }
    if (!node) return;
    const { x: vx, y: vy, zoom } = rf.getViewport();
    const W = wrap.clientWidth;
    const D = drawer.offsetWidth;
    const shift = D * SHIFT_RATIO;
    const nodeW = node.type === 'wrefl' ? REFL_W : EXP_W;
    const cx = (node.position.x + nodeW / 2) * zoom + vx;
    const margin = 30;
    const lo = shift + margin + nodeW / 2;
    const hi = W - D + shift - margin - nodeW / 2;
    if (cx >= lo && cx <= hi) return;
    // Minimal pan: just bring the node inside the band's nearest edge —
    // no dramatic recentering.
    const targetCx = cx < lo ? lo : hi;
    rf.setViewport(
      { x: vx + (targetCx - cx), y: vy, zoom },
      { duration: document.hidden ? 0 : 250 },
    );
  }, []);

  useEffect(() => {
    // 350ms lands after MeasureSync's second pass (same timing as Figure).
    const t = setTimeout(() => {
      fitCanvas(1);
      ensureSelVisible();
    }, 350);
    return () => clearTimeout(t);
  }, [topologyKey, fitCanvas, ensureSelVisible]);
  // The drawer never resizes the canvas — the graph SHIFTS aside (pure
  // transform, no react-flow re-layout) — so there is no refit on open/close.
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
  // Fullscreen: lock page scroll while expanded, and refit after the canvas
  // takes its new size (this one IS a real resize, unlike the drawer).
  useEffect(() => {
    if (!expanded) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [expanded]);
  useEffect(() => {
    const t = setTimeout(() => {
      fitCanvas(expanded ? 1.15 : 1);
      ensureSelVisible();
    }, 120);
    return () => clearTimeout(t);
  }, [expanded, fitCanvas, ensureSelVisible]);
  // Hidden documents never advance the animation timeline (background tabs,
  // headless previews — the MeasureSync problem, transition edition), which
  // would leave the drawer frozen off-screen forever. Nobody can see a hidden
  // page animate, so snap its transitions straight to their end state.
  const drawerRef = useRef(null);
  const shiftRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!document.hidden) return;
      [drawerRef.current, shiftRef.current].forEach(el => {
        el?.getAnimations().forEach(a => { try { a.finish(); } catch { /* infinite anims */ } });
      });
    }, 30);
    return () => clearTimeout(t);
  }, [sel]);
  // Focus on select: once as the drawer opens, and again late — a measure
  // pass or container resize can re-fit the canvas and undo the first pan.
  useEffect(() => {
    if (!sel) return undefined;
    const t1 = setTimeout(ensureSelVisible, 60);
    const t2 = setTimeout(ensureSelVisible, 600);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [sel, ensureSelVisible]);
  // Save the viewport when the drawer opens; restore it when the drawer
  // closes, so closing puts the graph back exactly where it was. Selection
  // hops while open don't re-save — the anchor is the pre-open state.
  const savedVpRef = useRef(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = Boolean(sel);
    if (isOpen && !wasOpenRef.current) {
      savedVpRef.current = rfRef.current?.getViewport() || null;
    } else if (!isOpen && wasOpenRef.current && savedVpRef.current) {
      rfRef.current?.setViewport(savedVpRef.current, { duration: document.hidden ? 0 : 250 });
      savedVpRef.current = null;
    }
    wasOpenRef.current = isOpen;
  }, [sel]);

  const openExp = useCallback(
    (id) => navigate(px(`/experiments/${id}`)),
    [navigate, px],
  );
  // A wave id opens that wave's page; null (the ghost) is the caller's call —
  // Home sends it to the reflection list.
  const openWave = useCallback(
    (id) => onSelect?.(id ?? null),
    [onSelect],
  );

  const ctx = useMemo(() => ({ sel }), [sel]);

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
    const need = Math.max(340, Math.round((maxY - minY) * zoom * 1.25 + 60));
    return `min(${need}px, ${typeof height === 'number' ? `${height}px` : height})`;
  }, [nodes, height]);

  if (!nodes.length) return null;
  return (
    <FlowCtx.Provider value={ctx}>
      {expanded && (
        <div className="fig-backdrop" onClick={() => setExpanded(false)} aria-hidden="true" />
      )}
      <div
        className={`wflow${sel ? ' wflow--panel-open' : ''}${expanded ? ' wflow--expanded' : ''}`}
        style={{ height: expanded ? undefined : cssHeight }}
      >
        {/* The graph shifts aside for the drawer — a pure transform, so the
            canvas never resizes and react-flow never re-lays-out. */}
        <div className="wflow-shift" ref={shiftRef}>
          <div className="wflow-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={inst => { rfRef.current = inst; }}
              onNodeClick={(event, node) => {
                event.stopPropagation();
                if (node.type === 'wexp') setSel({ kind: 'exp', id: node.data.expId });
                else if (node.type === 'wexpg') setSel({ kind: 'group', id: node.id, ids: node.data.ids });
                else if (node.data.origin) setSel({ kind: 'origin' });
                else if (node.data.ghost) setSel({ kind: 'ghost' });
                else setSel({ kind: 'wave', id: node.data.waveId });
              }}
              onPaneClick={() => setSel(null)}
              // Programmatic moves (a late fit, a resize refit) can undo the
              // focus pan — re-ensure after any move that has no user event.
              // Converges: once the node is in the visible band, ensure is a
              // no-op. User drags (event present) are never fought.
              onMoveEnd={(event) => { if (!event && selRef.current) ensureSelVisible(); }}
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
              maxZoom={1.4}
            >
              <MeasureSync topologyKey={topologyKey} />
              <Background gap={22} size={1.1} />
            </ReactFlow>
          </div>
        </div>
        <div className="wflow-legend">
          <span className="fig-chip fig-st--done">done</span>
          <span className="fig-chip fig-st--open">running</span>
          <span className="fig-chip wflow-chip--failed">failed</span>
          <span className="fig-chip wflow-chip--refl">reflection</span>
          <span className="fig-chip wflow-chip--pending">not yet consolidated</span>
        </div>
        <button
          type="button"
          className="fig-expand-btn wflow-expand"
          onClick={() => setExpanded(v => !v)}
          aria-label={expanded ? 'Exit fullscreen' : 'Fullscreen graph'}
        >
          {expanded ? '✕ Close' : '⤢ Expand'}
        </button>
        {/* Full-viewport-height drawer, the experiment-UI sidebar experience:
            slides in over the page; content held through the slide-out. */}
        <div className={`wflow-drawer${sel ? ' wflow-drawer--open' : ''}`} aria-hidden={!sel} ref={drawerRef}>
          {shown && (
            <WaveFlowPanel
              sel={shown}
              braid={braid}
              waves={waves}
              experiments={experiments}
              signal={signal}
              project={project}
              onClose={() => setSel(null)}
              onOpenExp={openExp}
              onOpenWave={openWave}
              onSelectNode={setSel}
            />
          )}
        </div>
      </div>
    </FlowCtx.Provider>
  );
}
