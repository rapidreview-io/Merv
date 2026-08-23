import { useEffect, useRef } from 'react';
import { NODE_W, NODE_H, ATT_W, ATT_H } from './problemTreeModel.js';

/**
 * ProblemTreeFlow — the living tree as one plain SVG: problems as rounded
 * cards (status carried by outline + wash, the fig-node recipe), attempts as
 * small marks hanging beneath their problem — rect for an experiment, the
 * flowchart-preparation hexagon for a task, the same silhouettes the project
 * graph draws full-size. Wide trees scroll horizontally inside .ptree-scroll;
 * the page never scrolls sideways.
 *
 * Interaction: clicking a problem selects it (the panel renders the detail
 * below); clicking an attempt mark navigates straight to the experiment/task.
 * Keyboard: every node and mark is a tab stop, Enter/Space activates — the
 * same contract the react-flow canvases carry.
 */

// The task hexagon at badge size — same proportions as WaveFlow's TaskSwatch.
const HEX_PTS = '4.5,0.75 17.5,0.75 21.25,6 17.5,11.25 4.5,11.25 0.75,6';

// Vertical smoothstep-ish edge: a cubic that leaves the parent straight down
// and arrives at the child straight down — the tree reads as one flow.
function edgePath(e) {
  const midY = (e.y1 + e.y2) / 2;
  return `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`;
}

const keyActivate = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
};

const statusWord = (s) => String(s || '').replace(/_/g, ' ');

function AttemptMark({ a, onOpen }) {
  const tip = `${a.kind}: ${a.name} · ${statusWord(a.status)}${a.verdict ? ` · ${a.verdict}` : ''}`;
  return (
    <g
      className={`ptree-att ptree-att--${a.tone}`}
      transform={`translate(${a.x}, ${a.y})`}
      role="link"
      tabIndex={0}
      aria-label={tip}
      onClick={(e) => { e.stopPropagation(); onOpen(a); }}
      onKeyDown={keyActivate(() => onOpen(a))}
    >
      <title>{tip}</title>
      {a.kind === 'task'
        ? <polygon className="ptree-att-shape" points={HEX_PTS} />
        : <rect className="ptree-att-shape" width={ATT_W} height={ATT_H} rx="2.5" />}
    </g>
  );
}

function ProblemNode({ n, selected, onSelect, onOpenAttempt }) {
  const label = `${n.statement} — ${statusWord(n.status)}`;
  return (
    <g
      className={[
        'ptree-node',
        `ptree-node--${n.status}`,
        selected ? 'ptree-node--selected' : '',
      ].filter(Boolean).join(' ')}
      transform={`translate(${n.x}, ${n.y})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onSelect(n.id); }}
      onKeyDown={keyActivate(() => onSelect(n.id))}
    >
      <title>{label}</title>
      {/* Under the card: the frontier's slow pulse ring (open nodes only —
          CSS keeps it off elsewhere). */}
      <rect className="ptree-ring" width={NODE_W} height={NODE_H} rx="9" />
      <rect className="ptree-node-box" width={NODE_W} height={NODE_H} rx="9" />
      <foreignObject className="ptree-fo" x="10" y="6" width={NODE_W - 20} height={NODE_H - 12}>
        <div xmlns="http://www.w3.org/1999/xhtml" className="ptree-fo-wrap">
          <div className="ptree-statement">{n.statement}</div>
        </div>
      </foreignObject>
      {/* Live indicator: work is underway on this problem right now. */}
      {n.status === 'attempting' && (
        <circle className="ptree-live-dot" cx={NODE_W - 10} cy={10} r="3.5" />
      )}
      {n.attempts.map(a => (
        <AttemptMark key={a.id} a={a} onOpen={onOpenAttempt} />
      ))}
    </g>
  );
}

export default function ProblemTreeFlow({ model, selectedId, onSelect, onOpenAttempt }) {
  const scrollRef = useRef(null);
  const centeredWidth = useRef(0);
  const width = model?.width || 0;
  const rootX = model?.nodes?.find(n => n.isRoot)?.cx ?? width / 2;
  // A tree wider than the panel opens centered on the root, not on its own
  // left edge. Re-center only when the canvas width actually changes so a
  // poll tick never fights the reader's own scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !width || centeredWidth.current === width) return;
    centeredWidth.current = width;
    if (el.scrollWidth > el.clientWidth) {
      el.scrollLeft = Math.max(0, rootX - el.clientWidth / 2);
    }
  }, [width, rootX]);
  if (!model || !model.nodes.length) return null;
  return (
    <div className="ptree-scroll" ref={scrollRef}>
      <svg
        className="ptree-svg"
        width={model.width}
        height={model.height}
        viewBox={`0 0 ${model.width} ${model.height}`}
        role="group"
        aria-label="Problem tree"
        onClick={() => onSelect?.(null)}
      >
        {model.edges.map(e => (
          <path
            key={e.id}
            className={`ptree-edge${e.live ? ' ptree-edge--live' : ''}`}
            d={edgePath(e)}
          />
        ))}
        {model.nodes.map(n => (
          <ProblemNode
            key={n.id}
            n={n}
            selected={n.id === selectedId}
            onSelect={onSelect}
            onOpenAttempt={onOpenAttempt}
          />
        ))}
      </svg>
    </div>
  );
}
