import { z } from 'zod';
import {
  check,
  clip,
  digest,
  MervError,
  type ArtifactCollectionInput,
  type Artifacts,
  type Scope,
  type State,
} from '@merv/contracts';
import { pages } from './native-client.js';
import { NativeConnections } from './native-connections.js';
import type { NativeConnectionRow, NativeWorkRow } from './native-schema.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const invalid = (message: string): never => {
  throw new MervError('sandbox_evidence_invalid', message, 502);
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\\x00-\x1f\x7f]/.test(value) &&
      !/^[A-Za-z]:/.test(value) &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255),
  );
const entry = z
  .object({
    path: relativePath,
    object_id: id,
    sha256: hash,
    size_bytes: z.number().int().nonnegative().safe(),
    executable: z.boolean().optional(),
    content_type: z.string().optional(),
  })
  .strict();
const object = z.object({
  id,
  namespace: id,
  kind: z.enum(['file', 'directory']),
  state: z.literal('available'),
  sha256: hash,
  size_bytes: z.number().int().nonnegative().safe(),
  producer_pipeline_id: id,
  entries: z.array(entry).max(10_000).default([]),
  evidence_held: z.literal(true),
  expires_at: z.null(),
});
// Work resource summaries contain native identity/provenance, not unbounded node receipts.
const workflowSchema = z.object({
  id,
  state: z.enum(['running', 'cleaning_up', 'completed', 'failed', 'cancelled']),
  namespace: id,
  origin_grant_id: id.nullable(),
  attempt_ref: z.string().nullable().optional(),
  name: z.string(),
  evidence_limitations: z.array(z.record(z.string())).optional(),
});
const captureSchema = z.object({
  id,
  state: z.enum(['succeeded', 'failed', 'cancelled', 'skipped']),
  result: z.object({
    outputs: z.record(id).default({}),
    output_state: z.string().nullable().optional(),
  }),
});
const capturePageSchema = z.object({
  captures: z.array(captureSchema).max(10),
  next: id.nullable(),
});
const filesPageSchema = z.object({
  files: z.array(z.object({ name: relativePath, object_id: id })).max(500),
  next: z.string().regex(/^\d+$/).nullable(),
});
const referenceSchema = z.tuple([
  z.literal(1),
  id,
  id,
  // The workflow the captured work belongs to; references minted before 2026-10-04 say task or
  // experiment, which are those workflows' names.
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
  id,
  id,
  id,
  id,
  hash,
  z.number().int().nonnegative().safe(),
]);

