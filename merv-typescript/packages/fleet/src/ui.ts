import type { Context } from 'cordis';
import { check, type Json, type UiCollectionSpec, type UiRecordSpec } from '@merv/contracts';
import type {} from '@merv/ui/types';
import type { FleetAllocation } from './types.js';

const live = [
  'queued',
  'provisioning',
  'launching',
  'starting',
  'running',
  'uncertain',
  'releasing',
];
const collection: UiCollectionSpec = {
  noun: { singular: 'agent', plural: 'agents' },
  read: '/v1/fleet',
  key: 'id',
  title: 'title',
  search: ['owner.kind', 'owner.id'],
  states: { field: 'phase', open: live, live, failed: ['uncertain'] },
  attention: { field: 'attention' },
  columns: [
    { type: 'name', label: 'Agent', field: 'title' },
    { type: 'state', label: 'Status', field: 'phase' },
    { type: 'text', label: 'Requested state', field: 'intent' },
    { type: 'ago', label: 'Started', field: 'createdAt' },
    { type: 'countdown', label: 'Time remaining', field: 'deadlineAt' },
  ],
  empty: {
    title: 'No agents allocated',
    hint: 'Agents appear here when a connected workflow or chat requests a machine.',
  },
  cadence: { liveMs: 5000, idleMs: 30_000, liveWhen: { field: 'phase', in: live } },
};
const record: UiRecordSpec = {
  read: '/v1/fleet/{id}',
  title: 'title',
  state: 'phase',
  standing: { verdict: 'phase', clause: 'attention', clock: 'updatedAt' },
  act: [
    {
      id: 'drain',
      label: 'Finish and release',
      verb: 'release',
      tool: 'fleet.drain',
      when: { field: 'intent', in: ['run'] },
    },
    {
      id: 'halt',
      label: 'Stop now',
      verb: 'halt',
      tool: 'fleet.halt',
      when: { field: 'phase', in: live },
      guard: {
        title: 'Stop this agent?',
        consequence: 'The machine will be deleted. Work that has not been saved may be lost.',
      },
    },
  ],
  details: [
    { label: 'Allocation', field: 'id', mono: true },
    { label: 'Owner', field: 'owner.id', mono: true },
    { label: 'Machine', field: 'runtime.sandboxId', mono: true },
    { label: 'Provider state', field: 'runtime.state' },
    { label: 'Deadline', field: 'deadlineAt', unit: 'instant' },
  ],
};
const present = (a: FleetAllocation): Json => ({
  id: a.id,
  title: `${a.owner.kind} agent`,
  owner: a.owner,
  phase: a.phase,
  intent: a.intent,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  deadlineAt: a.deadlineAt,
  attention: a.error
    ? 'Waiting for the runtime service; this machine still counts toward capacity.'
    : null,
  runtime: a.runtime ? { sandboxId: a.runtime.sandboxId, state: a.runtime.state } : null,
});
/** Uses the existing collection view; no browser bundle or research dependency. */
export const fleetUiPlugin = {
  name: 'merv-fleet-ui',
  inject: ['fleet', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'fleet',
        label: 'Fleet',
        group: 'operations',
        order: 20,
        path: '/fleet',
        view: {
          kind: 'collection',
          icon: 'sessions',
          spec: collection as Json,
          record: record as Json,
        },
        read: async (caller, params = {}) => {
          check(
            Object.keys(params).every((key) => key === 'id'),
            'invalid_fleet_query',
            'Unknown Fleet query',
          );
          if (params.id !== undefined) {
            check(
              typeof params.id === 'string' && params.id.length > 0 && params.id.length <= 200,
              'invalid_fleet_query',
              'Invalid allocation ID',
            );
            return present(await ctx.fleet.inspect(caller, params.id));
          }
          return (await ctx.fleet.list(caller)).map(present);
        },
      }),
    );
  },
};
export default fleetUiPlugin;
