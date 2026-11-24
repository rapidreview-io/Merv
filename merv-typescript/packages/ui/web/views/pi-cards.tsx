import { useNow } from '../components';
import type { PiCommand, PiHostView, PiModel } from '@merv/pi/models';
const label = (host: PiHostView | undefined, key: string) =>
  host?.catalog.find((machine) => machine.key === key)?.label ?? key;
/** How long the current wait has lasted by the server's clock, `skew` ms ahead of this one; a
 * screen reader hears only what is waited on. */
export function Seconds({ since, skew }: { since: string; skew: number }) {
  // Ticks each second; the clock is read as it draws, so a snapshot read between ticks (and
  // with it a new skew) never counts back a second.
  useNow(1000);
  return (
    <span className="tabular" aria-hidden="true">
      {` · ${Math.max(0, Math.floor((Date.now() + skew - Date.parse(since)) / 1000)) || 0} s`}
    </span>
  );
}

export function changed(all: PiCommand[], at: number, host?: PiHostView, models?: PiModel[]) {
  const since = (key: 'machine' | 'model') => {
    let before: string | undefined;
    for (let i = at - 1; i >= 0 && !before; i--) before = all[i][key];
    return before && all[at][key] !== before ? all[at][key] : undefined;
  };
  const [machine, model] = [since('machine'), since('model')];
  const words = [
    machine && `Moved to ${label(host, machine)}`,
    model && `Switched to ${models?.find(({ id }) => id === model)?.label ?? model}`,
  ].filter(Boolean);
  return (
    words.length > 0 && (
      <p className="pi-divider" key={`${all[at].id}-changed`}>
        {words.join(' · ')}
      </p>
    )
  );
}
