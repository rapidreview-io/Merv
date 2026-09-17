import { useTool } from '../api';
import { LoadState, ObjId, StatusPill, Table, relativeTime } from '../components';
import type { ViewProps } from './index';
import { GitHubConnection } from './github';
import { GitHubPublications } from './github-publications';

interface Operation {
  command: { id: string; message: string; instanceId: string; actorId: string; createdAt: string };
  status: string;
  receipt: { headOid: string; parentOid: string; stats: { filesChanged: number } } | null;
  error: string | null;
}
interface Proposal {
  id: string;
  instanceId: string;
  revision: number;
  summary: string;
  producer: { actorId: string };
  receipt: { headOid: string };
  manifestHash: string;
  manifestArtifact: { id: string };
}
export function CodeView({ row }: ViewProps) {
  const state = useTool<{ operations: Operation[]; proposals: Proposal[] }>(
    'ui.read',
    { rowId: row.id },
    { every: 4000 },
  );
  const operations = state.data?.operations;
  const proposals = state.data?.proposals;
  return (
    <div className="page-stage stack stack--lg">
      <GitHubConnection />
      <GitHubPublications />
      {!!proposals?.length && (
        <section className="stack">
          <h2 className="section-title">Sealed proposals</h2>
          <Table
            rows={proposals}
            keyOf={(item) => item.id}
            columns={[
              {
                key: 'summary',
                label: 'Proposal',
                render: (item) => (
                  <>
                    <strong>{item.summary}</strong>
                    <div>
                      <ObjId id={item.id} />
                    </div>
                  </>
                ),
              },
              { key: 'revision', label: 'Revision', render: (item) => item.revision },
              { key: 'work', label: 'Work', render: (item) => <ObjId id={item.instanceId} /> },
              {
                key: 'producer',
                label: 'Producer',
                render: (item) => <ObjId id={item.producer.actorId} />,
              },
              {
                key: 'commit',
                label: 'Pinned commit',
                render: (item) => (
                  <span className="mono" title={item.receipt.headOid}>
                    {item.receipt.headOid.slice(0, 12)}
                  </span>
                ),
              },
              {
                key: 'manifest',
                label: 'Manifest',
                render: (item) => (
                  <span title={item.manifestHash}>
                    <ObjId id={item.manifestArtifact.id} />
                  </span>
                ),
              },
            ]}
          />
        </section>
      )}
      <LoadState
        loading={state.loading}
        error={state.error}
        empty={operations?.length === 0}
        emptyTitle="No code operations yet"
        emptyHint="Commits appear here as agents working in a Git workspace save their checkpoints."
      />
      {!!operations?.length && (
        <Table
          rows={operations}
          keyOf={(item) => item.command.id}
          columns={[
            {
              key: 'message',
              label: 'Commit',
              render: (item) => (
                <>
                  <strong>{item.command.message}</strong>
                  <div>
                    <ObjId id={item.command.id} />
                  </div>
                </>
              ),
            },
            {
              key: 'work',
              label: 'Work',
              render: (item) => <ObjId id={item.command.instanceId} />,
            },
            {
              key: 'worker',
              label: 'Worker',
              render: (item) => <ObjId id={item.command.actorId} />,
            },
            {
              key: 'status',
              label: 'Status',
              render: (item) => (
                <>
                  <StatusPill value={item.status} />
                  {item.error && <div className="faint">{item.error.replaceAll('_', ' ')}</div>}
                </>
              ),
            },
            {
              key: 'result',
              label: 'Saved commit',
              render: (item) =>
                item.receipt ? (
                  <>
                    <span className="mono" title={item.receipt.headOid}>
                      {item.receipt.headOid.slice(0, 12)}
                    </span>
                    <div className="faint">{item.receipt.stats.filesChanged} changed files</div>
                  </>
                ) : ['failed', 'cancelled'].includes(item.status) ? (
                  'No commit receipt'
                ) : (
                  'Awaiting receipt'
                ),
            },
            {
              key: 'created',
              label: 'Requested',
              render: (item) => (
                <span title={item.command.createdAt}>{relativeTime(item.command.createdAt)}</span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
