import { PANEL_MIN, usePanelWidth } from '../store/usePanelWidth';

/**
 * The shared frame for a graph-node detail sidebar: identity, status, and the
 * close button, over a scrolling body.
 *
 * Every graph sidebar in the app wears this — the experiment figure, the logic
 * graph, the wave process figure, and the project braid's five panel bodies.
 * The bodies keep their separate data models; only the chrome is shared.
 *
 * The header is sticky so the close button is reachable no matter how far the
 * body has scrolled: these panels render real file content and run long, and
 * the close control used to scroll away with everything else.
 */
export default function DetailPanelShell({ typeLabel, title, status = null, onClose, children }) {
  return (
    <aside className="fig-panel">
      <div className="fig-panel-head">
        <span className="fig-panel-type">{typeLabel}</span>
        {status ? <span className="fig-panel-head-status">{status}</span> : null}
        <button
          type="button"
          className="fig-panel-close"
          onClick={onClose}
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>
      <div className="fig-panel-body">
        <div className="fig-panel-title">{title}</div>
        {children}
      </div>
    </aside>
  );
}

/**
 * The drag handle straddling the canvas/sidebar seam. Split out because all
 * five graphs mount one and it carries real ARIA: it announces an adjustable
 * separator, so it has to be focusable and operable from the keyboard too.
 */
export function PanelResizer() {
  const { width, nudge, startResize } = usePanelWidth();
  const onKeyDown = (e) => {
    // The sidebar is the RIGHT column, so it widens as the handle moves left.
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(-step); }
    else if (e.key === 'Home') { e.preventDefault(); nudge(PANEL_MIN - width); }
  };
  return (
    <div
      className="fig-resizer"
      onPointerDown={startResize}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={Math.round(width)}
      aria-valuemin={PANEL_MIN}
    />
  );
}
