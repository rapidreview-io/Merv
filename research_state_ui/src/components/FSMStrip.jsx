/**
 * FSMStrip — experiment lifecycle pill row for the lean v0.0001 backend.
 *
 *   planned → design_review → running → experiment_review → complete
 *
 * `failed` and `abandoned` are terminal exits and rendered on the last cell.
 *
 * The strip is the page's single source of stage truth. On the experiment
 * detail page the current step doubles as the gate disclosure: pass
 * `onToggle` to make it a button (with a chevron, `expanded` state, and an
 * optional `badge` like "action" when a manual transition is waiting), and
 * render the gate panel as `children` — it appears attached under the strip.
 */

import { stateLabel } from '../utils/vocab';

// Stage rows for any lifecycle: ids in order, labels from the one vocabulary.
export const stageRows = (...ids) => ids.map(id => ({ id, label: stateLabel(id) }));

const STAGES = stageRows('planned', 'design_review', 'running', 'experiment_review', 'complete');

const GATE_STATES = new Set(['design_review', 'experiment_review']);
const TERMINAL = new Set(['complete', 'failed', 'abandoned']);

// The reflection-wave lifecycle, renderable through the
// same strip: pass stages={REFLECTION_STAGES} gateStates={REFLECTION_GATES}.
export const REFLECTION_STAGES = stageRows('reflecting', 'synthesizing', 'reflection_review', 'consolidating', 'published');
export const REFLECTION_GATES = new Set(['reflection_review', 'consolidating']);
export const REFLECTION_TERMINAL = new Set(['published', 'abandoned']);

export default function FSMStrip({
  status, badge = null, expanded = false, onToggle = null, children = null,
  stages = STAGES, gateStates = GATE_STATES, terminal = TERMINAL,
  ariaLabel = 'Experiment lifecycle',
}) {
  const STAGES_LIST = stages;
  const GATE_SET = gateStates;
  const TERMINAL_SET = terminal;
  const s = String(status || '').toLowerCase();
  const isFailed = (s === 'failed' || s === 'abandoned') && !STAGES_LIST.some(x => x.id === s);
  // Historical Ready snapshots now sit at the execution boundary.
  const stageId = stages === STAGES && s === 'ready_to_run' ? 'running' : s;
  const currentIdx = STAGES_LIST.findIndex(x => x.id === stageId);
  const idx = currentIdx >= 0 ? currentIdx : 0;

  return (
    <div className="fsm-strip-wrap">
      <ol className="fsm-strip" aria-label={ariaLabel}>
        {STAGES_LIST.map((stage, i) => {
          let state;
          if (isFailed) {
            state = i < STAGES_LIST.length - 1 ? 'past' : 'failed';
          } else if (i < idx) {
            state = 'past';
          } else if (i === idx) {
            state = GATE_SET.has(stage.id) ? 'gate' : 'current';
          } else {
            state = 'future';
          }
          const isCurrent = i === idx && !isFailed;
          const sub =
            i === idx && !TERMINAL_SET.has(s)
              ? state === 'gate' ? 'awaiting review' : 'in progress'
              : null;
          const label = state === 'failed' ? stateLabel(isFailed ? s : 'failed') : stage.label;
          const head = (
            <span className="fsm-step-head">
              <span className="fsm-step-dot" />
              <span className="fsm-step-label">{label}</span>
              {isCurrent && badge && <span className="fsm-step-badge">{badge}</span>}
              {isCurrent && onToggle && (
                <span className="fsm-step-twist" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              )}
            </span>
          );
          return (
            <li key={stage.id} className={`fsm-step fsm-step--${state}`}>
              {isCurrent && onToggle ? (
                <button type="button" className="fsm-step-toggle" onClick={onToggle} aria-expanded={expanded}>
                  {head}
                  {sub && <span className="fsm-step-sub">{sub}</span>}
                </button>
              ) : (
                <>
                  {head}
                  {sub && <span className="fsm-step-sub">{sub}</span>}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {expanded && children}
    </div>
  );
}
