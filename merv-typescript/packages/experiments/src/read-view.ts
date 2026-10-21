import type { Experiment } from './models.js';

export type ExperimentHistory = 'attempts' | 'evidence' | 'submissions';
const read = (input: Record<string, string | number>) => ({
  tool: 'experiment.get_state',
  arguments: input,
});

/** Current work first; all omitted history remains addressable through the same read tool. */
export function experimentReminder(experiment: Experiment) {
  const { attempts, evidence, submissions, attempt, ...identity } = experiment;
  const pinned = submissions.filter(
    (s) => s.id === attempt.approvedSubmissionId || s.reviewId === experiment.reviewId,
  );
  return {
    ...identity,
    attempt: {
      ...attempt,
      feedback: attempt.feedback.slice(-5).map((note) => note.slice(0, 2000)),
    },
    evidence: evidence.filter((e) => e.current && e.attemptIndex === attempt.index),
    submissions: pinned,
    historyCounts: {
      attempts: attempts.length,
      evidence: evidence.length,
      submissions: submissions.length,
      feedback: attempt.feedback.length,
    },
    references: [
      { tool: 'workflow.assignment', arguments: { instanceId: experiment.id } },
      ...(['attempts', 'evidence', 'submissions'] as const).map((history) =>
        read({ experimentId: experiment.id, history }),
      ),
      ...[
        ...new Set([
          ...evidence
            .filter((e) => e.current && e.attemptIndex === attempt.index)
            .flatMap((e) => [e.artifactId, ...e.figureIds]),
          ...pinned.flatMap((s) => [
            ...s.evidence.flatMap((e) => [e.artifactId, ...e.figureIds]),
            ...s.figureIds,
            ...(s.reportPdfId ? [s.reportPdfId] : []),
          ]),
          ...(experiment.captureArtifactIds ?? []),
        ]),
      ].map((artifactId) => ({ tool: 'artifact.read', arguments: { artifactId } })),
      ...[
        ...new Set(
          [experiment.reviewId, attempt.approvedReviewId, ...attempt.feedbackReviewIds].filter(
            (id): id is string => !!id,
          ),
        ),
      ].map((reviewId) => ({ tool: 'review.get', arguments: { reviewId } })),
    ],
  };
}

export function experimentHistory(
  experiment: Experiment,
  history: ExperimentHistory,
  offset = 0,
  limit = 20,
) {
  const rows = experiment[history];
  return {
    experimentId: experiment.id,
    history,
    total: rows.length,
    offset,
    items: rows.slice(offset, offset + limit),
    next:
      offset + limit < rows.length
        ? read({ experimentId: experiment.id, history, offset: offset + limit, limit })
        : null,
    current: read({ experimentId: experiment.id }),
  };
}

export function experimentListPage(
  experiments: Pick<Experiment, 'id' | 'name' | 'workflow'>[],
  offset = 0,
  limit = 20,
) {
  return {
    items: experiments.slice(offset, offset + limit).map((e) => ({
      id: e.id,
      name: e.name,
      workflow: { state: e.workflow.state, revision: e.workflow.revision },
      reference: read({ experimentId: e.id }),
    })),
    total: experiments.length,
    next:
      offset + limit < experiments.length
        ? { tool: 'experiment.list', arguments: { offset: offset + limit, limit } }
        : null,
  };
}
