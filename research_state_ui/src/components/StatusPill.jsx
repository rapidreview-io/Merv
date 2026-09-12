/**
 * Status pill. Maps every experiment/claim/review value to the
 * semantic colour family defined in global.css (.status.{token}).
 *
 * Accepts either a plain status ("running") or a nested status
 * ("submitting.acquiring_sandbox", "queued.waiting_sandbox"). For nested
 * values the head drives the colour and the tail renders as a faint suffix
 * inside the same pill — same shape as before, no extra chip.
 */
import { cx } from '../utils/format';
import { stateLabel, words } from '../utils/vocab';

export default function StatusPill({ value, pill = true }) {
  if (!value) return null;
  const [head, tail] = String(value).split(/\.(.*)/s);
  return (
    <span className={cx('status', pill && 'status--pill', head.toLowerCase())}>
      {stateLabel(head)}
      {tail && <span className="status-phase">{words(tail)}</span>}
    </span>
  );
}
