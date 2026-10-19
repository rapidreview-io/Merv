import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { accountRequest, useTool } from '../api';
import { EmptyState, Failure, LoadState, Ruled, col } from '../components';
import { Segments } from '../list-filters';
import { useCommand } from '../mutations';
import { usd } from './remote-fields';

type Mode = 'hosted' | 'own';
interface Provider {
  plugin: string;
  label: string;
  mode: Mode;
  /** Credit to rent the funded instance with; null where the account has none to rent. */
  hosted: { granted: string; left: string } | null;
  ownKey: boolean;
}
interface Compute {
  /** The top-ups on sale, in USD; none without payments. */
  topUps: number[];
  providers: Provider[];
}

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

function Credit({ provider, amounts }: { provider: Provider; amounts: number[] }) {
  const [adding, setAdding] = useState(false);
  // In own mode the mode control already says it is their key.
  if (provider.mode === 'own' && provider.hosted) return null;
  if (!provider.hosted)
    return provider.ownKey ? (
      <span>Your key</span>
    ) : (
      <Link to="/sandboxes/providers">Connect a key</Link>
    );
  const { left, granted } = provider.hosted;
  return (
    <span className="cluster">
      <span className="tabular">
        {usd(left)} of {usd(granted)}
      </span>
      {amounts.length > 0 &&
        (adding ? (
          <TopUp provider={provider.plugin} amounts={amounts} />
        ) : (
          <button type="button" className="btn-text" onClick={() => setAdding(true)}>
            Add credits
          </button>
        ))}
    </span>
  );
}

/** Per provider: hosted on Merv's credit, or the person's own key. */
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
  return (
    <div className="page-stage stack">
      <Ruled<Provider>
        label="Compute"
        template="minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr)"
        rows={providers}
        keyOf={(p) => p.plugin}
        columns={[
          col('label', 'Provider', (p) => <strong>{p.label}</strong>),
          col('mode', 'Mode', (p) =>
            p.hosted ? (
              <Segments<Mode>
                label={`${p.label} mode`}
                options={[
                  { value: 'hosted', label: 'Hosted' },
                  { value: 'own', label: 'Your key' },
                ]}
                value={p.mode}
                onChange={(next) =>
                  next !== p.mode && void mode.submit({ plugin: p.plugin, mode: next })
                }
              />
            ) : null,
          ),
          col('credit', 'Credit', (p) => <Credit provider={p} amounts={topUps} />),
        ]}
      />
      <Failure message={mode.error} />
    </div>
  );
}
