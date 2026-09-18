import { visible, mapAsync, filterAsync } from '@merv/contracts';
import { createService, plain, recorded, replayed } from '@merv/contracts';
import type { Context } from 'cordis';
import { createHash } from 'node:crypto';
import {
  check,
  digest,
  inTransaction,
  newId,
  now,
  type Artifact,
  type Artifacts,
  type Caller,
  type ContextBuilder,
  type Data,
  type ProcessGraph,
  type ReviewApplication,
  type Reviews,
  type Scope,
  type State,
  type Transaction,
  type WorkflowCheckContext,
  type Workflows,
} from '@merv/contracts';
import type { Paper } from '@merv/paper/types';
import type { Claims } from '@merv/claims/types';
import type { Code, CodeCaptureRef } from '@merv/code/types';
import type {
  Experiment,
  ExperimentAttach,
  ExperimentCreate,
  ExperimentEvidence,
  ExperimentExhibit,
  Experiments,
  ExperimentSubmission,
  ExperimentTransition,
} from './types.js';
import {
  experimentAttachSchema,
  experimentCreateSchema,
  experimentGetSchema,
  experimentTransitionSchema,
  parseExperimentInput,
} from './input.js';
import {
  buildMetricsExhibit,
  decodeEvidence,
  exhibitBytes,
  markdownImageTargets,
  parseResult,
  shouldPinExhibit,
  reportConclusion,
  validatePlan,
  validateReport,
} from './evidence.js';
import { ExperimentProgram, programVersion, programWorkspace } from './program.js';
import {
  attemptMetadata,
  migrateExperiments,
  submissionMetadata,
  type AttemptRow,
  type ExperimentRow,
  type SubmissionRow,
} from './storage.js';
export type * from './types.js';

const terminal = new Set(['complete', 'abandoned', 'failed']);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const designCriteria = [
  'The plan defines a testable hypothesis and an evaluation that can distinguish it from alternatives.',
  'Controls, baselines, data, metrics and decision criteria make the proposed comparison defensible.',
  'The proposed execution is feasible and its limitations and possible failure modes are addressed.',
];
const resultsCriteria = [
  'The retained execution and results follow the exact approved plan, with deviations and failures explained.',
  'The submitted measurements agree with the retained results and any metrics exhibit, and the report selects what mattered without hiding known rework.',
  'The report’s conclusions follow from the evidence, including negative findings and limitations.',
];