/** Registers immutable native receipts, never downloads/reuploads captured bytes. */
export class NativeEvidence {
  /** Ended workflows whose every Capture is registered: a later pass has nothing to read. */
  private readonly settled = new Set<string>();
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly artifacts: Artifacts,
    private readonly connections: NativeConnections,
  ) {}

  async publish(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
    value: unknown,
  ): Promise<void> {
    const parsed = workflowSchema.safeParse(value);
    check(
      parsed.success,
      'sandbox_evidence_invalid',
      'Native capture provenance is incomplete',
      502,
    );
    const workflow = parsed.data;
    check(
      work.namespace === workflow.namespace &&
        work.connection_id === connection.id &&
        work.project_id === connection.project_id &&
        work.native_grant_id,
      'sandbox_evidence_invalid',
      'Native capture belongs to another work namespace',
      502,
    );
    // Native administrators may run unrelated workflows in this namespace.
    // Their outputs are not delegated Merv evidence and must not stall work cleanup.
    if (workflow.origin_grant_id === null) return;
    // A terminal Capture can still gain committed-object receipts during native
    // storage recovery. Freeze its immutable collection only after workflow cleanup ends.
    if (workflow.state === 'running' || workflow.state === 'cleaning_up') return;
    const key = JSON.stringify([connection.id, workflow.namespace, workflow.id]);
    if (this.settled.has(key)) return;
    // A workflow that names no attempt is the attempt of the assignment whose token launched
    // it; one no assignment of this work launched is not delegated Merv evidence either.
    const attempt =
      workflow.attempt_ref ??
      (
        await this.state.read((sql) =>
          sql.get<{ attempt_ref: string }>(
            'SELECT attempt_ref FROM sandbox_native_assignments WHERE project_id=? AND work_kind=? AND work_id=? AND native_token_id=?',
            work.project_id,
            work.work_kind,
            work.work_id,
            workflow.origin_grant_id,
          ),
        )
      )?.attempt_ref;
    if (!attempt) return;
    await this.connections.get(connection.id);
    for (const node of await this.captures(work, connection, workflow.id)) {
      const registered = await this.state.read((sql) =>
        sql.get(
          'SELECT 1 FROM sandbox_native_captures WHERE connection_id=? AND namespace=? AND workflow_id=? AND node_id=?',
          connection.id,
          workflow.namespace,
          workflow.id,
          node.id,
        ),
      );
      if (registered) continue;
      const files: ArtifactCollectionInput['files'] = [];
      const byName = new Map<string, string>();
      const add = (name: string, objectId: string, sha256: string, size: number) => {
        check(
          relativePath.safeParse(name).success,
          'sandbox_evidence_invalid',
          'Capture contains an invalid file path',
          502,
        );
        const existing = byName.get(name);
        check(
          existing === undefined || existing === objectId,
          'sandbox_evidence_invalid',
          'Capture file paths conflict',
          502,
        );
        if (existing) return;
        check(
          files.length < 10_000,
          'sandbox_evidence_invalid',
          'Capture exceeds the supported file count',
          502,
        );
        byName.set(name, objectId);
        files.push({
          name,
          size,
          hash: sha256,
          provider: 'sandboxes-native',
          reference: JSON.stringify([
            1,
            connection.id,
            workflow.namespace,
            work.work_kind,
            work.work_id,
            workflow.id,
            node.id,
            objectId,
            sha256,
            size,
          ]),
        });
      };
      const manifests: { name: string; objectId: string; sha256: string }[] = [];
      for (const [name, objectId] of Object.entries(node.result.outputs ?? {}).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        check(
          relativePath.safeParse(name).success,
          'sandbox_evidence_invalid',
          'Capture contains an invalid output path',
          502,
        );
        const output = await this.inspect(work, connection, workflow.id, objectId);
        if (output.kind === 'file') add(name, output.id, output.sha256, output.size_bytes);
        else {
          manifests.push({ name, objectId: output.id, sha256: output.sha256 });
          check(
            output.entries.reduce((sum, file) => sum + file.size_bytes, 0) === output.size_bytes,
            'sandbox_evidence_invalid',
            'Native directory size does not match its manifest',
            502,
          );
          for (const file of output.entries)
            add(`${name}/${file.path}`, file.object_id, file.sha256, file.size_bytes);
        }
      }
      // Terminal failed/cancelled captures may have uploaded some leaves without
      // finishing their directory manifest. The native service exposes only its
      // committed immutable leaf receipts; partial state stays explicit.
      for (const file of await this.retainedFiles(work, connection, workflow.id, node.id)) {
        const existing = byName.get(file.name);
        check(
          !existing || existing === file.object_id,
          'sandbox_evidence_invalid',
          'Capture file paths conflict',
          502,
        );
        if (existing) continue;
        const output = await this.inspect(work, connection, workflow.id, file.object_id);
        check(
          output.kind === 'file',
          'sandbox_evidence_invalid',
          'Partial capture entry is not a file',
          502,
        );
        add(file.name, output.id, output.sha256, output.size_bytes);
      }
      check(
        files.length <= 10_000,
        'sandbox_evidence_invalid',
        'Capture exceeds the supported file count',
        502,
      );
      await this.connections.get(connection.id);
      await this.state.transaction(async (tx) => {
        const current = await tx.get<NativeWorkRow>(
          'SELECT * FROM sandbox_native_work WHERE project_id=? AND work_kind=? AND work_id=?',
          work.project_id,
          work.work_kind,
          work.work_id,
        );
        check(
          current?.connection_id === connection.id &&
            current.namespace === workflow.namespace &&
            current.native_grant_id === work.native_grant_id,
          'sandbox_evidence_invalid',
          'Capture work binding changed',
          409,
        );
        const active = await tx.get<NativeConnectionRow>(
          'SELECT * FROM sandbox_native_connections WHERE id=?',
          connection.id,
        );
        check(
          active && !active.revoked_at && !active.revoke_pending,
          'sandbox_access_revoked',
          'Sandboxes connection was disconnected',
          403,
        );
        const caller = await this.scope.serviceActor('sandboxes', work.project_id, tx);
        const artifact = await this.artifacts.createCollection(
          caller,
          {
            title: clip(`Compute capture — ${workflow.name || workflow.id} / ${node.id}`, 200),
            sourceKey: `native:${digest([connection.id, workflow.namespace, workflow.id, node.id])}`,
            files: files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
            metadata: {
              ownerKind: work.work_kind,
              ownerId: work.work_id,
              attempt,
              nativeWorkflowId: workflow.id,
              captureNode: node.id,
              captureState: node.state,
              outputState:
                node.result.output_state ?? (node.state === 'succeeded' ? 'committed' : 'partial'),
              manifests,
              evidenceLimitations: workflow.evidence_limitations ?? [],
            },
          },
          tx,
        );
        await tx.run(
          `INSERT INTO sandbox_native_captures(connection_id,namespace,workflow_id,node_id,artifact_id,attempt_ref)
         VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
          connection.id,
          workflow.namespace,
          workflow.id,
          node.id,
          artifact.id,
          attempt,
        );
      });
    }
    this.settled.add(key);
  }
  private async captures(work: NativeWorkRow, connection: NativeConnectionRow, workflowId: string) {
    const captures: z.infer<typeof captureSchema>[] = [];
    const seen = new Set<string>();
    const read = async (after?: string) => {
      const parsed = capturePageSchema.safeParse(
        await this.connections.call<unknown>(
          connection,
          `/v1/delegations/works/${work.native_grant_id}/workflows/${workflowId}/captures`,
          { query: { limit: '1', ...(after ? { after } : {}) } },
        ),
      );
      check(parsed.success, 'sandbox_evidence_invalid', 'Invalid native capture page', 502);
      return parsed.data;
    };
    for await (const page of pages(read, () => invalid('Native capture cursor did not advance'))) {
      for (const capture of page.captures) {
        check(
          !seen.has(capture.id),
          'sandbox_evidence_invalid',
          'Repeated native capture receipt',
          502,
        );
        seen.add(capture.id);
        captures.push(capture);
      }
      check(
        captures.length <= 128,
        'sandbox_evidence_invalid',
        'Too many native capture nodes',
        502,
      );
      if (page.next !== null && !page.captures.length)
        invalid('Native capture cursor did not advance');
    }
    return captures;
  }
  private async retainedFiles(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
    workflowId: string,
    nodeId: string,
  ) {
    const files: { name: string; object_id: string }[] = [];
    const stuck = () => invalid('Native capture files cursor did not advance');
    const read = async (after?: string) => {
      const parsed = filesPageSchema.safeParse(
        await this.connections.call<unknown>(
          connection,
          `/v1/delegations/works/${work.native_grant_id}/workflows/${workflowId}/captures/${nodeId}/files`,
          { query: { limit: '500', ...(after ? { after } : {}) } },
        ),
      );
      check(parsed.success, 'sandbox_evidence_invalid', 'Invalid native capture files page', 502);
      return parsed.data;
    };
    let last = 0;
    for await (const page of pages(read, stuck)) {
      files.push(...page.files);
      check(files.length <= 10_000, 'sandbox_evidence_invalid', 'Too many captured files', 502);
      if (page.next === null) break;
      if (!(Number(page.next) > last)) stuck();
      last = Number(page.next);
    }
    return files;
  }
  private async inspect(
    work: NativeWorkRow,
    connection: NativeConnectionRow,
    workflowId: string,
    objectId: string,
  ) {
    const received = await this.connections.call<unknown>(
      connection,
      `/v1/delegations/works/${work.native_grant_id}/evidence/${objectId}`,
    );
    const parsed = object.safeParse(received);
    check(
      parsed.success &&
        parsed.data.id === objectId &&
        parsed.data.namespace === work.namespace &&
        parsed.data.producer_pipeline_id === workflowId,
      'sandbox_evidence_invalid',
      'Captured file is not retained by this work',
      502,
    );
    const paths = new Set<string>();
    for (const entry of parsed.data.entries) {
      check(
        !paths.has(entry.path),
        'sandbox_evidence_invalid',
        'Directory manifest has duplicate paths',
        502,
      );
      paths.add(entry.path);
    }
    for (const path of paths) {
      const parts = path.split('/');
      parts.pop();
      while (parts.length) {
        check(
          !paths.has(parts.join('/')),
          'sandbox_evidence_invalid',
          'Directory manifest paths overlap',
          502,
        );
        parts.pop();
      }
    }
    return parsed.data;
  }
  async download(
    projectId: string,
    reference: string,
  ): Promise<{ url: string; expiresAt: string }> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(reference);
    } catch {
      decoded = null;
    }
    const parsed = referenceSchema.safeParse(decoded);
    check(parsed.success, 'invalid_sandbox_evidence', 'Invalid retained file reference');
    const [, connectionId, namespace, kind, workId, workflowId, nodeId, objectId, sha256, size] =
      parsed.data;
    const work = await this.state.read((sql) =>
      sql.get<NativeWorkRow>(
        `SELECT w.* FROM sandbox_native_work w WHERE w.project_id=? AND w.work_kind=? AND w.work_id=?
       AND w.connection_id=? AND w.namespace=? AND EXISTS (
         SELECT 1 FROM sandbox_native_captures c WHERE c.connection_id=w.connection_id
         AND c.namespace=w.namespace AND c.workflow_id=? AND c.node_id=?)`,
        projectId,
        kind,
        workId,
        connectionId,
        namespace,
        workflowId,
        nodeId,
      ),
    );
    check(work?.native_grant_id, 'not_found', 'Retained file does not belong to this project', 404);
    const original = await this.state.read((sql) =>
      sql.get<NativeConnectionRow>(
        'SELECT * FROM sandbox_native_connections WHERE id=?',
        connectionId,
      ),
    );
    check(
      original?.project_id === projectId,
      'not_found',
      'Retained file does not belong to this project',
      404,
    );
    const connection =
      original.revoked_at || original.revoke_pending
        ? await this.connections.current(projectId)
        : await this.connections.get(connectionId);
    check(
      connection && connection.account_id === original.account_id,
      'sandbox_access_revoked',
      'Sandboxes connection was disconnected',
      403,
    );
    check(
      connection.project_id === projectId,
      'not_found',
      'Retained file does not belong to this project',
      404,
    );
    const file = await this.inspect(work, connection, workflowId, objectId);
    check(
      file.kind === 'file' && file.sha256 === sha256 && file.size_bytes === size,
      'sandbox_evidence_invalid',
      'Retained file identity changed',
      502,
    );
    const response = await this.connections.call<{
      object: { id: string; sha256: string; size_bytes: number };
      url: string;
    }>(connection, `/v1/delegations/works/${work.native_grant_id}/evidence/${objectId}/download`);
    const downloadObject = object.omit({ evidence_held: true }).safeParse(response?.object);
    check(
      downloadObject.success &&
        downloadObject.data.id === objectId &&
        downloadObject.data.namespace === namespace &&
        downloadObject.data.producer_pipeline_id === workflowId &&
        downloadObject.data.kind === 'file' &&
        downloadObject.data.sha256 === sha256 &&
        downloadObject.data.size_bytes === size,
      'sandbox_evidence_invalid',
      'Download does not match the retained file',
      502,
    );
    let target: URL | undefined;
    try {
      target = new URL(response.url);
    } catch {
      /* refused below */
    }
    check(
      target && target.protocol === 'https:' && !target.username && !target.password,
      'sandbox_evidence_invalid',
      'Retained file download is unavailable',
      502,
    );
    await this.connections.get(connection.id);
    return { url: target.href, expiresAt: new Date(Date.now() + 240_000).toISOString() };
  }
}
