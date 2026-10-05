import { z } from 'zod';
import { check, type Json, type State, type UiManifestRow } from '@merv/contracts';
import type { NativeConnections } from './native-connections.js';
import type { NativeWorkRow } from './native-schema.js';
import type { SandboxRow } from './types.js';
import type { NativeMachineReads } from './native-types.js';
export type { NativeMachineReads } from './native-types.js';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().max(2048);
const instant = z.string().datetime({ offset: true }).nullable().optional();
const amount = z
  .object({
    amount: z.union([z.string().max(80), z.number().finite()]),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .nullable()
  .optional();
const resources = z.object({
  cpu: z.number().finite().nonnegative().nullable().optional(),
  memory_mb: z.number().finite().nonnegative().nullable().optional(),
  gpu: text.nullable().optional(),
  gpu_count: z.number().int().nonnegative().optional(),
});
// Deliberately select display fields: native records must never carry request/env/SSH secrets.
const machine = z.object({
  id,
  namespace: id,
  name: text.nullable().optional(),
  state: z.enum(['provisioning', 'ready', 'unknown', 'deleting', 'stopped', 'failed']),
  plugin: text.optional(),
  created_at: instant,
  updated_at: instant,
  lease_expires_at: instant,
  lease_seconds: z.number().int().nonnegative().optional(),
  hourly_price: amount,
  cost_so_far: amount,
  offer: z
    .object({ resources: resources.optional(), region: text.nullable().optional() })
    .nullable()
    .optional(),
  resources: resources.optional(),
  activity: z.object({ verdict: z.enum(['running', 'starting', 'idle']), at: instant }).optional(),
  last_error: z.object({ message: text }).nullable().optional(),
});
const page = z.object({ namespace: id, sandboxes: z.array(machine).max(100), next: id.nullable() });

/** Machines of open or unsettled work, each read through its pinned payer, never today's. */
export class NativeMachineReader implements NativeMachineReads {
  constructor(
    private readonly state: State,
    private readonly connections: NativeConnections,
  ) {}
  private works(projectId: string) {
    return this.state.read((sql) =>
      sql.all<NativeWorkRow>(
        `SELECT w.* FROM sandbox_native_work w JOIN sandbox_native_connections c ON c.id=w.connection_id AND c.project_id=w.project_id
         WHERE w.project_id=? AND w.native_grant_id IS NOT NULL AND w.namespace IS NOT NULL
         AND c.revoked_at IS NULL AND c.revoke_pending=FALSE AND (w.closed_at IS NULL OR w.transition_pending=TRUE) ORDER BY w.work_kind,w.work_id`,
        projectId,
      ),
    );
  }
  private display(value: z.infer<typeof machine>): Json {
    return {
      ...value,
      activity: value.activity ?? {},
      native_console_url: `${this.connections.client.origin}/ui`,
      console_origin: this.connections.client.origin,
    } as Json;
  }
  private async locallyRevoked(connectionId: string): Promise<boolean> {
    return !!(await this.state.read((sql) =>
      sql.get(
        'SELECT id FROM sandbox_native_connections WHERE id=? AND (revoked_at IS NOT NULL OR revoke_pending=TRUE)',
        connectionId,
      ),
    ));
  }
  private async listWork(projectId: string, work: NativeWorkRow): Promise<Json[]> {
    const connection = await this.connections.get(work.connection_id);
    check(
      connection.project_id === projectId && id.safeParse(work.native_grant_id).success,
      'sandbox_scope_conflict',
      'Native machine scope changed',
      409,
    );
    const result: Json[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>();
    let after: string | undefined;
    for (let count = 0; count < 100; count++) {
      const parsed = page.safeParse(
        await this.connections.client.request(
          `/v1/delegations/works/${work.native_grant_id}/machines`,
          this.connections.bearer(connection),
          { query: { limit: '100', include_stopped: 'true', ...(after ? { after } : {}) } },
        ),
      );
      check(
        parsed.success && parsed.data.namespace === work.namespace,
        'sandbox_machines_invalid',
        'Native machine list has invalid provenance',
        502,
      );
      for (const row of parsed.data.sandboxes) {
        check(
          row.namespace === work.namespace && !ids.has(row.id),
          'sandbox_machines_invalid',
          'Native machine list has conflicting provenance',
          502,
        );
        ids.add(row.id);
        result.push(this.display(row));
      }
      if (parsed.data.next === null) break;
      check(
        !cursors.has(parsed.data.next) && count < 99,
        'sandbox_machines_invalid',
        'Native machine pagination did not finish',
        502,
      );
      cursors.add(parsed.data.next);
      after = parsed.data.next;
    }
    // Do not retain any pages fetched while this connection was disconnected.
    await this.connections.get(work.connection_id);
    return result;
  }
  async list(projectId: string): Promise<Json[]> {
    const groups: { connectionId: string; rows: Json[] }[] = [];
    let count = 0;
    for (const work of await this.works(projectId)) {
      try {
        const rows = await this.listWork(projectId, work);
        count += rows.length;
        check(count <= 10_000, 'sandbox_machines_limit', 'Native machine list is too large', 503);
        groups.push({ connectionId: work.connection_id, rows });
      } catch (error) {
        if (
          (error as { code?: string }).code === 'sandbox_access_revoked' &&
          (await this.locallyRevoked(work.connection_id))
        )
          continue;
        throw error;
      }
    }
    // A previous work's root may have been revoked while later work was being read.
    const authorized = new Set((await this.works(projectId)).map((work) => work.connection_id));
    const rows = groups
      .filter((group) => authorized.has(group.connectionId))
      .flatMap((group) => group.rows);
    const ids = new Set<string>();
    for (const row of rows) {
      const identifier = (row as { id: string }).id;
      check(
        !ids.has(identifier),
        'sandbox_machines_invalid',
        'Native machine list has conflicting provenance',
        502,
      );
      ids.add(identifier);
    }
    return rows;
  }
  async record(projectId: string, machineId: string): Promise<Json | null> {
    check(id.safeParse(machineId).success, 'invalid_sandbox_id', 'Invalid sandbox identifier');
    for (const work of await this.works(projectId)) {
      try {
        const connection = await this.connections.get(work.connection_id);
        check(
          connection.project_id === projectId && id.safeParse(work.native_grant_id).success,
          'sandbox_scope_conflict',
          'Native machine scope changed',
          409,
        );
        const value = await this.connections.client.request(
          `/v1/delegations/works/${work.native_grant_id}/machines/${machineId}`,
          this.connections.bearer(connection),
        );
        const parsed = machine.safeParse(value);
        check(
          parsed.success &&
            parsed.data.namespace === work.namespace &&
            parsed.data.id === machineId,
          'sandbox_machines_invalid',
          'Native machine record has invalid provenance',
          502,
        );
        await this.connections.get(work.connection_id);
        return this.display(parsed.data);
      } catch (error) {
        if ((error as { code?: string }).code === 'sandbox_not_found') continue;
        if (
          (error as { code?: string }).code === 'sandbox_access_revoked' &&
          (await this.locallyRevoked(work.connection_id))
        )
          continue;
        throw error;
      }
    }
    return null;
  }
}

const spec: UiManifestRow = {
  id: 'compute',
  label: 'Compute',
  group: 'operations',
  order: 44,
  icon: 'code',
  collection: {
    noun: { singular: 'machine', plural: 'machines' },
    read: '/v1/delegations/machines',
    key: 'id',
    title: 'name',
    columns: [
      { label: 'Name', type: 'name', field: 'name' },
      { label: 'State', type: 'state', field: 'state' },
      {
        label: 'Hardware',
        type: 'phrase',
        fields: [
          { field: 'offer.resources.gpu_count', suffix: '× ' },
          { field: 'offer.resources.gpu' },
          { field: 'offer.resources.cpu', suffix: ' vCPU' },
        ],
        separator: ' · ',
      },
      { label: 'Lease', type: 'countdown', field: 'lease_expires_at' },
      { label: 'Cost', type: 'money', total: 'cost_so_far', rate: 'hourly_price' },
    ],
    liveness: { verdict: 'activity.verdict', clock: 'activity.at' },
    empty: { title: 'No project machines', hint: 'Machines created for this project appear here.' },
  },
  record: {
    read: '/v1/delegations/machines/{id}',
    title: 'name',
    state: 'state',
    standing: { verdict: 'activity.verdict', clock: 'activity.at' },
    act: [],
    details: [
      { label: 'Provider', field: 'plugin' },
      { label: 'CPU', field: 'offer.resources.cpu' },
      { label: 'GPU', field: 'offer.resources.gpu' },
      { label: 'Memory', field: 'offer.resources.memory_mb', unit: 'mib' },
    ],
    console: { label: 'Manage in Sandboxes', href: '/ui' },
  },
};
/** Existing collection/record renderer; resource reads stay native and actions stay in its console. */
export const nativeMachinesRow: SandboxRow = {
  id: 'sandboxes-native-compute',
  label: spec.label,
  group: spec.group,
  order: spec.order,
  path: '/compute',
  view: {
    kind: 'collection',
    icon: 'code',
    spec: spec.collection as Json,
    record: spec.record as Json,
  },
};
