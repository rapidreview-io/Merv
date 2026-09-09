import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * SandboxRetentionDetailsModal - minimal drill-in for one sandbox's retention
 * paths. Signal only: status, what should be kept where, and the sandbox id.
 *
 * The brain does not choose a copy-out destination. The caller copies selected
 * light outputs over SSH to a path it chooses, submits gated evidence with
 * artifact.upload, and uses storage.submit for heavy durable outputs.
 */

const STATUS_KIND = {
  running: 'active',
  provisioning: 'pending',
  terminated: 'idle',
  failed: 'error',
  none: 'pending',
};

// Friendly dir label -> chip color.
const DIR_CHIP = { workspace: 'workspace', 'copy-out': 'local', scratch: 'scratch' };

export default function SandboxRetentionDetailsModal({
  open,
  onClose,
  title,
  sandbox,
  now = Date.now(),
}) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !sandbox) return null;

  const status = sandbox.status || 'none';
  const statusKind = STATUS_KIND[status] || 'pending';

  const remoteDir = stripSlash(sandbox.sync_dir || sandbox.experiment_dir || sandbox.workdir || '');
  const dataDir = stripSlash(sandbox.sandbox_data_dir || sandbox.unsynced_dir || '/workspace/data');
  const expiryLabel = sandbox.expires_at ? fmtUntil(sandbox.expires_at, now) : 'not set';

  const body = (
    <div className="retention-modal-overlay" onMouseDown={onClose}>
      <div
        className="retention-modal retention-modal--min"
        role="dialog"
        aria-modal="true"
        aria-label="Sandbox retention"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="retention-modal-head">
          <div className="retention-modal-head-main">
            <span className={`retention-modal-pill retention-modal-pill--${statusKind}`}>{status}</span>
            <h2 className="retention-modal-title">Retain</h2>
          </div>
          <button type="button" className="retention-modal-close" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>

        {title && (
          <p className="retention-modal-sub" title={title}>
            {title}
          </p>
        )}

        <div className="retention-modal-dirs">
          <DirRow label="workspace" remote={remoteDir} />
          <DirRow label="copy-out" remote="caller-chosen destination" />
          <DirRow label="scratch" remote={dataDir} />
        </div>

        <p className="retention-modal-sub">
          Pull selected light files before release, then use artifact.upload
          for gated evidence or storage.submit for heavy durable outputs.
        </p>

        <div className="retention-modal-status">
          <span>expires {expiryLabel}</span>
        </div>

        <div className="retention-modal-min-foot">
          <span className="mono">{sandbox.sandbox_id || '-'}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

// --- presentational --------------------------------------------------------

function DirRow({ label, remote }) {
  return (
    <div className="retention-modal-dir">
      <span className={`retention-modal-chip retention-modal-chip--${DIR_CHIP[label]}`}>{label}</span>
      <div className="retention-modal-dir-paths">
        <span className="retention-modal-dir-path" title={remote}>
          {shortenPath(remote)}
        </span>
      </div>
    </div>
  );
}

// --- value helpers ---------------------------------------------------------

function stripSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

// Show only the meaningful tail of a long absolute path (full path on hover).
function shortenPath(p, segs = 3) {
  const parts = stripSlash(p).split('/').filter(Boolean);
  if (parts.length <= segs) return p;
  return '.../' + parts.slice(-segs).join('/');
}

function fmtUntil(iso, now) {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'unknown';
  const s = Math.max(0, Math.floor((ts - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
