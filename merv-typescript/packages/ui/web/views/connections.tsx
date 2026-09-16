import { useTool } from '../api';
import { LoadState, StatusPill, Table } from '../components';
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
        loading={mounts.loading}
        error={mounts.error}
        empty={mounts.data?.length === 0}
        emptyTitle="No mounts configured"
        emptyHint="External services an operator mounts into this server appear here with their connection health."
      />
      {mounts.data && mounts.data.length > 0 && (
        <Table
          rows={mounts.data}
          keyOf={(m) => m.id}
          columns={[
            { key: 'id', label: 'Mount', render: (m) => <strong className="mono">_{m.id}</strong> },
            { key: 'state', label: 'State', render: (m) => <StatusPill value={m.state} /> },
            {
              key: 'origin',
              label: 'Origin',
              render: (m) => <span className="mono faint">{m.origin}</span>,
            },
            {
              key: 'tools',
              label: 'Tools',
              render: (m) => <span className="tabular">{m.toolCount}</span>,
              width: '70px',
            },
            {
              key: 'error',
              label: 'Error',
              render: (m) =>
                m.errorCode ? (
                  <span className="mono">{m.errorCode}</span>
                ) : (
                  <span className="faint">—</span>
                ),
            },
          ]}
        />
      )}
    </div>
  );
}
