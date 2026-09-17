import { useTool } from '../api';
import { LoadState, StatusPill, Table, col } from '../components';
import type { ViewProps } from './index';

interface Mount {
  id: string;
  origin: string;
  state: 'connecting' | 'ready' | 'disconnected' | 'failed' | 'stopped';
  toolCount: number;
  errorCode?: string;
}

export function ConnectionsView({ row }: ViewProps) {
  const mounts = useTool<Mount[]>('ui.read', { rowId: row.id }, { every: 4000 });
  return (
    <div className="page-stage">
      <LoadState
        {...mounts}
        empty={mounts.data?.length === 0}
        columns={5}
        emptyTitle="No mounts configured"
        emptyHint="External services an operator mounts into this server appear here with their connection health."
      />
      {mounts.data && mounts.data.length > 0 && (
        <Table
          rows={mounts.data}
          keyOf={(m) => m.id}
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
      )}
    </div>
  );
}
