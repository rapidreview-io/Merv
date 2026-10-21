import { bootMaintenance } from '@merv/contracts/maintenance';
import {
  captureTitle,
  check,
  clip,
  digest,
  MervError,
  recorded,
  type ArtifactCollectionInput,
  type Artifacts,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import type { SbxAccounts } from '@sandboxes/accounts';
import type { CaptureSummary, SbxPipelines, WorkflowRecord } from '@sandboxes/pipelines';
import { nodeTerminal, workflowTerminal } from '@sandboxes/pipelines/graph';
import type { SbxJobs } from '@sandboxes/jobs';
import type { SbxObjects } from '@sandboxes/storage';
import { mervRefusals } from '@sandboxes/merv-host/errors';

export interface CaptureEvidence {
  artifactIds: string[];
  /** `retrying`: not refused for good, only failing to register for CAPTURE_STALL_MS; it is
   *  still retried and registers once its cause clears. */
  refused: { nativeWorkflowId: string; captureNode: string; error: string; retrying?: true }[];
}

export interface SandboxCaptureEvidence {
  captures(
    projectId: string,
    instanceId: string,
    tx: Transaction,
    attempts?: string[],
  ): Promise<string[]>;
  evidence(
    projectId: string,
    works: readonly { instanceId: string; attempts?: string[] }[],
    tx: Transaction,
  ): Promise<Map<string, CaptureEvidence>>;
}

type Work = {
  project_id: string;
  namespace: string;
  account_id: string;
  work_ref: string;
  released: boolean;
  quiesced: boolean;
};
type Receipt = Omit<Work, 'account_id' | 'released' | 'quiesced'> & {
  workflow_id: string;
  node_id: string;
  attempt_ref: string | null;
  artifact_id: string | null;
  error: string | null;
  stalled: boolean;
};
const provider = 'sbx-evidence';
const refusals = mervRefusals(MervError);

export const sandboxEvidenceMigrations = {
  1: `
CREATE TABLE sandbox_capture_index(
  project_id TEXT NOT NULL,namespace TEXT NOT NULL,work_ref TEXT NOT NULL,
  workflow_id TEXT NOT NULL,node_id TEXT NOT NULL,attempt_ref TEXT,artifact_id TEXT,error TEXT,
  PRIMARY KEY(project_id,namespace,workflow_id,node_id)
);
CREATE INDEX sandbox_capture_work ON sandbox_capture_index(project_id,work_ref,attempt_ref);
`,
  // A stalled row shows a lasting failure as refused, yet is retried until it registers.
  2: `ALTER TABLE sandbox_capture_index ADD COLUMN stalled BOOLEAN NOT NULL DEFAULT false;`,
};

/** How long a capture may keep failing to register before it is shown as refused; it is still
 *  retried, so it registers once its cause is fixed. */
export const CAPTURE_STALL_MS = 10 * 60_000;

export class SandboxEvidence implements SandboxCaptureEvidence {
  private reconciling?: Promise<void>;
  private readonly checkedWorks = new Map<string, number>();
  private readonly doneWorkflows = new Set<string>();
  /** When each capture that is failing to register first failed, since this process started. */
  private readonly failing = new Map<string, number>();

  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly artifacts: Artifacts,
    private readonly pipelines: Pick<SbxPipelines, 'list' | 'captures' | 'captureFiles'>,
    private readonly objects: Pick<SbxObjects, 'evidence' | 'download'>,
    private readonly accounts: Pick<SbxAccounts, 'namespace'>,
    private readonly clock: () => number = Date.now,
    private readonly jobs?: Pick<SbxJobs, 'listPage'>,
  ) {}

  async initialize() {
    await this.state.migrate('sandbox-evidence', sandboxEvidenceMigrations);
  }

  async captures(projectId: string, instanceId: string, tx: Transaction, attempts?: string[]) {
    return (await this.evidence(projectId, [{ instanceId, attempts }], tx)).get(instanceId)!
      .artifactIds;
  }

  async evidence(
    projectId: string,
    works: readonly { instanceId: string; attempts?: string[] }[],
    tx: Transaction,
  ): Promise<Map<string, CaptureEvidence>> {
    this.state.assertTransaction(tx);
    const result = new Map(
      works.map((work) => [work.instanceId, { artifactIds: [], refused: [] } as CaptureEvidence]),
    );
    if (!works.length) return result;
    const attempts = new Map(works.map((work) => [work.instanceId, work.attempts]));
    const rows = await tx.all<Receipt>(
      `SELECT * FROM sandbox_capture_index WHERE project_id=? AND work_ref IN
       (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY namespace,workflow_id,node_id`,
      projectId,
      JSON.stringify(works.map((work) => work.instanceId)),
    );
    for (const row of rows) {
      const selected = attempts.get(row.work_ref);
      if (selected && !selected.includes(row.attempt_ref ?? '')) continue;
      const found = result.get(row.work_ref)!;
      if (row.artifact_id) found.artifactIds.push(row.artifact_id);
      if (row.error)
        found.refused.push({
          nativeWorkflowId: row.workflow_id,
          captureNode: row.node_id,
          error: row.error,
          ...(row.stalled ? { retrying: true as const } : {}),
        });
    }
    return result;
  }

  async reconcile(): Promise<void> {
    if (bootMaintenance.active) return;
    check(
      !this.state.ambient && !this.state.readScope,
      'sandbox_evidence_transaction',
      'Reconcile evidence outside Merv transactions',
      500,
    );
    return (this.reconciling ??= this.pass().finally(() => {
      this.reconciling = undefined;
    }));
  }

  async close(): Promise<void> {
    await this.reconciling?.catch(() => {});
  }

  /** A released work (its runs' `retired` 3) whose captures have all settled owes nothing more:
   *  its runs rise to 4, which no pass reads again, after a restart either. */
  private async pass() {
    const works = await this.state.read((sql) =>
      sql.all<Work>(
        `SELECT project_id,namespace,account_id,work_ref,bool_and(retired=3) AS released,
           bool_and(retired>=1) AS quiesced
         FROM sandbox_run_intents WHERE retired<4 GROUP BY 1,2,3,4`,
      ),
    );
    for (const work of works) {
      const key = JSON.stringify([work.project_id, work.namespace, work.work_ref]);
      try {
        const started = this.clock();
        const done = await this.work(work);
        if (done && work.quiesced && this.jobs && (await this.jobsDone(work)))
          this.checkedWorks.set(key, started);
        else this.checkedWorks.delete(key);
        if (done && work.released)
          await this.state.transaction((tx) =>
            tx.run(
              `UPDATE sandbox_run_intents SET retired=4
               WHERE retired=3 AND project_id=? AND namespace=? AND account_id=? AND work_ref=?`,
              work.project_id,
              work.namespace,
              work.account_id,
              work.work_ref,
            ),
          );
      } catch {
        this.checkedWorks.delete(key);
        // The next pass retries unavailable Sandboxes services.
      }
    }
  }

  /** Customer finalization waits for retired worker authority and a later complete evidence scan.
   * Provider I/O is confined to reconcile(), never held inside the caller's Merv transaction. */
  async settled(
    projectId: string,
    instanceId: string,
    epoch: string,
    notBefore: string,
    tx: Transaction,
  ) {
    this.state.assertTransaction(tx);
    const runs = await tx.all<{ namespace: string; retired: number }>(
      'SELECT namespace,retired FROM sandbox_run_intents WHERE project_id=? AND work_ref=? AND attempt_ref=?',
      projectId,
      instanceId,
      epoch,
    );
    return (
      runs.length > 0 &&
      runs.every(
        // A run at 4 was released with every capture settled, so nothing more can arrive.
        (run) =>
          run.retired >= 4 ||
          (run.retired >= 1 &&
            (this.checkedWorks.get(JSON.stringify([projectId, run.namespace, instanceId])) ??
              -Infinity) >= Date.parse(notBefore)),
      )
    );
  }

  /**
   * Whether a workflow's captures have settled, as the evidence pass and the compute waiter both
   * read it: once it has finished and each capture node that ended is registered or refused for
   * good, `refused` when any was refused, else `registered`. A stalled capture is still retried,
   * so it has not settled. Null until then.
   */
  async workflowSettled(
    projectId: string,
    workflow: WorkflowRecord,
  ): Promise<'registered' | 'refused' | null> {
    if (!workflowTerminal(workflow.state)) return null;
    const rows = await this.state.read((sql) =>
      sql.all<{ node_id: string; error: string | null; stalled: boolean }>(
        'SELECT node_id,error,stalled FROM sandbox_capture_index WHERE project_id=? AND namespace=? AND workflow_id=?',
        projectId,
        workflow.namespace,
        workflow.id,
      ),
    );
    const settled = new Map(
      rows.filter((row) => !row.stalled).map((row) => [row.node_id, row.error !== null]),
    );
    const captures = workflow.request.nodes.filter(
      (node) =>
        node.kind === 'capture' && nodeTerminal(workflow.nodes[node.id]?.state ?? 'pending'),
    );
    if (!captures.every((node) => settled.has(node.id))) return null;
    return captures.some((node) => settled.get(node.id)) ? 'refused' : 'registered';
  }

  private async jobsDone(work: Work) {
    const page = await this.jobs!.listPage({
      namespace: work.namespace,
      workRef: work.work_ref,
      states: ['queued', 'launching', 'running', 'cancel_requested'],
      limit: 1,
    });
    return page.jobs.length === 0;
  }

  private async work(work: Work) {
    let after: string | null = null;
    let done = true;
    do {
      const page = await this.pipelines.list(work.namespace, {
        workRef: work.work_ref,
        after,
        limit: 500,
      });
      for (const workflow of page.workflows) done = (await this.workflow(work, workflow)) && done;
      after = page.next;
    } while (after !== null);
    return done;
  }

  /** Whether every capture of a finished workflow has settled, registering those not yet. A
   *  succeeded capture is final, so it registers while the rest of its workflow still runs; one
   *  that did not succeed waits for the workflow, whose cleanup may still recover its files. */
  private async workflow(work: Work, workflow: WorkflowRecord) {
    if (!workflow.attempt_ref) return false;
    const finished = workflowTerminal(workflow.state);
    const key = JSON.stringify([work.namespace, workflow.id]);
    if (this.doneWorkflows.has(key)) return true;
    const succeeded = finished
      ? []
      : workflow.request.nodes
          .filter(
            (node) => node.kind === 'capture' && workflow.nodes[node.id]?.state === 'succeeded',
          )
          .map((node) => node.id);
    if (!finished && !succeeded.length) return false;
    const rows = await this.state.read((sql) =>
      sql.all<{ node_id: string; stalled: boolean }>(
        'SELECT node_id,stalled FROM sandbox_capture_index WHERE project_id=? AND namespace=? AND workflow_id=?',
        work.project_id,
        work.namespace,
        workflow.id,
      ),
    );
    const indexed = new Set(rows.filter((row) => !row.stalled).map((row) => row.node_id));
    const stalled = new Set(rows.filter((row) => row.stalled).map((row) => row.node_id));
    // A running workflow is read again only when another of its captures has succeeded.
    if (!finished && succeeded.every((node) => indexed.has(node))) return false;
    let after: string | null = null;
    do {
      const page = await this.pipelines.captures(work.namespace, workflow.id, {
        after,
        limit: 128,
      });
      for (const node of page.captures) {
        if (indexed.has(node.id) || (!finished && node.state !== 'succeeded')) continue;
        const failing = JSON.stringify([work.namespace, workflow.id, node.id]);
        try {
          await this.register(work, workflow, node);
          this.failing.delete(failing);
        } catch (error) {
          await this.refuse(work, workflow, node.id, error, stalled.has(node.id));
        }
      }
      after = page.next;
    } while (after !== null);
    if (!finished) return false;
    const done = (await this.workflowSettled(work.project_id, workflow)) !== null;
    if (done) this.doneWorkflows.add(key);
    return done;
  }

  private async held(namespace: string, objectId: string) {
    const object = await refusals.call(() => this.objects.evidence(namespace, objectId));
    check(
      object.state === 'available',
      'sandbox_evidence_pending',
      'Captured object is not yet available held evidence',
      503,
    );
    return object;
  }

  private async register(work: Work, workflow: WorkflowRecord, node: CaptureSummary) {
    const files: ArtifactCollectionInput['files'] = [];
    for (let after = 0; ;) {
      const page = await this.pipelines.captureFiles(work.namespace, workflow.id, node.id, {
        after,
        limit: 500,
      });
      for (const file of page.files) {
        const object = await this.held(work.namespace, file.object_id);
        files.push({
          name: file.name,
          hash: object.sha256,
          size: object.size_bytes,
          provider,
          reference: JSON.stringify([work.namespace, work.account_id, file.object_id]),
        });
      }
      if (page.next === null) break;
      after = Number(page.next);
    }
    // A capture that did not succeed, or kept nothing, is kept as a record of that, and says so
    // where it is listed: it is not evidence of results.
    const kept = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} retained`
      : 'nothing retained';
    const outcome =
      node.state !== 'succeeded' ? ` (${node.state}, ${kept})` : files.length ? '' : ` (${kept})`;
    await this.state.transaction(async (tx) => {
      const caller = await this.scope.serviceActor('sandboxes', work.project_id, tx);
      const artifact = await this.artifacts.createCollection(
        caller,
        {
          // Ids first, so a clipped title still says which capture this is.
          title: clip(
            `${captureTitle(workflow.id, node.id)}${outcome}${
              workflow.name && workflow.name !== workflow.id ? ` — ${workflow.name}` : ''
            }`,
            200,
          ),
          sourceKey: `sbx:${digest([work.namespace, workflow.id, node.id])}`,
          files: files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          metadata: {
            ownerId: work.work_ref,
            attempt: workflow.attempt_ref,
            workflowId: workflow.id,
            captureNode: node.id,
            captureState: node.state,
            outputState:
              node.result.output_state ??
              (node.state === 'succeeded' ? 'committed' : files.length ? 'partial' : 'failed'),
            evidenceLimitations: [...workflow.evidence_limitations],
            // One held object per declared output, in this project's namespace: a later workflow
            // stages it with a stage input {object_id, path} instead of downloading every member.
            outputObjects: Object.fromEntries(
              Object.entries(node.result.outputs).filter(([, id]) => typeof id === 'string'),
            ),
          },
        },
        tx,
      );
      // A capture shown as stalled is no longer refused once it registers.
      await tx.run(
        `INSERT INTO sandbox_capture_index AS i(project_id,namespace,work_ref,workflow_id,node_id,attempt_ref,artifact_id)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,namespace,workflow_id,node_id)
         DO UPDATE SET artifact_id=excluded.artifact_id,error=NULL,stalled=false WHERE i.stalled`,
        work.project_id,
        work.namespace,
        work.work_ref,
        workflow.id,
        node.id,
        workflow.attempt_ref,
        artifact.id,
      );
    });
  }

  /** A capture's failure to register: one that may pass (an outage, a busy or unknown error) is
   *  retried every pass, and once it has lasted CAPTURE_STALL_MS it is also shown as refused, so
   *  nobody waits on it unseen, until it registers; any other refuses it for good. */
  private async refuse(
    work: Work,
    workflow: WorkflowRecord,
    node: string,
    error: unknown,
    shown: boolean,
  ) {
    const status = (error as { status?: number })?.status;
    let detail = error instanceof Error ? clip(error.message, 500) : 'Evidence is unavailable';
    const lasting = !status || status >= 500 || status === 409 || status === 429;
    const failing = JSON.stringify([work.namespace, workflow.id, node]);
    if (lasting) {
      const since = this.failing.get(failing) ?? this.clock();
      this.failing.set(failing, since);
      if (shown || this.clock() - since < CAPTURE_STALL_MS) return;
      detail = `Not registered after ${CAPTURE_STALL_MS / 60_000} minutes of failures; Merv keeps retrying: ${detail}`;
    } else this.failing.delete(failing);
    const { id: workflowId, attempt_ref: attempt } = workflow;
    await this.state.transaction(async (tx) => {
      // A stalled row may still turn into a lasting refusal; a refusal never changes.
      const row = await tx.get(
        `INSERT INTO sandbox_capture_index AS i(project_id,namespace,work_ref,workflow_id,node_id,attempt_ref,error,stalled)
         VALUES(?,?,?,?,?,?,?,${lasting}) ON CONFLICT(project_id,namespace,workflow_id,node_id)
         DO UPDATE SET error=excluded.error,stalled=false WHERE i.stalled AND NOT excluded.stalled
         RETURNING 1`,
        work.project_id,
        work.namespace,
        work.work_ref,
        workflowId,
        node,
        attempt,
        detail,
      );
      if (row)
        await recorded(
          this.state,
          tx,
          await this.scope.serviceActor('sandboxes', work.project_id, tx),
          lasting ? 'sandboxes.capture_stalled' : 'sandboxes.capture_refused',
          work.work_ref,
          { workflowId, captureNode: node, attempt, error: detail },
        );
    });
  }

  async download(_projectId: string, reference: string) {
    check(
      !this.state.ambient && !this.state.readScope,
      'sandbox_evidence_transaction',
      'Download evidence outside Merv transactions',
      500,
    );
    const [namespace, accountId, objectId] = JSON.parse(reference) as [string, string, string];
    const owner = await refusals.call(() => this.accounts.namespace(namespace));
    check(
      owner.account_id === accountId,
      'sandbox_access_revoked',
      'Retained namespace account changed',
      403,
    );
    await this.held(namespace, objectId);
    const { url } = await refusals.call(() =>
      this.objects.download(namespace, objectId, { ttlSeconds: 240 }),
    );
    return { url, expiresAt: new Date(this.clock() + 240_000).toISOString() };
  }
}

declare module 'cordis' {
  interface Context {
    sandboxEvidence: SandboxEvidence;
  }
}
