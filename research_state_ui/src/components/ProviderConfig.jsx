import { useEffect, useState } from 'react';
import { api } from '../api';
import ProviderIcon from './ProviderIcon';

export default function ProviderConfig({ projectId }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setOverview(null);
    setError(null);
    api.listSandboxProviders(projectId).then(
      (value) => { if (active) setOverview(value); },
      (failure) => { if (active) setError(failure.message); },
    );
    return () => { active = false; };
  }, [projectId]);

  if (error) return <div className="error-message">{error}</div>;
  if (!overview) return <div className="empty">Loading…</div>;

  return (
    <div className="sbxp">
      <p className="sbxp-lede">
        Manage providers, spending limits, and application access in merv-sandboxes.
        Merv uses the infrastructure authorized for this project.
      </p>
      {overview.management_url && (
        <p><a href={overview.management_url} target="_blank" rel="noreferrer">
          Open infrastructure settings ↗
        </a></p>
      )}
      {!overview.configured && <p>No infrastructure connection is configured for this project.</p>}
      <div className="sbxp-grid">
        {overview.providers.map((provider) => (
          <div className="sbxp-card" key={provider.provider}>
            <div className="sbxp-title">
              <ProviderIcon provider={provider.plugin} />
              <span className="sbxp-name">{provider.label}</span>
            </div>
            <p>{provider.health.status || 'Health unavailable'}</p>
            {provider.health.message && <p>{provider.health.message}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
