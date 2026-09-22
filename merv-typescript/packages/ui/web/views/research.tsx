import { Link, useParams } from 'react-router-dom';
import type { ResearchRecord } from '@merv/research/models';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { LoadState, RecordPage, StatusPill } from '../components';
import { Gate, Relations } from '../process';
import { splitRoutes } from '../list-filters';
import { WORK } from '../navigation';
import { useSession } from '../session';
import { CycleMove, WorkList, needsDefinition } from './work';
import type { ViewProps } from './index';

function CycleDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  const { actor } = useSession();
  const cycle = useTool<ResearchRecord>('research.get', { researchId: id }, { every: 10000 });
  const process = useTool<ProcessGraph>('workflow.process', { instanceId: id }, { every: 5000 });
  if (!cycle.data)
    return (
      <div className="page-stage">
        <LoadState {...cycle} back={{ to: WORK.path, label: 'Work' }} />
      </div>
    );
  const record = cycle.data;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && record.ownerId === actor.id);
  const relations = process.data?.dependencies ?? [];
  const waitsOn = relations.filter((item) => item.direction === 'depends_on');
  const unblocks = relations.filter((item) => item.direction === 'required_by');
  const phases = [
    ...(record.reflectionId ? [[`/reflections/${record.reflectionId}`, 'Reflection']] : []),
    ...(record.consolidationId
      ? [[`/consolidation/${record.consolidationId}`, 'Consolidation']]
      : []),
    ...record.integrations.map((id) => [`/tasks/${id}`, 'Consolidation task']),
  ];
  return (
    <RecordPage
      back={<Link to={WORK.path}>← Work</Link>}
      kind={row.view.kind}
      name={record.name}
      state={<StatusPill value={record.workflow.state} />}
      act={
        <Gate graph={process.data} kind={row.view.kind}>
          {writable && (
            // The stack would stretch the one control to the pane's width.
            <div className="cluster">
              <CycleMove
                cycle={record}
                shell={shell}
                undefinedYet={needsDefinition(process.data?.edges)}
                onSaved={() => {
                  cycle.reload();
                  process.reload();
                }}
              />
            </div>
          )}
        </Gate>
      }
      // The phases this cycle has opened so far; the paper is a place of its own in the rail.
      related={
        (relations.length > 0 || phases.length > 0) && (
          <>
            <Relations title="Waits on" items={waitsOn} />
            <Relations title="Unblocks" items={unblocks} />
            {phases.length > 0 && (
              <div className="cluster">
                {phases.map(([to, label]) => (
                  <Link key={to} to={to}>
                    {label}
                  </Link>
                ))}
              </div>
            )}
          </>
        )
      }
    />
  );
}

/** The cycle is read from the Work page it frames; its own list is that page now. */
export const ResearchView = splitRoutes(WorkList, CycleDetail, WORK.path);
