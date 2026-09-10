import { Link } from 'react-router-dom';
import { useProjectStore, projectPath } from '../store/useProjectStore';
import {
  FIGURE_GLYPH, FIGURE_STATUS_COLOR, KIND_NEUTRAL, figureStatusClass, kindColorMap,
} from '../utils/graphStatus';

/**
 * Shared graph-model helpers — normalize the figure and logic/reflection graph
 * payloads into the GraphOutline / GraphCanvasOverlay model, and the bottom-
 * sheet detail renderers. Used by the experiment graph section and the project
 * reflection card.
 */

export function normalizeFigure(figure) {
  const nodes = (figure?.nodes || []).map(n => {
    const sc = figureStatusClass(n);
    // The round qualifier rides in the sublabel on mobile ("round 3.1 ·
    // report"); anchor/lane pass through so the outline's reading order
    // follows the same timeline layout as the desktop canvas.
    const sublabel = [n.qualifier, n.sublabel].filter(Boolean).join(' · ');
    return {
      id: n.id, label: n.label, sublabel,
      kindLabel: String(n.type || '').replace(/_/g, ' '),
      color: FIGURE_STATUS_COLOR[sc], glyph: FIGURE_GLYPH[n.type] || '•',
      anchor: n.anchor, lane: n.lane,
      raw: n,
    };
  });
  const edges = (figure?.edges || []).map(e => ({ from: e.from, to: e.to, label: e.type }));
  return { nodes, edges };
}

export function normalizeLogic(graph) {
  const colors = kindColorMap(graph);
  const nodes = (graph?.nodes || []).map(n => {
    const k = String(n.kind || '').trim();
    return {
      id: n.id, label: n.label, sublabel: n.detail || '',
      kindLabel: k, color: colors.get(k) || KIND_NEUTRAL,
      glyph: String(n.status || '') === 'dead_end' ? '·' : '◆',
      raw: n,
    };
  });
  const edges = (graph?.edges || []).map(e => ({ from: e.from, to: e.to, label: e.label }));
  return { nodes, edges };
}

export function EdgeList({ outgoing, labelById }) {
  if (!outgoing || !outgoing.length) return null;
  return (
    <div className="gnode-edges">
      <div className="gnode-edges-head">leads to</div>
      {outgoing.map((e, i) => (
        <div key={i} className="gnode-edge">
          <span className="gnode-edge-arrow" aria-hidden="true">→</span>
          {e.label && <span className="gnode-edge-label">{e.label}</span>}
          <span className="gnode-edge-target">{labelById[e.to] || e.to}</span>
        </div>
      ))}
    </div>
  );
}

// Resolved node refs (logic graph) — same taxonomy as LogicGraph.NodeRef.
export function LogicRef({ refString, resolution }) {
  const r = resolution || { resolved: false, type: 'unknown' };
  if (r.type === 'artifact' && r.resolved) {
    return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, `/artifacts/${r.artifact_id}`)}>{r.role || 'artifact'} · {r.title || r.path} →</Link>;
  }
  if (r.type === 'claim' && r.resolved) {
    return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, `/claims/${r.claim_id}`)}>claim · {r.statement} →</Link>;
  }
  if (r.type === 'experiment' && r.resolved) {
    return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, `/experiments/${r.experiment_id}`)}>experiment · {r.intent} →</Link>;
  }
  if (r.type === 'review' && r.resolved) {
    return <span className="gnode-ref gnode-ref--static">review · {String(r.role || '').replace(/_/g, ' ')} · {r.verdict}</span>;
  }
  return <span className="gnode-ref gnode-ref--unresolved">{refString}</span>;
}

// Figure ref → detail-page link, mirroring FigurePanel's destinations.
export function figureRefLink(node) {
  const ref = node.ref || {};
  if (ref.kind === 'artifact' && ref.id) return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, `/artifacts/${ref.id}`)}>open artifact →</Link>;
  if (ref.kind === 'artifact_group') return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, '/artifacts')}>open artifacts →</Link>;
  if (ref.kind === 'claim' && ref.id) return <Link className="gnode-ref" to={projectPath(useProjectStore.getState().projectId, `/claims/${ref.id}`)}>open claim →</Link>;
  return null;
}

export function makeLogicDetail(refIndex) {
  return (node, ctx) => (
    <>
      <div className="gnode-meta">{String(node.kind || 'node').trim()}{node.status ? ` · ${node.status}` : ''}</div>
      {node.detail && <p className="gnode-detail">{node.detail}</p>}
      {Array.isArray(node.refs) && node.refs.filter(Boolean).map(r => (
        <LogicRef key={r} refString={r} resolution={refIndex[r]} />
      ))}
      <EdgeList outgoing={ctx.outgoing} labelById={ctx.labelById} />
    </>
  );
}

export function makeFigureDetail() {
  return (node, ctx) => (
    <>
      <div className="gnode-meta">{node.type}{node.status && node.status !== 'none' ? ` · ${node.status}` : ''}</div>
      {node.sublabel && <p className="gnode-detail">{node.sublabel}</p>}
      {figureRefLink(node)}
      <EdgeList outgoing={ctx.outgoing} labelById={ctx.labelById} />
    </>
  );
}
