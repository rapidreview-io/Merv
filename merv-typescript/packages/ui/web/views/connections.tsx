import { useEffect, useState } from 'react';
import { useTool } from '../api';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';
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
  const filter = useListFilter(mounts.data, {
    stateOf: (m) => m.state,
    labels: (m) => [m.id, m.origin],
    ids: (m) => [m.id],
  });
  return (
    <ListPage
      load={mounts}
      noun="mounts"
      placeholder="Mount or origin"
      filter={filter}
      emptyTitle="No mounts configured"
      emptyHint="External services an operator mounts into this server appear here with their connection health."
      line={(m) => ({
        name: <strong className="mono">_{m.id}</strong>,
        standing: (
          <ThreeStates
            execution={m.state}
            meta={
              <>
                <span className="mono">{m.origin}</span> ·{' '}
                <span className="tabular">{m.toolCount}</span> tools
                {m.errorCode ? ' · ' : ''}
                {m.errorCode && <span className="mono">{m.errorCode}</span>}
              </>
            }
          />
        ),
      })}
    />
  );
}
