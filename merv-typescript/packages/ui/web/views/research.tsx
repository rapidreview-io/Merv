import { Link, useParams } from 'react-router-dom';
import type { ResearchRecord } from '@merv/research/models';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { GateBox, LoadState, RecordPage, StatusPill } from '../components';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import { useSession } from '../session';
import { ResearchCommand } from './paper';
import { WorkList } from './work';
import type { ViewProps } from './index';

/** How a cycle handles code, in the words the cycle itself was opened with. */
const consolidation = (record: ResearchRecord) =>
  record.consolidationWorkspace === 'git'
    ? 'Git consolidation'
    : record.workflow.version < 3
      ? 'Report consolidation (legacy cycle)'
      : 'No code changes';

function CycleDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const { actor } = useSession();
  const cycle = useTool<ResearchRecord>('research.get', { researchId: id }, { every: 10000 });
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 5000 },
  );
  if (!cycle.data)
    return (
      <div className="page-stage">
        <LoadState {...cycle} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  const record = cycle.data;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && record.ownerId === actor.id);
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind={row.view.kind}
      name={record.name}
      standing={`${consolidation(record)} · revision ${record.workflow.revision}`}
      state={<StatusPill value={record.workflow.state} />}
      act={
        <>
          <LoadState {...guidance} />
          {guidance.data && !guidance.error && <GateBox decision={guidance.data} />}
          {writable && (
            <ResearchCommand
              disabled={record.workflow.state === 'complete'}
              tool="research.advance"
              input={{ researchId: record.id, expectedRevision: record.workflow.revision }}
              label="Start next step"
              onSaved={() => {
                cycle.reload();
                guidance.reload();
              }}
            />
          )}
        </>
      }
      related={
        <div className="cluster">
          <Link to="/paper">
            Living paper{record.problem ? ` · problem revision ${record.problem.revision}` : ''}
          </Link>
          {record.reflectionId && (
            <Link to={`/reflections/${record.reflectionId}`}>Reflection</Link>
          )}
          {record.consolidationId && (
            <Link to={`/consolidation/${record.consolidationId}`}>Consolidation</Link>
          )}
        </div>
      }
    />
  );
}

/** The cycle is read from the Work page it frames; its own list is that page now. */
export const ResearchView = splitRoutes(WorkList, CycleDetail, WORK.path);