/** Owns the research experiment lifecycle; Workflows owns workflow execution and Reviews owns verdicts. */
export class ExperimentService implements Experiments {
  private closed = false;
  private releaseReviewOwner?: () => void;
  private program!: ExperimentProgram;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly artifacts: Artifacts,
    private readonly workflows: Workflows,
    private readonly reviews: Reviews,
    contextBuilder: ContextBuilder,
    private readonly claims: Claims,
    private code: Pick<Code, 'capture'> | undefined,
    private readonly paper: Paper,
  ) {
    this.initialize = async () => {
      await migrateExperiments(state);
      const service = this;
      this.program = await createService(
        new ExperimentProgram({
          state,
          scope,
          artifacts,
          workflows,
          reviews,
          contextBuilder,
          claims,
          get code() {
            return service.code;
          },
          paper,
          facts: async (caller, id, tx) => await this.get(caller, id, tx),
          checkAction: async (context) => {
            await this.checkAction(context);
          },
        }),
      );
      try {
        this.releaseReviewOwner = reviews.registerSubmitOwner({
          id: 'experiments',
          owns: async (review, tx) =>
            !!(await tx.get(
              'SELECT id FROM experiments WHERE id=? AND project_id=?',
              review.subjectId,
              review.projectId,
            )),
          submit: async (caller, input, tx) => await this.submitReview(caller, input, tx),
        });
      } catch (error) {
        this.program.dispose();
        throw error;
      }
    };
  }
  /** The optional Cordis child owns this binding, not the experiment lifecycle. */
  bindCode(code: Pick<Code, 'capture'>): () => void {
    this.code = code;
    return () => {
      this.code = undefined;
    };
  }
  private open(): void {
    check(!this.closed, 'experiments_unavailable', 'Experiments is unavailable', 503);
  }
  async process(caller: Caller, id: string): Promise<ProcessGraph> {
    this.open();
    return await this.workflows.process(caller, id);
  }
  private async row(caller: Caller, id: string, tx: Transaction): Promise<ExperimentRow> {
    const row = await tx.get<ExperimentRow>(
      'SELECT * FROM experiments WHERE project_id=? AND id=?',
      caller.projectId,
      id,
    );
    check(row, 'experiment_not_found', 'Experiment not found in this project', 404);
    return row;
  }
  async get(caller: Caller, id: string, transaction?: Transaction): Promise<Experiment> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      parseExperimentInput(experimentGetSchema, { experimentId: id });
      const row = await this.row(caller, id, tx),
        workflow = await this.workflows.get(caller, id, tx);
      const starts = await this.workflows.workStarts(caller, id, tx);
      const attempts = (
        await tx.all<AttemptRow>(
          'SELECT * FROM experiment_attempts WHERE experiment_id=? ORDER BY attempt_index',
          id,
        )
      )
        .map(attemptMetadata)
        .map((attempt) => ({
          ...attempt,
          startedAt:
            starts
              .filter(
                (start) =>
                  start.state === 'running' &&
                  start.revision >= attempt.startedRevision &&
                  (attempt.endedRevision === null || start.revision <= attempt.endedRevision),
              )
              .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.startedAt ?? null,
        }));
      const attempt = attempts.find((attempt) => attempt.index === row.attempt_index)!;
      const evidence = (
        await tx.all<{ record: string; selected: number }>(
          `SELECT e.record,CASE WHEN s.evidence_id=e.id THEN 1 ELSE 0 END AS selected
    FROM experiment_evidence e LEFT JOIN experiment_slots s ON s.experiment_id=e.experiment_id AND s.attempt_index=e.attempt_index AND s.role=e.role AND s.path=e.path
    WHERE e.experiment_id=? ORDER BY e.sequence`,
          id,
        )
      ).map(
        ({ record, selected }) =>
          ({ figureIds: [], ...JSON.parse(record), current: !!selected }) as ExperimentEvidence,
      );
      const submissions = (
        await tx.all<SubmissionRow>(
          'SELECT record FROM experiment_submissions WHERE experiment_id=? ORDER BY attempt_index,stage,round',
          id,
        )
      ).map(submissionMetadata);
      return {
        id,
        projectId: row.project_id,
        name: row.name,
        intent: row.intent,
        details: row.details,
        ownerId: row.owner_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        testedClaimIds: JSON.parse(row.tested_claim_ids),
        ...(row.workspace === 'git' ? { workspace: 'git' as const } : {}),
        workflow,
        attempt,
        attempts,
        evidence,
        submissions,
        reviewId: row.review_id,
        conclusion: row.conclusion,
      };
    });
  }
  async list(caller: Caller, transaction?: Transaction): Promise<Experiment[]> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      return await mapAsync(
        await tx.all<{ id: string }>(
          'SELECT id FROM experiments WHERE project_id=? ORDER BY created_at,id',
          caller.projectId,
        ),
        async (row) => await this.get(caller, row.id, tx),
      );
    });
  }
  async create(
    caller: Caller,
    value: ExperimentCreate,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const input = parseExperimentInput(experimentCreateSchema, value);
      return await this.command(caller, 'create', input, tx, async () => {
        check(
          !caller.session,
          'forbidden',
          'An assigned experiment worker cannot create a separate experiment',
          403,
        );
        const existing = await this.list(caller, tx);
        check(
          !existing.some((e) => e.name.toLowerCase() === input.name.toLowerCase()),
          'experiment_name_conflict',
          'An experiment already uses this name',
          409,
        );
        check(
          existing.filter((e) => !terminal.has(e.workflow.state)).length < 7,
          'experiment_limit',
          'At most seven experiments may be active in this project',
          409,
        );
        for (const id of input.testedClaimIds) await this.claims.get(caller, id, tx);
        for (const id of input.dependsOn) {
          const dependency = await this.workflows.get(caller, id, tx);
          check(
            ['task', 'experiment'].includes(dependency.workflow),
            'invalid_dependency',
            'Experiment prerequisites must be tasks or experiments',
          );
        }
        const owner = await this.scope.authorityActor(caller, tx);
        check(
          input.workspace !== 'git' || this.code,
          'code_unavailable',
          'Git experiments require Code captures',
          503,
        );
        const workflow = await (
          await this.program.handleFor(programVersion(input.workspace))
        ).start(
          caller,
          {
            workflow: 'experiment',
            requestId: `experiment:create:${caller.actorId}:${input.requestId}`,
            dependsOn: input.dependsOn,
            // What waits on this experiment names it, so the instance carries the name.
            data: { name: input.name },
          },
          tx,
        );
        const createdAt = now();
        await tx.run(
          'INSERT INTO experiments(id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids,attempt_index,workspace) VALUES(?,?,?,?,?,?,?,?,?,1,?)',
          workflow.id,
          caller.projectId,
          input.name,
          input.intent,
          input.details,
          owner.id,
          caller.actorId,
          createdAt,
          JSON.stringify(input.testedClaimIds),
          input.workspace ?? 'none',
        );
        await this.addAttempt(workflow.id, 1, workflow.revision, null, [], createdAt, tx);
        await this.record(
          caller,
          'created',
          workflow.id,
          { name: input.name, testedClaimIds: input.testedClaimIds, dependsOn: input.dependsOn },
          tx,
        );
        return await this.get(caller, workflow.id, tx);
      });
    });
  }
  async attach(
    caller: Caller,
    value: ExperimentAttach,
    transaction?: Transaction,
  ): Promise<ExperimentEvidence> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const input = parseExperimentInput(experimentAttachSchema, value);
      return await this.command(caller, 'attach', input, tx, async () => {
        const experiment = await this.get(caller, input.experimentId, tx);
        this.revision(experiment, input.expectedRevision);
        check(
          experiment.attempt.index === input.attemptIndex,
          'attempt_conflict',
          `Expected attempt ${input.attemptIndex}, the current attempt is ${experiment.attempt.index}`,
          409,
        );
        await this.program.assertProducer(caller, experiment, tx);
        check(
          experiment.workflow.state === 'planned'
            ? input.role === 'plan'
            : ['result', 'report'].includes(input.role),
          'invalid_experiment_role',
          'This evidence role is not writable in the current state',
          409,
        );
        // Evidence is written against the work this experiment depends on, like the step itself.
        await this.workflows.checkDependencies(caller, experiment.id, tx);
        const artifact = await this.artifacts.get(caller, input.artifactId, tx);
        const inherited = await this.program.pinnedRecovery(caller, experiment, tx);
        check(
          (await this.authoredInExecution(caller, artifact, tx)) ||
            inherited.some(
              (e) =>
                e.artifactId === artifact.id &&
                e.role === input.role &&
                e.path === input.path &&
                e.hash === artifact.hash &&
                e.resultFormat === input.resultFormat,
            ),
          'invalid_evidence_author',
          'Evidence must be authored by this worker or be its exact frozen recovery input',
          403,
        );
        const text = await this.text(caller, artifact.id, tx);
        if (input.role === 'result') parseResult(text, input.resultFormat ?? 'json');
        const figureIds = ['plan', 'report'].includes(input.role)
          ? await this.figures(caller, text, experiment, tx)
          : [];
        const association = await this.saveEvidence(
          caller,
          experiment,
          input.role,
          input.path,
          artifact,
          input.resultFormat,
          false,
          tx,
          figureIds,
        );
        await this.record(
          caller,
          'evidence_attached',
          experiment.id,
          {
            evidenceId: association.id,
            artifactId: artifact.id,
            role: input.role,
            path: input.path,
            attemptIndex: input.attemptIndex,
          },
          tx,
        );
        return association;
      });
    });
  }
  private current(experiment: Experiment, roles: string[]): ExperimentEvidence[] {
    return experiment.evidence.filter(
      (e) => e.current && e.attemptIndex === experiment.attempt.index && roles.includes(e.role),
    );
  }
  private async selected(
    caller: Caller,
    experiment: Experiment,
    roles: string[],
    tx: Transaction,
  ): Promise<ExperimentEvidence[]> {
    const evidence = this.current(experiment, roles);
    // The worker holding this experiment sees the evidence it was offered plus its own;
    // anyone else, another record's worker included, reads what the record holds.
    if (!caller.session || !(await this.program.holds(caller, experiment, tx))) return evidence;
    const allowed = new Set(await this.program.allowedArtifacts(caller, experiment, tx));
    return evidence.filter((e) => allowed.has(e.artifactId));
  }
  private one(evidence: ExperimentEvidence[], role: string): ExperimentEvidence {
    const matching = evidence.filter((e) => e.role === role);
    check(
      matching.length === 1,
      'experiment_evidence_required',
      `Exactly one current ${role} artifact is required`,
      409,
    );
    return matching[0]!;
  }
  private async authoredInExecution(
    caller: Caller,
    artifact: Artifact,
    tx: Transaction,
  ): Promise<boolean> {
    return caller.session
      ? (await this.artifacts.authored(caller, tx)).some((output) => output.id === artifact.id)
      : artifact.createdBy === caller.actorId;
  }
  private async bytes(
    caller: Caller,
    id: string,
    tx: Transaction,
  ): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const artifact = await this.artifacts.get(caller, id, tx);
    const result = await this.artifacts.read(caller, id);
    const bytes = Buffer.from(result.content, result.encoding);
    check(
      result.artifact.id === artifact.id &&
        result.artifact.hash === artifact.hash &&
        bytes.length === artifact.size &&
        sha256(bytes) === artifact.hash,
      'artifact_hash_mismatch',
      'Retained artifact bytes do not match their immutable metadata',
      409,
    );
    return { artifact, bytes };
  }
  private async text(caller: Caller, id: string, tx: Transaction): Promise<string> {
    return decodeEvidence((await this.bytes(caller, id, tx)).bytes);
  }
  private async figures(
    caller: Caller,
    text: string,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<string[]> {
    const ids = [...new Set(markdownImageTargets(text))];
    const allowed = caller.session
      ? new Set(await this.program.allowedArtifacts(caller, experiment, tx))
      : null;
    for (const id of ids) {
      check(
        !allowed || allowed.has(id),
        'forbidden',
        'Figure is outside this worker’s frozen inputs and authored outputs',
        403,
      );
      const { artifact, bytes } = await this.bytes(caller, id, tx);
      check(
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mediaType) &&
          bytes.length > 0,
        'invalid_experiment_evidence',
        'Figures must be retained PNG, JPEG, GIF or WebP image artifacts',
      );
    }
    return ids;
  }
  private approved(experiment: Experiment): ExperimentSubmission {
    const submission = experiment.submissions.find(
      (s) => s.id === experiment.attempt.approvedSubmissionId,
    );
    check(
      submission &&
        submission.stage === 'design' &&
        submission.attemptIndex === experiment.attempt.index &&
        submission.reviewId === experiment.attempt.approvedReviewId,
      'approved_plan_required',
      'The current attempt requires an exact approved plan',
      409,
    );
    return submission;
  }
  private async buildExhibit(
    caller: Caller,
    experiment: Experiment,
    tx: Transaction,
  ): Promise<ExperimentExhibit> {
    const sources = (await this.selected(caller, experiment, ['result'], tx)).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.sequence - b.sequence,
    );
    const inputs = await mapAsync(sources, async (source) => ({
      path: source.path,
      artifactId: source.artifactId,
      sha256: source.hash,
      submittedAt: source.createdAt,
      resultFormat: source.resultFormat ?? 'json',
      data: parseResult(
        await this.text(caller, source.artifactId, tx),
        source.resultFormat ?? 'json',
      ),
    }));
    const exhibit = buildMetricsExhibit({
      projectId: experiment.projectId,
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      startedAt: experiment.attempt.startedAt,
      sources: inputs,
    });
    const bytes = exhibitBytes(exhibit);
    return {
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      path: `experiments/${experiment.name}/metrics_exhibit.json`,
      content: bytes.toString('utf8'),
      hash: sha256(bytes),
      willPin: shouldPinExhibit(inputs),
      sources,
      startedAt: experiment.attempt.startedAt,
    };
  }
  async exhibit(caller: Caller, id: string, transaction?: Transaction): Promise<ExperimentExhibit> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'read', tx);
      const experiment = await this.get(caller, id, tx);
      check(
        experiment.workflow.state === 'running',
        'experiment_not_running',
        'Exhibit preview is available while running; read a pinned exhibit artifact after submission',
        409,
      );
      return await this.buildExhibit(caller, experiment, tx);
    });
  }
  async transition(
    caller: Caller,
    value: ExperimentTransition,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'write', tx);
      const input: ExperimentTransition = parseExperimentInput(experimentTransitionSchema, value);
      return await this.command(caller, 'transition', input, tx, async () => {
        const experiment = await this.get(caller, input.experimentId, tx);
        this.revision(experiment, input.expectedRevision);
        await this.checkAction({
          caller,
          snapshot: experiment.workflow,
          tx,
          input: { ...input },
          transition: input.transition,
        });
        if (input.transition === 'submit_design' || input.transition === 'submit_results')
          return await this.submit(caller, experiment, input, tx);
        if (
          experiment.reviewId &&
          ['design_review', 'experiment_review'].includes(experiment.workflow.state)
        )
          await this.reviews.supersede(caller, experiment.reviewId, tx);
        const moved = await (
          await this.program.handleFor(experiment.workflow.version)
        ).transition(
          caller,
          {
            instanceId: experiment.id,
            expectedRevision: input.expectedRevision,
            action: input.transition,
            input: { ...input },
            requestId: `experiment:transition:${caller.actorId}:${input.requestId}`,
            data: { reason: input.evidence?.reason ?? null },
          },
          tx,
        );
        if (input.transition === 'retry_running')
          await this.feedback(
            experiment,
            `Infrastructure recovery: ${input.evidence?.reason}. ${input.evidence?.detail ?? ''} Recover existing jobs and retained outputs before starting new work.`,
            tx,
          );
        else {
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision,
            experiment.id,
            experiment.attempt.index,
          );
          await tx.run(
            'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
            input.evidence?.reason ?? null,
            experiment.id,
          );
        }
        await this.record(
          caller,
          'transitioned',
          experiment.id,
          {
            transition: input.transition,
            from: experiment.workflow.state,
            to: moved.state,
            revision: moved.revision,
            attemptIndex: experiment.attempt.index,
            reason: input.evidence?.reason ?? null,
            detail: input.evidence?.detail ?? null,
          },
          tx,
        );
        return await this.get(caller, experiment.id, tx);
      });
    });
  }
  /** Read-only exit gates shared by guidance and the command writer. */
  private async prepareSubmission(
    caller: Caller,
    experiment: Experiment,
    stage: 'design' | 'results',
    tx: Transaction,
  ): Promise<{
    evidence: ExperimentEvidence[];
    figureIds: string[];
    exhibit: ExperimentExhibit | null;
  }> {
    let evidence = await this.selected(
      caller,
      experiment,
      stage === 'design' ? ['plan'] : ['result', 'report'],
      tx,
    );
    let figureIds: string[] = [];
    let exhibit: ExperimentExhibit | null = null;
    if (stage === 'design') {
      const plan = this.one(evidence, 'plan');
      const text = await this.text(caller, plan.artifactId, tx);
      figureIds = await this.figures(caller, text, experiment, tx);
      validatePlan(text, { figures: figureIds });
    } else {
      const approved = this.approved(experiment);
      // Include the exact approved design, never a newer plan association.
      evidence = [...approved.evidence, ...evidence];
      const report = this.one(evidence, 'report');
      const text = await this.text(caller, report.artifactId, tx);
      figureIds = [
        ...new Set([...approved.figureIds, ...(await this.figures(caller, text, experiment, tx))]),
      ];
      for (const id of approved.figureIds) await this.bytes(caller, id, tx);
      exhibit = await this.buildExhibit(caller, experiment, tx);
      validateReport(text, {
        figures: figureIds,
        ...(exhibit.willPin ? { exhibitPath: exhibit.path } : {}),
      });
    }
    const recovery = await this.program.pinnedRecovery(caller, experiment, tx);
    const inherited = [...recovery];
    if (stage === 'results') inherited.push(...this.approved(experiment).evidence);
    for (const item of evidence) {
      const metadata = await this.artifacts.get(caller, item.artifactId, tx);
      check(
        metadata.hash === item.hash,
        'artifact_hash_mismatch',
        'The selected evidence metadata changed',
        409,
      );
      check(
        (await this.authoredInExecution(caller, metadata, tx)) ||
          inherited.some(
            (pin) =>
              pin.experimentId === item.experimentId &&
              pin.attemptIndex === item.attemptIndex &&
              pin.role === item.role &&
              pin.path === item.path &&
              pin.artifactId === item.artifactId &&
              pin.hash === item.hash &&
              pin.resultFormat === item.resultFormat,
          ),
        'invalid_evidence_author',
        'Submission includes evidence outside the current worker’s authorship and frozen recovery selection',
        403,
      );
      await this.bytes(caller, item.artifactId, tx);
    }
    return { evidence, figureIds, exhibit };
  }
  private async submit(
    caller: Caller,
    experiment: Experiment,
    input: ExperimentTransition,
    tx: Transaction,
  ): Promise<Experiment> {
    const stage = input.transition === 'submit_design' ? 'design' : 'results';
    const { evidence, figureIds, exhibit } = await this.prepareSubmission(
      caller,
      experiment,
      stage,
      tx,
    );
    let codeCaptureRef: CodeCaptureRef | undefined;
    if (stage === 'results' && experiment.workspace === 'git') {
      check(
        caller.session,
        'session_required',
        'Git result submission requires its actual worker session',
        403,
      );
      check(this.code, 'code_unavailable', 'Code captures are unavailable', 503);
      codeCaptureRef = { kind: 'session-final', sessionId: caller.session.id };
      const capture = await this.code.capture(caller, codeCaptureRef, tx),
        p = capture.provenance;
      check(
        capture.status === 'pending' &&
          p.hostRef &&
          p.projectId === experiment.projectId &&
          p.instanceId === experiment.id &&
          p.revision === experiment.workflow.revision &&
          p.actorId === caller.actorId &&
          p.workflow.state === 'running' &&
          programWorkspace(p.workflow.version) === 'git' &&
          !p.readOnly,
        'experiment_capture_provenance',
        'Submit from the exact attached running Git worker before final capture',
        409,
      );
    }
    if (exhibit?.willPin) {
      const artifact = await this.artifacts.create(
        caller,
        {
          title: `Metrics exhibit: ${experiment.name}`,
          content: exhibit.content,
          mediaType: 'application/json',
        },
        tx,
      );
      evidence.push(
        await this.saveEvidence(
          caller,
          experiment,
          'exhibit',
          exhibit.path,
          artifact,
          undefined,
          true,
          tx,
        ),
      );
    }
    const artifactIds = [...new Set([...evidence.map((e) => e.artifactId), ...figureIds])];
    const pinnedInputIds = await filterAsync(
      artifactIds,
      async (id) => (await this.artifacts.get(caller, id, tx)).createdBy !== caller.actorId,
    );
    const moved = await (
      await this.program.handleFor(experiment.workflow.version)
    ).transition(
      caller,
      {
        instanceId: experiment.id,
        expectedRevision: input.expectedRevision,
        action: input.transition,
        input: { ...input },
        requestId: `experiment:transition:${caller.actorId}:${input.requestId}`,
      },
      tx,
    );
    const paperProposal = input.paperChangesArtifactId
      ? await this.paper.propose(
          caller,
          {
            artifactId: input.paperChangesArtifactId,
            source: { kind: 'experiment', id: experiment.id, revision: moved.revision },
            evidenceIds: artifactIds,
          },
          tx,
        )
      : null;
    // The change artifact may already be attached as evidence; a review pins each once.
    if (paperProposal && !artifactIds.includes(paperProposal.artifact.id))
      artifactIds.push(paperProposal.artifact.id);
    const review = await this.reviews.request(
      caller,
      {
        subjectId: experiment.id,
        subjectRevision: moved.revision,
        producerId: caller.actorId,
        administrativeActorId: experiment.ownerId,
        // Neither the owner nor the authority that directed a worker is independent of its work.
        ...(caller.session
          ? {
              excludedActorIds: [
                ...new Set([experiment.ownerId, (await this.scope.authorityActor(caller, tx)).id]),
              ],
            }
          : {}),
        artifactIds,
        pinnedInputIds,
        criteria: [
          ...(stage === 'design' ? designCriteria : resultsCriteria),
          ...(paperProposal
            ? [
                'The proposed paper edits accurately describe this experiment and are supported by its retained evidence.',
              ]
            : []),
        ],
        formatVersion: 2,
        requestId: `experiment:submission:${caller.actorId}:${input.requestId}`,
      },
      tx,
    );
    const round =
      ((
        await tx.get<{ count: number }>(
          'SELECT COALESCE(MAX(round),0) AS count FROM experiment_submissions WHERE experiment_id=? AND attempt_index=? AND stage=?',
          experiment.id,
          experiment.attempt.index,
          stage,
        )
      )?.count ?? 0) + 1;
    const submission: ExperimentSubmission = {
      id: newId('exp_sub'),
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      stage,
      ...(codeCaptureRef ? { codeCaptureRef } : {}),
      ...(paperProposal ? { paperProposal } : {}),
      round,
      subjectRevision: moved.revision,
      producerId: caller.actorId,
      sessionId: caller.session?.id ?? null,
      evidence,
      figureIds,
      manifestHash: digest({
        formatVersion: 1,
        ...(paperProposal ? { paperProposal } : {}),
        evidence,
        figures: await mapAsync(figureIds, async (id) => await this.artifacts.get(caller, id, tx)),
        ...(codeCaptureRef ? { codeCaptureRef } : {}),
      }),
      reviewId: review.id,
      createdAt: now(),
    };
    await tx.run(
      'INSERT INTO experiment_submissions(id,experiment_id,attempt_index,stage,round,review_id,record) VALUES(?,?,?,?,?,?,?)',
      submission.id,
      experiment.id,
      experiment.attempt.index,
      stage,
      round,
      review.id,
      JSON.stringify(submission),
    );
    await tx.run('UPDATE experiments SET review_id=? WHERE id=?', review.id, experiment.id);
    await this.record(
      caller,
      'submitted',
      experiment.id,
      {
        submissionId: submission.id,
        stage,
        round,
        attemptIndex: experiment.attempt.index,
        reviewId: review.id,
        manifestHash: submission.manifestHash,
        artifactIds,
      },
      tx,
    );
    return await this.get(caller, experiment.id, tx);
  }
  private route(stage: 'design' | 'results', input: ReviewApplication): string {
    check(
      ['pass', 'needs_changes', 'fail'].includes(input.verdict),
      'invalid_verdict',
      'A supported review verdict is required',
    );
    if (input.verdict === 'pass') {
      check(
        input.returnTo === undefined,
        'invalid_review_return',
        'Passing reviews do not accept returnTo',
      );
      return stage === 'design' ? 'approve_design' : 'accept_results';
    }
    if (stage === 'design') {
      check(
        input.returnTo === undefined || input.returnTo === 'planned',
        'invalid_review_return',
        'A rejected design returns only to planned',
      );
      return 'revise_design';
    }
    check(
      input.returnTo === 'planned' || input.returnTo === 'running',
      'invalid_review_return',
      'Both negative attempt verdicts require returnTo planned or running',
    );
    return input.returnTo === 'planned' ? 'revise_plan' : 'revise_execution';
  }
  async submitReview(
    caller: Caller,
    value: ReviewApplication,
    transaction?: Transaction,
  ): Promise<Experiment> {
    this.open();
    return await inTransaction(this.state, transaction, async (tx) => {
      await this.scope.require(caller, 'review', tx);
      const input = plain<ReviewApplication>(value, 'invalid_experiment_input', {
        nodes: 8192,
        depth: 20,
        bytes: 262144,
      });
      check(
        input && typeof input === 'object' && !Array.isArray(input),
        'invalid_experiment_input',
        'Review input must be an object',
      );
      check(
        Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
        'invalid_revision',
        'expectedRevision is required',
      );
      const review = await this.reviews.get(caller, input.reviewId, tx);
      const experiment = await this.get(caller, review.subjectId, tx);
      const submission = experiment.submissions.find((s) => s.reviewId === review.id);
      check(submission, 'stale_review', 'Review is not an experiment submission', 409);
      const action = this.route(submission.stage, input);
      return await this.command(caller, 'submit_review', input, tx, async () => {
        await this.checkReview(caller, experiment, input, tx);
        let conclusion: string | null = null;
        if (action === 'accept_results') {
          const report = this.one(submission.evidence, 'report');
          const body = await this.text(caller, report.artifactId, tx);
          const section = reportConclusion(body);
          conclusion =
            typeof input.evidence?.conclusion === 'string' && visible(input.evidence.conclusion)
              ? input.evidence.conclusion.trim()
              : section || input.notes;
        }
        const moved = await (
          await this.program.handleFor(experiment.workflow.version)
        ).transition(
          caller,
          {
            instanceId: experiment.id,
            expectedRevision: input.expectedRevision,
            action,
            input: { ...input },
            requestId: `experiment:review:${caller.actorId}:${input.requestId}`,
            data: { verdict: input.verdict, reviewId: review.id, returnTo: input.returnTo ?? null },
          },
          tx,
        );
        const { expectedRevision: _revision, ...verdict } = input;
        await this.reviews.submit(
          caller,
          { ...verdict, requestId: `experiment:review:${caller.actorId}:${input.requestId}` },
          tx,
        );
        // The submission is a snapshot: the paper itself records the acceptance.
        if (input.verdict === 'pass' && submission.paperProposal)
          await this.paper.accept(
            caller,
            {
              proposalId: submission.paperProposal.id,
              source: submission.paperProposal.source,
              reviewId: review.id,
            },
            tx,
          );
        if (action === 'approve_design')
          await tx.run(
            'UPDATE experiment_attempts SET approved_submission_id=?,approved_review_id=? WHERE experiment_id=? AND attempt_index=?',
            submission.id,
            review.id,
            experiment.id,
            experiment.attempt.index,
          );
        else if (['revise_design', 'revise_plan'].includes(action)) {
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision - 1,
            experiment.id,
            experiment.attempt.index,
          );
          const index = experiment.attempt.index + 1;
          await this.addAttempt(
            experiment.id,
            index,
            moved.revision,
            experiment.attempt.index,
            [input.notes],
            now(),
            tx,
            [review.id],
          );
          await tx.run('UPDATE experiments SET attempt_index=? WHERE id=?', index, experiment.id);
        } else if (action === 'revise_execution')
          await this.feedback(experiment, input.notes, tx, review.id);
        else if (action === 'accept_results')
          await tx.run(
            'UPDATE experiment_attempts SET ended_revision=? WHERE experiment_id=? AND attempt_index=?',
            moved.revision,
            experiment.id,
            experiment.attempt.index,
          );
        await tx.run(
          'UPDATE experiments SET review_id=NULL,conclusion=? WHERE id=?',
          conclusion,
          experiment.id,
        );
        await this.record(
          caller,
          'review_applied',
          experiment.id,
          {
            reviewId: review.id,
            submissionId: submission.id,
            verdict: input.verdict,
            returnTo: input.returnTo ?? null,
            action,
            from: experiment.workflow.state,
            to: moved.state,
            revision: moved.revision,
          },
          tx,
        );
        return await this.get(caller, experiment.id, tx);
      });
    });
  }
  private async checkReview(
    caller: Caller,
    experiment: Experiment,
    input: ReviewApplication,
    tx: Transaction,
  ): Promise<void> {
    await this.scope.require(caller, 'review', tx);
    const review = await this.reviews.get(caller, input.reviewId, tx);
    check(
      experiment.reviewId === review.id &&
        ['design_review', 'experiment_review'].includes(experiment.workflow.state),
      'stale_review',
      'This review no longer belongs to the current submission',
      409,
    );
    this.revision(experiment, input.expectedRevision);
    check(
      review.subjectRevision === experiment.workflow.revision,
      'revision_conflict',
      'Review is pinned to a different experiment revision',
      409,
    );
    const submission = experiment.submissions.find((s) => s.reviewId === review.id);
    check(
      submission &&
        submission.attemptIndex === experiment.attempt.index &&
        submission.subjectRevision === review.subjectRevision,
      'stale_review',
      'The review must pin this exact attempt and submission',
      409,
    );
    check(
      submission.stage === (experiment.workflow.state === 'design_review' ? 'design' : 'results') &&
        submission.producerId === review.producerId,
      'stale_review',
      'The review submission identity does not match',
      409,
    );
    const ids = [
      ...new Set([
        ...submission.evidence.map((e) => e.artifactId),
        ...submission.figureIds,
        ...(submission.paperProposal ? [submission.paperProposal.artifact.id] : []),
      ]),
    ];
    check(
      digest(ids) === digest(review.artifactIds),
      'stale_review',
      'Review evidence differs from the sealed submission',
      409,
    );
    await this.program.reviewCapture(caller, experiment, tx);
    this.route(submission.stage, input);
    await this.reviews.checkSubmit(caller, review.id, input, tx);
    // A pass applies the paper proposal; what that would hit is part of the verdict's check.
    if (input.verdict === 'pass' && submission.paperProposal)
      await this.paper.checkAccept(
        caller,
        {
          proposalId: submission.paperProposal.id,
          source: submission.paperProposal.source,
          reviewId: review.id,
        },
        tx,
      );
  }
  /** Exit readiness checks share actual submission validation; dispatch admission remains separate. */
  private async checkAction(context: WorkflowCheckContext): Promise<void> {
    const { caller, tx } = context,
      experiment = await this.get(caller, context.snapshot.id, tx);
    const action = context.transition;
    if (context.input?.expectedRevision !== undefined)
      this.revision(experiment, context.input.expectedRevision as number);
    if (
      (action &&
        [
          'approve_design',
          'revise_design',
          'accept_results',
          'revise_plan',
          'revise_execution',
        ].includes(action)) ||
      (!action && ['design_review', 'experiment_review'].includes(experiment.workflow.state))
    ) {
      check(context.input, 'review_input_required', 'A complete verdict is required', 409);
      const input = context.input as unknown as ReviewApplication;
      await this.checkReview(caller, experiment, input, tx);
      const submission = experiment.submissions.find((s) => s.reviewId === input.reviewId)!;
      check(
        !action || this.route(submission.stage, input) === action,
        'invalid_review_return',
        'The verdict does not select this transition',
      );
      return;
    }
    if (action === 'abandon' || action === 'mark_failed') {
      await this.scope.require(caller, 'write', tx);
      check(
        !terminal.has(experiment.workflow.state),
        'experiment_closed',
        'The experiment is already terminal',
        409,
      );
      await this.program.assertAdministration(caller, experiment, tx);
      if (context.input)
        check(
          typeof (context.input.evidence as Data | undefined)?.reason === 'string' &&
            !!(context.input.evidence as Data).reason,
          'reason_required',
          'Ending an experiment requires a reason',
        );
      return;
    }
    await this.program.assertProducer(caller, experiment, tx);
    if (action === 'submit_design' || action === 'submit_results') {
      check(
        experiment.workflow.state === (action === 'submit_design' ? 'planned' : 'running'),
        'invalid_transition',
        'This submission is not available in the current state',
        409,
      );
      const selection = await this.selected(
        caller,
        experiment,
        action === 'submit_design' ? ['plan'] : ['result', 'report'],
        tx,
      );
      const own = this.one(selection, action === 'submit_design' ? 'plan' : 'report');
      check(
        await this.authoredInExecution(
          caller,
          await this.artifacts.get(caller, own.artifactId, tx),
          tx,
        ),
        'invalid_evidence_author',
        'The submitting worker must retain and attach its own plan or report after verifying any inherited evidence',
        403,
      );
      if (action === 'submit_results') {
        check(
          selection.some((e) => e.role === 'result'),
          'experiment_evidence_required',
          'At least one result is required',
          409,
        );
        this.approved(experiment);
        await this.workflows.checkDependencies(caller, experiment.id, tx);
        if (typeof context.input?.paperChangesArtifactId === 'string')
          await this.paper.validate(caller, context.input.paperChangesArtifactId, tx);
      }
      await this.prepareSubmission(
        caller,
        experiment,
        action === 'submit_design' ? 'design' : 'results',
        tx,
      );
    }
    if (action === 'retry_running')
      check(
        experiment.workflow.state === 'running',
        'invalid_transition',
        'retry_running is available only during execution',
        409,
      );
  }
  private revision(experiment: Experiment, expected: number): void {
    check(
      Number.isSafeInteger(expected) && experiment.workflow.revision === expected,
      'revision_conflict',
      'The experiment changed; read its current revision',
      409,
    );
  }
  private async addAttempt(
    id: string,
    index: number,
    revision: number,
    previous: number | null,
    feedback: string[],
    createdAt: string,
    tx: Transaction,
    feedbackReviewIds: string[] = [],
  ): Promise<void> {
    await tx.run(
      'INSERT INTO experiment_attempts(experiment_id,attempt_index,started_revision,previous_index,feedback,created_at,feedback_review_ids) VALUES(?,?,?,?,?,?,?)',
      id,
      index,
      revision,
      previous,
      JSON.stringify(feedback),
      createdAt,
      JSON.stringify(feedbackReviewIds),
    );
  }
  private async feedback(
    experiment: Experiment,
    note: string,
    tx: Transaction,
    reviewId?: string,
  ): Promise<void> {
    await tx.run(
      'UPDATE experiment_attempts SET feedback=?,feedback_review_ids=? WHERE experiment_id=? AND attempt_index=?',
      JSON.stringify([...experiment.attempt.feedback, note]),
      JSON.stringify([...experiment.attempt.feedbackReviewIds, ...(reviewId ? [reviewId] : [])]),
      experiment.id,
      experiment.attempt.index,
    );
  }
  private async saveEvidence(
    caller: Caller,
    experiment: Experiment,
    role: ExperimentEvidence['role'],
    path: string,
    artifact: Artifact,
    resultFormat: 'json' | 'qualitative' | undefined,
    systemGenerated: boolean,
    tx: Transaction,
    figureIds: string[] = [],
  ): Promise<ExperimentEvidence> {
    const sequence =
      ((
        await tx.get<{ sequence: number }>(
          'SELECT COALESCE(MAX(sequence),0) AS sequence FROM experiment_evidence WHERE experiment_id=?',
          experiment.id,
        )
      )?.sequence ?? 0) + 1;
    const evidence: ExperimentEvidence = {
      id: newId('exp_ev'),
      experimentId: experiment.id,
      attemptIndex: experiment.attempt.index,
      role,
      path,
      artifactId: artifact.id,
      hash: artifact.hash,
      figureIds,
      createdBy: caller.actorId,
      sessionId: caller.session?.id ?? null,
      createdAt: now(),
      sequence,
      current: true,
      ...(resultFormat ? { resultFormat } : {}),
      systemGenerated,
    };
    await tx.run(
      'INSERT INTO experiment_evidence(id,experiment_id,attempt_index,role,path,sequence,record) VALUES(?,?,?,?,?,?,?)',
      evidence.id,
      experiment.id,
      experiment.attempt.index,
      role,
      path,
      sequence,
      JSON.stringify(evidence),
    );
    // A plan and a report are one document each: a newer one at another path replaces the
    // earlier, so an attempt is never stuck with two current plans and no way to choose.
    if (role === 'plan' || role === 'report')
      await tx.run(
        'DELETE FROM experiment_slots WHERE experiment_id=? AND attempt_index=? AND role=? AND path<>?',
        experiment.id,
        experiment.attempt.index,
        role,
        path,
      );
    await tx.run(
      'INSERT INTO experiment_slots(experiment_id,attempt_index,role,path,evidence_id) VALUES(?,?,?,?,?) ON CONFLICT(experiment_id,attempt_index,role,path) DO UPDATE SET evidence_id=excluded.evidence_id',
      experiment.id,
      experiment.attempt.index,
      role,
      path,
      evidence.id,
    );
    return evidence;
  }
  private async command<T>(
    caller: Caller,
    operation: string,
    input: { requestId: string },
    tx: Transaction,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    return await replayed(tx, 'experiment_commands', caller, operation, input, execute, {
      after: async () =>
        await this.scope.require(caller, operation === 'submit_review' ? 'review' : 'write', tx),
    });
  }
  private async record(caller: Caller, type: string, id: string, data: Data, tx: Transaction) {
    await recorded(this.state, tx, caller, `experiment.${type}`, id, data);
  }
  withdrawReviewOwner(): void {
    this.releaseReviewOwner?.();
    this.releaseReviewOwner = undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.withdrawReviewOwner();
    this.program.dispose();
  }
}
export const experimentsPlugin = {
  name: 'merv-experiments',
  inject: [
    'state',
    'scope',
    'artifacts',
    'workflows',
    'reviews',
    'contextBuilder',
    'claims',
    'paper',
  ],
  async apply(ctx: Context) {
    const experiments = await createService(
      new ExperimentService(
        ctx.state,
        ctx.scope,
        ctx.artifacts,
        ctx.workflows,
        ctx.reviews,
        ctx.contextBuilder,
        ctx.claims,
        undefined,
        ctx.paper,
      ),
    );
    ctx.inject(['code'], (ctx) => {
      ctx.effect(() => experiments.bindCode(ctx.code));
    });
    ctx.effect(function* () {
      yield () => experiments.close();
      yield ctx.provide('experiments', experiments);
      yield () => experiments.withdrawReviewOwner();
    });
  },
};
export default experimentsPlugin;
