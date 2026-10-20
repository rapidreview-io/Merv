import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Experiment, ExperimentEvidence, ExperimentExhibit } from '@merv/experiments/models';
import { EXPERIMENT_ROLES, roleRank } from '@merv/experiments/rules';
import type { ProcessGraph } from '@merv/workflows/models';
import type { RunningUnitEntry } from '@merv/contracts/running';
import { useTool } from '../api';
import { CodeBlock } from '../code-block';
import { recordRoutes } from '../list-filters';
import { homeOf } from '../navigation';
import {
  Evidence,
  KV,
  PageLoad,
  RecordPage,
  relativeTime,
  timeRows,
  useArtifacts,
} from '../components';
import { Markdown, RecordText } from '../markdown';
import { Gate, StageMark, useRecordRead } from '../process';
import { RecordCode } from './code';
import { currentReview } from '@merv/reviews/rules';
import { ThreeStates, reviewClause } from '../states';
import { Thread, historyEntries } from '../thread';
import { type Review } from './reviews';
import { useActorNames } from './people';
import type { ViewProps } from './index';
import type { CodeUnit } from '@merv/code-work/models';

const STAGE = { design: 'Design review', results: 'Results review' };

/** Retained files grouped by the part they play, each opening where it is listed. */
export function EvidenceFiles({
  evidence,
  figures,
}: {
  evidence: ExperimentEvidence[];
  figures: string[];
}) {
  const artifacts = useArtifacts();
  // In the domain's own order; a role with nothing retained under it is left out.
  const bands: [string, ExperimentEvidence[]][] = EXPERIMENT_ROLES.map((role) => [
    role,
    evidence.filter((item) => item.role === role),
  ]);
  // A role the domain no longer writes is still on the record, so it keeps a band of its own, last.
  const retained = evidence.filter((item) => roleRank(item.role) === EXPERIMENT_ROLES.length);
  if (retained.length) bands.push(['other retained files', retained]);
  return (
    <div className="stack">
      {bands
        .filter(([, rows]) => rows.length)
        .map(([role, rows]) => (
          <div key={role}>
            <span className="ev-role">{role}</span>
            {rows.map((item) => (
              <Evidence
                key={item.id}
                artifactId={item.artifactId}
                artifact={artifacts.get(item.artifactId)}
                label={`${item.path} · retained ${relativeTime(item.createdAt)}${
                  item.systemGenerated ? ' · written by the system' : ''
                }`}
              />
            ))}
          </div>
        ))}
      {figures.length > 0 && (
        <div>
          <span className="ev-role">figures</span>
          {figures.map((id) => (
            <Evidence key={id} artifactId={id} artifact={artifacts.get(id)} meta />
          ))}
        </div>
      )}
    </div>
  );
}

/** The record and the gate it stands at arrive together, from the row that owns them. */
function ExperimentDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  // An ended experiment changes no more, but what Code holds of it may (its accepted code's
  // publication to main): the read that brings it back ended slows the polling to a minute.
  const record = useRecordRead<{
    experiment: Experiment;
    process: ProcessGraph;
    codeUnit: CodeUnit | null;
    history: RunningUnitEntry[];
  }>(row, id, 60_000);
  const state = record.data?.experiment.workflow.state;
  const live = record.data?.process.terminal ? undefined : 8000;
  const reviews = useTool<Review[]>('review.list', { subjectId: id }, { every: live });
  // The exhibit is worked out from the attempt's results, parsing each: it is read again only
  // when the evidence the record lists has changed, not on every poll of the record.
  const exhibit = useTool<ExperimentExhibit>(
    state === 'running' ? 'experiment.read:exhibit' : null,
    {
      experimentId: id,
    },
  );
  const currentEvidence = (record.data?.experiment.evidence ?? []).filter(
    (item) => item.current && item.attemptIndex === record.data!.experiment.attempt.index,
  );
  const evidence = record.data && currentEvidence.map((item) => item.id).join();
  const { reload } = exhibit;
  const read = useRef(evidence);
  useEffect(() => {
    if (read.current === evidence) return;
    // The first read of the record starts the exhibit's; only a change after it reads again.
    const had = read.current;
    read.current = evidence;
    if (had !== undefined) reload();
  }, [evidence, reload]);
  const nameOf = useActorNames();
  const back = homeOf(shell.rows);
  if (!record.data)
    return (
      <PageLoad
        loading={record.loading}
        error={record.error ?? reviews.error ?? exhibit.error}
        back={back}
      />
    );
  const { experiment: e, process, codeUnit: unit } = record.data;
  const newest = currentReview(reviews.data, e.id);
  const stage = e.submissions.find((item) => item.reviewId === newest?.id)?.stage;
  // What the newest review decided, or where it stands until it has; a passing verdict
  // is not an outcome, so the conclusion is said apart from it, whole.
  const said = reviewClause(newest, newest?.reviewerId ? nameOf(newest.reviewerId) : null);
  // The figures of this attempt's last submission: one a review sent back is an earlier attempt's.
  const figures =
    e.submissions.filter((item) => item.attemptIndex === e.attempt.index).at(-1)?.figureIds ?? [];
  const shown = exhibit.data?.attemptIndex === e.attempt.index ? exhibit.data : undefined;
  const thread = historyEntries(record.data.history ?? [], nameOf);
  return (
    <RecordPage
      back={<Link to={back.to}>← {back.label}</Link>}
      kind="experiments"
      name={e.name}
      state={<StageMark graph={process} workflow={e.workflow} />}
      // The question it was opened to answer, as a task's goal stands under its title, and
      // what it came to directly under that, with the verdict that accepted it.
      standing={
        <>
          <span>
            <RecordText text={e.intent} />
          </span>
          {said && <ThreeStates review={said} meta={stage ? STAGE[stage] : 'Review'} />}
          {e.failed && e.conclusion && <span className="ev-role">Why this experiment ended</span>}
          {e.conclusion && <Markdown source={e.conclusion} />}
        </>
      }
      act={process && <Gate graph={process} />}
      title="Evidence"
      content={
        currentEvidence.length || figures.length || shown ? (
          <>
            <EvidenceFiles evidence={currentEvidence} figures={figures} />
            {shown && (
              <figure className="stack">
                {/\.(md|markdown)$/i.test(shown.path) ? (
                  <Markdown source={shown.content} />
                ) : (
                  <CodeBlock code={shown.content} lang={shown.path} label="Text" numbered />
                )}
                <figcaption className="muted">{shown.path}</figcaption>
              </figure>
            )}
          </>
        ) : undefined
      }
      history={thread.length ? <Thread entries={thread} /> : undefined}
      description={e.details ? <Markdown source={e.details} /> : undefined}
      code={unit && <RecordCode unit={unit} named={nameOf} />}
      details={
        <KV rows={[['Owner', nameOf(e.ownerId)], ...timeRows(e.createdAt, e.workflow.updatedAt)]} />
      }
    />
  );
}

export const ExperimentsView = recordRoutes(ExperimentDetail);
