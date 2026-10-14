import {
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
import type { SbxJobs } from '@sandboxes/jobs';
import type { SbxObjects } from '@sandboxes/storage';
import { mervRefusals } from '@sandboxes/merv-host/errors';

export interface CaptureEvidence {
  artifactIds: string[];
  refused: { nativeWorkflowId: string; captureNode: string; error: string }[];
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
};

export class SandboxEvidence implements SandboxCaptureEvidence {
  private reconciling?: Promise<void>;
  private readonly checkedWorks = new Map<string, number>();
  private readonly doneWorkflows = new Set<string>();
  private readonly doneWorks = new Set<string>();

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
        });
    }
    return result;
  }

  async reconcile(): Promise<void> {
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

  private async pass() {
    const works = await this.state.read((sql) =>
      sql.all<Work>(
        `SELECT project_id,namespace,account_id,work_ref,bool_and(retired=3) AS released, bool_and(retired>=1) AS quiesced
         FROM sandbox_run_intents GROUP BY 1,2,3,4`,
      ),
    );
    for (const work of works) {
      const key = JSON.stringify([work.project_id, work.namespace, work.work_ref]);
      if (this.doneWorks.has(key)) continue;
      try {
        const started = this.clock();
        const done = await this.work(work);
        if (done && work.quiesced && this.jobs && (await this.jobsDone(work)))
          this.checkedWorks.set(key, started);
        else this.checkedWorks.delete(key);
        if (done && work.released) this.doneWorks.add(key);
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
        (run) =>
          run.retired >= 1 &&
          (this.checkedWorks.get(JSON.stringify([projectId, run.namespace, instanceId])) ?? -Infinity) >=
            Date.parse(notBefore),
      )
    );
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
      for (const workflow of page.workflows) {
        await this.workflow(work, workflow);
        done &&= this.doneWorkflows.has(JSON.stringify([work.namespace, workflow.id]));
      }
      after = page.next;
    } while (after !== null);
    return done;
  }

  private async workflow(work: Work, workflow: WorkflowRecord) {
    if (!workflow.attempt_ref || !['completed', 'failed', 'cancelled'].includes(workflow.state))
      return;
    const key = JSON.stringify([work.namespace, workflow.id]);
    if (this.doneWorkflows.has(key)) return;
    let after: string | null = null;
    let pending = false;
    do {
      const page = await this.pipelines.captures(work.namespace, workflow.id, {
        after,
        limit: 128,
      });
      for (const node of page.captures) {
        if (await this.captureSettled(work, workflow.id, node.id)) continue;
        try {
          await this.register(work, workflow, node);
        } catch (error) {
          pending =
            !(await this.refuse(work, workflow.id, workflow.attempt_ref, node.id, error)) ||
            pending;
        }
      }
      after = page.next;
    } while (after !== null);
    if (!pending) this.doneWorkflows.add(key);
  }

  private async captureSettled(work: Work, workflow: string, node: string) {
    return !!(await this.state.read((sql) =>
      sql.get(
        'SELECT 1 FROM sandbox_capture_index WHERE project_id=? AND namespace=? AND workflow_id=? AND node_id=?',
        work.project_id,
        work.namespace,
        workflow,
        node,
      ),
    ));
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
    await this.state.transaction(async (tx) => {
      const caller = await this.scope.serviceActor('sandboxes', work.project_id, tx);
      const artifact = await this.artifacts.createCollection(
        caller,
        {
          title: clip(`Compute capture — ${workflow.name || workflow.id} / ${node.id}`, 200),
          sourceKey: `sbx:${digest([work.namespace, workflow.id, node.id])}`,
          files: files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          metadata: {
            ownerId: work.work_ref,
            attempt: workflow.attempt_ref,
            workflowId: workflow.id,
            captureNode: node.id,
            captureState: node.state,
            outputState:
              node.result.output_state ?? (node.state === 'succeeded' ? 'committed' : 'partial'),
            evidenceLimitations: [...workflow.evidence_limitations],
          },
        },
        tx,
      );
      await tx.run(
        `INSERT INTO sandbox_capture_index(project_id,namespace,work_ref,workflow_id,node_id,attempt_ref,artifact_id)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
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

  private async refuse(
    work: Work,
    workflow: string,
    attempt: string | null,
    node: string,
    error: unknown,
  ) {
    const status = (error as { status?: number })?.status;
    if (!status || status >= 500 || status === 409 || status === 429) return false;
    const detail = error instanceof Error ? clip(error.message, 500) : 'Evidence is unavailable';
    await this.state.transaction(async (tx) => {
      const row = await tx.get(
        `INSERT INTO sandbox_capture_index(project_id,namespace,work_ref,workflow_id,node_id,attempt_ref,error)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING 1`,
        work.project_id,
        work.namespace,
        work.work_ref,
        workflow,
        node,
        attempt,
        detail,
      );
      if (row)
        await recorded(
          this.state,
          tx,
          await this.scope.serviceActor('sandboxes', work.project_id, tx),
          'sandboxes.capture_refused',
          work.work_ref,
          { workflowId: workflow, captureNode: node, attempt, error: detail },
        );
    });
    return true;
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
