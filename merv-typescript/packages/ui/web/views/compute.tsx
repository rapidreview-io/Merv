import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { accountRequest, useTool } from '../api';
import { EmptyState, Failure, LoadState } from '../components';
import { Segments } from '../list-filters';
import { useCommand } from '../mutations';
import { usd } from './remote-fields';

type Mode = 'hosted' | 'own';
interface Provider {
  plugin: string;
  label: string;
  /** Null where the account cannot use the plugin yet: no credit for it, no key of its own. */
  mode: Mode | null;
  /** Merv's credit on the funded instance; null where Merv funds none. */
  hosted: { granted: string; left: string } | null;
  ownKey: boolean;
}
interface Compute {
  /** The top-ups on sale, in USD; none without payments. */
  topUps: number[];
  providers: Provider[];
}
type SetMode = (provider: Provider, mode: Mode) => void;

/** The four top-ups, each straight to its Stripe Checkout. */
function TopUp({ provider, amounts }: { provider: string; amounts: number[] }) {
  const buy = useCommand<{ url: string }>({
    tool: 'compute.checkout',
    send: (body) => accountRequest('/compute/checkout', { method: 'POST', body }),
    validate: (result) => typeof result?.url === 'string',
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <span className="cluster">
      {amounts.map((amountUsd) => (
        <button
          key={amountUsd}
          type="button"
          className="btn btn--sm"
          disabled={buy.busy}
          onClick={() => void buy.submit({ provider, amountUsd })}
        >
          {usd(amountUsd)}
        </button>
      ))}
      <Failure message={buy.error} />
    </span>
  );
}

/** One provider: its balance where Merv funds it, else greyed until the person brings a key. */
function Card({ p, amounts, setMode }: { p: Provider; amounts: number[]; setMode: SetMode }) {
  const [adding, setAdding] = useState(false);
  return (
    <li className="compute-card" data-off={p.mode ? undefined : ''}>
      <strong>{p.label}</strong>
      {p.hosted && (
        <span className="compute-balance">
          <span className="tabular">{usd(p.hosted.left)}</span>
          {Number(p.hosted.granted) > 0 && <small>of {usd(p.hosted.granted)}</small>}
        </span>
      )}
      <span className="compute-foot">
        {p.hosted &&
          amounts.length > 0 &&
          (adding ? (
            <TopUp provider={p.plugin} amounts={amounts} />
          ) : (
            <button type="button" className="btn-text" onClick={() => setAdding(true)}>
              Add credits
            </button>
          ))}
        {p.hosted && p.ownKey ? (
          <Segments<Mode>
            label={`${p.label} mode`}
            options={[
              { value: 'hosted', label: 'Hosted' },
              { value: 'own', label: 'Your key' },
            ]}
            value={p.mode ?? 'hosted'}
            onChange={(next) => next !== p.mode && setMode(p, next)}
          />
        ) : (
          <Link className="btn-text" to="/sandboxes/providers">
            Your key
          </Link>
        )}
      </span>
    </li>
  );
}

/** Every provider as a card: Merv's credit on the ones it funds, the person's own key on all. */
export function ComputeSettings() {
  // Back from Checkout, the webhook may land a moment after the person does.
  const paid = useLocation().search.includes('checkout=paid');
  const compute = useTool<Compute>('/compute', {}, { every: paid ? 3000 : undefined });
  const mode = useCommand<{ plugin: string; mode: Mode }>({
    tool: 'compute.mode',
    idempotent: true,
    send: ({ plugin, mode }) =>
      accountRequest(`/compute/${encodeURIComponent(String(plugin))}/mode`, {
        method: 'PUT',
        body: { mode },
      }),
    validate: (result) => typeof result?.mode === 'string',
    onSuccess: () => compute.reload(),
  });
  if (!compute.data) return <LoadState {...compute} />;
  const { providers, topUps } = compute.data;
  if (!providers.length)
    return (
      <div className="page-stage">
        <EmptyState kind="settings" icon="spend" title="No providers" />
      </div>
    );
  const setMode: SetMode = (p, next) => void mode.submit({ plugin: p.plugin, mode: next });
  return (
    <div className="page-stage stack">
      <ul className="compute-gallery" aria-label="Compute">
        {providers.map((p) => (
          <Card key={p.plugin} p={p} amounts={topUps} setMode={setMode} />
        ))}
      </ul>
      <Failure message={mode.error} />
    </div>
  );
}
