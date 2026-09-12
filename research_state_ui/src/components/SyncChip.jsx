import { useProjectStore } from '../store/useProjectStore';
import { useNow } from '../store/useNow';

function fmtSyncedAgo(ms, now) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// Freshness of the project snapshot — dot + "synced Ns" — for the desktop
// sidebar and the mobile bar. Stale once a refresh fails or the backend has
// said nothing for 40 s (stream heartbeats come every 15 s); the 10 s tick
// keeps the label honest when nothing else re-renders.
export default function SyncChip({ className }) {
  const lastSyncedAt = useProjectStore(s => s.lastSyncedAt);
  const lastSyncError = useProjectStore(s => s.lastSyncError);
  const live = useProjectStore(s => s.streamHealthy || s.isPolling);
  const now = useNow(10000);
  const stale = Boolean(lastSyncError) || (lastSyncedAt && now - lastSyncedAt > 40000);
  return (
    <div className={className} aria-label={stale ? 'data stale' : 'data live'} title={lastSyncError || undefined}>
      <span className={'sync-dot' + (stale ? ' stale' : live ? '' : ' paused')} />
      {lastSyncError ? 'stale' : `synced ${fmtSyncedAgo(lastSyncedAt, now)}`}
    </div>
  );
}
