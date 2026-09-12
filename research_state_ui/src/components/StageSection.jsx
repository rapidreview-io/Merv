import { useState } from 'react';
import FSMStrip from './FSMStrip';
import GateBanner from './GateBanner';
import { DetailsButton } from './DetailsDrawer';

/**
 * The stage block a record page opens with: the lifecycle strip whose
 * current step discloses the gate panel (the agent's move, your transitions),
 * the Details button beside it, and the last action error under both. A
 * closed record gets no panel — the strip already says it.
 *
 *   strip    FSMStrip props beyond `status` (stages, gateStates, terminal, ariaLabel)
 *   gate     GateBanner props
 *   details  DetailsButton props
 */
export default function StageSection({ status, closed, strip, gate, details, actionError }) {
  const [gateOpen, setGateOpen] = useState(false);
  return (
    <section className="exp-fsm">
      <div className="fsm-row">
        <div className="fsm-row-strip">
          <FSMStrip
            status={status}
            {...strip}
            badge={!closed && gate.primaryAction ? 'action' : null}
            expanded={!closed && gateOpen}
            onToggle={closed ? null : () => setGateOpen(v => !v)}
          >
            <div className="fsm-gate-panel"><GateBanner {...gate} /></div>
          </FSMStrip>
        </div>
        <DetailsButton {...details} />
      </div>
      {actionError && <div className="error-message">{actionError}</div>}
    </section>
  );
}
