/**
 * Records into cards: an experiment's or a task's summary, from what its page already reads and
 * the text of its plan and report. The card itself (item-card.tsx) knows no record.
 */
import type { ArtifactContent } from '@merv/contracts/artifact-models';
import type { Experiment } from '@merv/experiments/models';
import type { Task } from '@merv/tasks/models';
import type { CodeUnit } from '@merv/code-work/models';
import { runningKey, type RunningUnitEntry } from '@merv/contracts/running';
import { useTool } from '../api';
import { useArtifacts } from '../components';
import { ItemSummary, figureOf, useItemMetrics, type ItemReceipt } from '../item-card';
import {
  armsOfRuns,
  findingOf,
  isMetricsData,
  isMetricsFigure,
  itemState,
  oneLine,
  parsePlan,
  stageWord,
  stagesOf,
} from '../item-model';
import { needs, useLive } from './work-live';

/** Whether the Running board says a person holds this item up. */
export function useAttention(id: string): boolean {
  const { board } = useLive();
  const key = runningKey('work', id);
  const node = board.data?.lanes.work.nodes.find(
    (each) => each.key === key || each.aliases?.includes(key),
  );
  return !!node && needs(node);
}

/** A retained Markdown file's text, read once: plans and reports never change. */
function useText(artifactId: string | undefined) {
  const read = useTool<ArtifactContent>(artifactId ? 'artifact.read:content' : null, {
    artifactId,
  });
  return read.data?.encoding === 'utf8' ? read.data.content : undefined;
}

/** An item's newest moves, newest first, three at most. */
export function trailOf(history: readonly RunningUnitEntry[]) {
  return [...history]
    .reverse()
    .flatMap((entry) => {
      const said = entry.said ?? entry.verdict?.text ?? entry.verdict?.word;
      if (!said) return [];
      const text = oneLine(entry.stage ? `${entry.stage}: ${said}` : said, 140);
      return [{ text, ...(entry.at && { at: entry.at }) }];
    })
    .slice(0, 3);
}

export function ExperimentSummary({
  experiment: e,
  codeUnit,
  history,
}: {
  experiment: Experiment;
  codeUnit: CodeUnit | null;
  history: RunningUnitEntry[];
}) {
  const attention = useAttention(e.id);
  const state = itemState({ settled: e.settled, failed: e.failed, attention });
  const ended = state === 'done' || state === 'failed';
  const current = e.evidence.filter((item) => item.current);
  const attempt = current.filter((item) => item.attemptIndex === e.attempt.index);
  // The plan this attempt runs under: its own, else the one it inherited.
  const planId = (
    attempt.find((item) => item.role === 'plan') ?? current.findLast((item) => item.role === 'plan')
  )?.artifactId;
  const reportId = attempt.find((item) => item.role === 'report')?.artifactId;
  const plan = parsePlan(useText(planId));
  const report = useText(reportId);
  const hints = plan.measure ? { [e.id]: plan.measure } : undefined;
  const metrics = useItemMetrics([e.id], { hints, live: !ended, points: 200 })[e.id];
  const artifacts = useArtifacts();
  const results = attempt.filter((item) => item.role === 'result');
  const receipt: ItemReceipt = {
    ...(codeUnit?.canonicalHead && { commit: codeUnit.canonicalHead }),
    data: results
      .filter((item) => !isMetricsFigure(item.path))
      .slice(0, 4)
      .map((item) => ({
        id: item.artifactId,
        title: artifacts.get(item.artifactId)?.title ?? item.path,
      })),
  };
  const arms = plan.arms.length
    ? plan.arms
    : metrics
      ? armsOfRuns(metrics.runs.filter((run) => !run.muted).reverse())
      : [];
  return (
    <ItemSummary
      kind="experiment"
      state={state}
      stage={stageWord('experiment', e.workflow.state)}
      question={plan.question ?? oneLine(e.intent, 200)}
      arms={arms.length > 1 ? arms : undefined}
      steps={stagesOf('experiment', e.workflow.state, ended)}
      stages={arms.length > 1 ? stagesOf('experiment', e.workflow.state, ended) : undefined}
      measure={plan.measure}
      metrics={metrics}
      finding={findingOf(report) ?? (e.conclusion ? oneLine(e.conclusion, 220) : undefined)}
      verdict={ended ? (state === 'done' ? 'pass' : 'fail') : undefined}
      success={plan.success}
      figureId={figureOf(results)}
      receipt={receipt}
      trail={trailOf(history)}
    />
  );
}

export function TaskSummary({
  task: t,
  codeUnit,
  history,
}: {
  task: Task;
  codeUnit: CodeUnit | null;
  history: RunningUnitEntry[];
}) {
  const attention = useAttention(t.id);
  const state = itemState({ settled: t.settled, failed: t.failed, attention });
  const ended = state === 'done' || state === 'failed';
  const artifacts = useArtifacts();
  const delivered = t.deliveryIds.map((id) => ({ id, title: artifacts.get(id)?.title ?? '' }));
  const report = useText(
    delivered.find(({ id }) => artifacts.get(id)?.mediaType === 'text/markdown')?.id,
  );
  const metrics = useItemMetrics([t.id], { live: !ended, points: 200 })[t.id];
  const met = t.deliveryConfirmations.filter((item) => item.status === 'met').length;
  const head = t.deliveryCode && 'headOid' in t.deliveryCode ? t.deliveryCode.headOid : undefined;
  const receipt: ItemReceipt = {
    ...((head ?? codeUnit?.canonicalHead) && { commit: head ?? codeUnit!.canonicalHead! }),
    data: delivered
      .filter(({ title }) => isMetricsData(title))
      .map(({ id, title }) => ({ id, title })),
  };
  // A task's plan is its checks, in order: the flow it is judged by.
  const steps = t.checks.slice(0, 6).map((check, i) => ({
    label: oneLine(check, 36),
    at: (t.deliveryConfirmations.find((item) => item.checkNumber === i + 1)?.status === 'met'
      ? 'done'
      : 'next') as 'done' | 'next',
  }));
  return (
    <ItemSummary
      kind="task"
      state={state}
      stage={stageWord('task', t.workflow.state)}
      question={oneLine(t.goal, 200)}
      steps={steps.length ? steps : stagesOf('task', t.workflow.state, ended)}
      stages={steps.length ? stagesOf('task', t.workflow.state, ended) : undefined}
      metrics={metrics}
      finding={findingOf(report) ?? (t.failure ? oneLine(t.failure.reason, 220) : undefined)}
      verdict={ended ? (state === 'done' ? 'pass' : 'fail') : undefined}
      success={t.checks.length ? `${met} of ${t.checks.length} checks met` : undefined}
      figureId={figureOf(delivered.map(({ id, title }) => ({ id, title })))}
      receipt={receipt}
      trail={trailOf(history)}
    />
  );
}
