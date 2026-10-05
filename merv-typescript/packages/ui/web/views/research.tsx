import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import type { ResearchRecord } from '@merv/research/models';
import { Link, useParams } from 'react-router-dom';
import { useTool } from '../api';
import { LoadState, RecordPage } from '../components';
import { recordRoutes } from '../list-filters';
import { homeOf, pathOf } from '../navigation';
import { Gate, Relations, StageMark } from '../process';
import { useSession } from '../session';
import type { ViewProps } from './index';
import { CycleMove } from './work';

function CycleDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  const { actor } = useSession();
  const back = homeOf(shell.rows);
  const cycle = useTool<ResearchRecord>('research.get', { researchId: id }, { every: 10000 });
  const process = useTool<ProcessGraph>('workflow.process', { instanceId: id }, { every: 5000 });
  if (!cycle.data)
    return (
      <div className="page-stage">
        <LoadState {...cycle} back={back} />
      </div>
    );
  const record = cycle.data;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && record.ownerId === actor.id);
  const relations = process.data?.dependencies ?? [];
  const waitsOn = relations.filter((item) => item.direction === 'depends_on');
  const unblocks = relations.filter((item) => item.direction === 'required_by');
  const reflections = pathOf(shell.rows, 'reflections');
  const tasks = pathOf(shell.rows, 'tasks');
  const phases = [
    ...(record.reflectionId && reflections
      ? [[`${reflections}/${record.reflectionId}`, 'Reflection']]
      : []),
    ...(tasks ? record.integrations.map((id) => [`${tasks}/${id}`, 'Consolidation task']) : []),
  ];
  return (
    <RecordPage
      back={<Link to={back.to}>← {back.label}</Link>}
      kind={row.view.kind}
      name={record.name}
      state={<StageMark graph={process.data} shapes={shell.workflows} workflow={record.workflow} />}
      act={
        <Gate graph={process.data}>
          {writable && (
            // The stack would stretch the one control to the pane's width.
            <div className="cluster">
              <CycleMove
                cycle={record}
                shell={shell}
                listed
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
export const ResearchView = recordRoutes(CycleDetail);
