import { useEffect, useState } from 'react';
import { useTool } from '../api';
import { Listing, StatusPill, col } from '../components';
import type { ViewProps } from './index';

interface Mount {
  id: string;
  origin: string;
  state: 'connecting' | 'ready' | 'disconnected' | 'failed' | 'stopped';
  toolCount: number;
  errorCode?: string;
}

export function ConnectionsView({ row }: ViewProps) {
  // A mount that is still connecting is the only thing here that moves.
  const [cadence, setCadence] = useState(4000);
  const mounts = useTool<Mount[]>('ui.read', { rowId: row.id }, { every: cadence });
  const connecting = (mounts.data ?? []).some((mount) => mount.state === 'connecting');
  useEffect(() => setCadence(connecting ? 4000 : 15000), [connecting]);
  return (
    <div className="page-stage">
      <Listing
        load={mounts}
        rows={mounts.data ?? []}
        emptyTitle="No mounts configured"
        emptyHint="External services an operator mounts into this server appear here with their connection health."
        columns={[
          col<Mount>('id', 'Mount', (m) => <strong className="mono">_{m.id}</strong>),
          col<Mount>('state', 'State', (m) => <StatusPill value={m.state} />),
          col<Mount>('origin', 'Origin', (m) => <span className="mono faint">{m.origin}</span>),
          col<Mount>(
            'tools',
            'Tools',
            (m) => <span className="tabular">{m.toolCount}</span>,
            '70px',
          ),
          col<Mount>('error', 'Error', (m) =>
            m.errorCode ? (
              <span className="mono">{m.errorCode}</span>
            ) : (
              <span className="faint">—</span>
            ),
          ),
        ]}
      />
    </div>
  );
}
