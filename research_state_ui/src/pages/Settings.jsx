import { useSearchParams } from 'react-router-dom';
import { useProjectStore } from '../store/useProjectStore';
import { isAuthEnabled } from '../auth';
import AgentPlatforms from '../components/AgentPlatforms';
import { ConnectAgentSettings } from '../components/ConnectAgentPanel';
import HuggingFaceToken from '../components/HuggingFaceToken';
import McpKeys from '../components/McpKeys';
import ProviderConfig from '../components/ProviderConfig';

// Each tab owns one setup surface. `scope` is the honest reach of the panel.
// Connect-an-agent leads: it is the top of the funnel and the tab a first
// visit should land on; the Hugging Face token is the one per-account panel.
const TABS = [
  { id: 'connect', label: 'Connect an agent', scope: 'This machine + your agent' },
  { id: 'keys', label: 'MCP keys', scope: 'This project' },
  { id: 'auto', label: 'Auto running', scope: 'This project + a runner machine' },
  { id: 'compute', label: 'Compute', scope: 'This project' },
  { id: 'huggingface', label: 'Hugging Face', scope: 'Your account' },
];

/**
 * Project settings, one concern per tab.
 *
 * The active tab lives in the query string so a panel is linkable and survives
 * a refresh; an unknown value falls back to the first tab rather than rendering
 * nothing. The tab label is the panel's title — panels do not repeat it.
 */
export default function Settings() {
  const projectId = useProjectStore((s) => s.projectId);
  const hosted = isAuthEnabled();
  const [params, setParams] = useSearchParams();

  const requested = params.get('tab');
  const active = TABS.some((tab) => tab.id === requested) ? requested : TABS[0].id;
  const current = TABS.find((tab) => tab.id === active);

  function select(id) {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  }

  return (
    <div className="page-stage">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-summary page-summary--lead">
          Connect clients, run agents automatically, and manage the credentials
          Merv uses on your behalf.
        </p>
        <div className="settings-tabs">
          <div className="settings-tab-row" role="tablist" aria-label="Settings sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                id={`settings-tab-${tab.id}`}
                role="tab"
                aria-selected={tab.id === active}
                aria-controls="settings-panel"
                className={`settings-tab${tab.id === active ? ' active' : ''}`}
                onClick={() => select(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="settings-tabs-scope">{current.scope}</span>
        </div>
      </div>

      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${active}`}
        className="settings-panel"
      >
        {active === 'connect' && <ConnectAgentSettings projectId={projectId} />}
        {active === 'keys' && <McpKeys projectId={projectId} hosted={hosted} />}
        {active === 'auto' && <AgentPlatforms projectId={projectId} />}
        {active === 'compute' && <ProviderConfig projectId={projectId} />}
        {active === 'huggingface' && <HuggingFaceToken hosted={hosted} />}
      </div>
    </div>
  );
}
