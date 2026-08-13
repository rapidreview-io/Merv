import { useEffect, useMemo, useState } from 'react';
import {
  useProjectStore,
  selectSandboxes,
  selectExperiments,
} from '../store/useProjectStore';
import { expName } from '../utils/experiment';
import SandboxRetentionDetailsModal from './SandboxRetentionDetailsModal';

/**
 * SandboxRetentionIndicator - ambient, per-sandbox output-retention status.
 *
 * Sandboxes are ephemeral SSH workspaces. The backend no longer copies VM
 * files back to the checkout, so this card only highlights live VMs whose
 * outputs must be retained manually before release.
 */

const ACTIVE_STATUSES = new Set(['running', 'provisioning']);

export default function SandboxRetentionIndicator() {
  const sandboxes = useProjectStore(selectSandboxes);
  const experiments = useProjectStore(selectExperiments);

  const [now, setNow] = useState(Date.now());
  const [detailKey, setDetailKey] = useState(null);

  // 1Hz tick for expiry labels.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const titleFor = useMemo(() => {
    const map = {};
    for (const e of experiments) map[e.id] = expName(e);
    return (eid) => map[eid] || eid;
  }, [experiments]);

  // Active sandboxes (running first, then provisioning), most-recent first within.
  const rows = useMemo(() => {
    const active = (sandboxes || []).filter((s) => ACTIVE_STATUSES.has(s.status));
    const rank = (st) => (st === 'running' ? 0 : st === 'provisioning' ? 1 : 2);
    return active
      .slice()
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
      )
      .map((s) => deriveRow(s, titleFor(s.experiment_id), now));
  }, [sandboxes, titleFor, now]);

  const runningCount = rows.filter((r) => r.status === 'running').length;

  const detailSandbox = detailKey
    ? (sandboxes || []).find((s) => sandboxKey(s) === detailKey) || null
    : null;
  const detailTitle = detailSandbox
    ? titleFor(detailSandbox.experiment_id) || sandboxLabel(detailSandbox)
    : '';

  // Retention is an alert, not permanent navigation. Keep the quiet sidebar
  // free of an idle card and surface this block only when action may be needed.
  if (rows.length === 0) return null;

  return (
    <div className="retention" aria-label="Sandbox retention status">
      <div className="retention-row retention-row--head">
        <span className="retention-title">retain</span>
        <span className="retention-status">
          {runningCount > 0 ? `${runningCount} running` : `${rows.length} provisioning`}
        </span>
      </div>

      <div className="retention-exp-list">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            className="retention-exp-row"
            onClick={() => setDetailKey(r.key)}
            title={`${r.title} - view retention details`}
          >
            <span className={r.dotClass} aria-hidden="true" />
            <span className="retention-exp-title">{r.title}</span>
            <span className="retention-exp-meta">{r.metaLabel}</span>
          </button>
        ))}
      </div>

      <div className="retention-row retention-row--hint">manual copy-out only</div>

      <SandboxRetentionDetailsModal
        open={Boolean(detailKey && detailSandbox)}
        onClose={() => setDetailKey(null)}
        title={detailTitle}
        sandbox={detailSandbox}
        now={now}
      />
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function deriveRow(sandbox, title, now) {
  const status = sandbox.status;
  const key = sandboxKey(sandbox);
  const label = title || sandboxLabel(sandbox);

  let dotClass = 'retention-dot retention-dot--idle';
  let metaLabel = 'retain outputs';

  if (status === 'provisioning') {
    dotClass = 'retention-dot retention-dot--pending';
    metaLabel = 'provisioning';
  } else if (sandbox.expires_at) {
    metaLabel = `expires ${fmtUntil(sandbox.expires_at, now)}`;
  }

  return { key, status, title: label, dotClass, metaLabel };
}

function sandboxKey(sandbox) {
  return sandbox.sandbox_uid || sandbox.experiment_id || sandbox.sandbox_id || 'sandbox';
}

function sandboxLabel(sandbox) {
  const uid = sandbox.sandbox_uid || sandbox.sandbox_id || '';
  return uid ? `sandbox ${String(uid).slice(0, 12)}` : 'sandbox';
}

function fmtUntil(iso, now) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'soon';
  const s = Math.max(0, Math.floor((ts - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
