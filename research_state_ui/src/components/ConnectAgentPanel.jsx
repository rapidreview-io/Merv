import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjectStore, useProjectHref, selectProject } from '../store/useProjectStore';
import ConnectAgentWizard from './ConnectAgentWizard';
import { NATIVE_CLIENTS, OTHER_CLIENT_NAMES, CLIENT_DOCS_URL, ClientMark } from './connectClients';

/**
 * The two replayable entry points into the connect-your-agent guide:
 *
 * - ConnectAgentPanel: the first-run hero on Home. A brand-new project is an
 *   empty page with zero counts and nothing telling the user the next move is
 *   in a terminal, not here — so until something has happened, the guide is
 *   the page (the same call the Auto-run page makes for its no-machine state).
 * - ConnectAgentSettings: the Settings tab. Permanent home for replays —
 *   another client, another machine — plus the headless/CI pointer.
 */

function hideKey(projectId) {
  return `rsui:cnxHide:${projectId}`;
}

export default function ConnectAgentPanel({ project }) {
  const [wizardOpen, setWizardOpen] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(hideKey(project.id)) === '1';
    } catch {
      return false;
    }
  });

  if (hidden) return null;

  function hide() {
    try {
      localStorage.setItem(hideKey(project.id), '1');
    } catch { /* best-effort */ }
    setHidden(true);
  }

  return (
    <section className="section">
      <div className="card cnx-hero">
        <div className="page-eyebrow">First run</div>
        <h2 className="cnx-hero-title">Connect your coding agent</h2>
        <p className="cnx-hero-sub">
          Merv gives your agent a gated research workflow — plan, adversarial
          review, execute, reflect — and this page is where you watch it
          happen. Nothing lands here until an agent connects over MCP.
        </p>
        <div className="cnx-hero-steps">
          <span><b>1</b>Install its Merv plugin</span>
          <span><b>2</b>Sign in from the terminal</span>
          <span><b>3</b>Watch the first call land</span>
        </div>
        <div className="cnx-hero-row">
          <div className="cnx-marks-row" aria-hidden="true">
            {NATIVE_CLIENTS.map((c) => (
              <ClientMark key={c.id} client={c.id} />
            ))}
            <span className="cnx-marks-more">+ {OTHER_CLIENT_NAMES.length} more</span>
          </div>
          <div className="page-actions">
            <button type="button" className="btn btn--ghost" onClick={hide}>
              Hide — it stays in Settings
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setWizardOpen(true)}>
              Connect an agent
            </button>
          </div>
        </div>
      </div>
      {wizardOpen && (
        <ConnectAgentWizard
          projectId={project.id}
          projectName={project.name}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </section>
  );
}

export function ConnectAgentSettings({ projectId }) {
  const px = useProjectHref();
  const project = useProjectStore(selectProject);
  const [wizardClient, setWizardClient] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  function open(clientId) {
    setWizardClient(clientId);
    setWizardOpen(true);
  }

  return (
    <>
      <div className="settings-panel-head">
        <p className="settings-summary">
          Choose a client to connect.
        </p>
      </div>
      <div className="cnx-grid cnx-grid--settings">
        {NATIVE_CLIENTS.map((c) => (
          <button key={c.id} type="button" className="cnx-choice" onClick={() => open(c.id)}>
            <ClientMark client={c.id} />
            <span className="cnx-choice-title">{c.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="cnx-choice cnx-choice--wide"
          onClick={() => open('other')}
        >
          <ClientMark client="other" />
          <span className="cnx-choice-text">
            <span className="cnx-choice-title">Another client</span>
            <span className="cnx-choice-sub">
              {OTHER_CLIENT_NAMES.join(', ')}, headless runners, CI…
            </span>
          </span>
        </button>
      </div>
      <div className="settings-section">
        <div className="settings-section-head">
          <h3 className="settings-title">Headless & CI</h3>
        </div>
        <p className="settings-summary">
          Runners and CI cannot open a browser, so they authenticate with a
          static key from <Link to={px('/settings?tab=keys')}>MCP keys</Link>,
          exported as <code className="mono">MERV_MCP_KEY</code>. Per-client
          details for {OTHER_CLIENT_NAMES.join(', ')} live in the{' '}
          <a href={CLIENT_DOCS_URL} target="_blank" rel="noreferrer">
            client guide on GitHub
          </a>.
        </p>
      </div>
      {wizardOpen && (
        <ConnectAgentWizard
          projectId={projectId}
          projectName={project?.name}
          initialClient={wizardClient}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </>
  );
}
