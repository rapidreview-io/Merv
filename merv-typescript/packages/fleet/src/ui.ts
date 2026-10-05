import type { Context } from 'cordis';
import { check, type Json, type UiCollectionSpec, type UiRecordSpec } from '@merv/contracts';
import type {} from '@merv/ui/types';
import { fleetRunning, live, present } from './running.js';

const collection: UiCollectionSpec = {
  noun: { singular: 'agent', plural: 'agents' },
  read: '/v1/fleet',
  key: 'id',
  title: 'title',
  search: ['owner.kind', 'owner.id'],
  states: { field: 'status', open: live, live, failed: ['refused'] },
  attention: { field: 'attention' },
  columns: [
    { type: 'name', label: 'Agent', field: 'title' },
    { type: 'state', label: 'Status', field: 'status' },
    { type: 'ago', label: 'Requested', field: 'createdAt' },
    { type: 'countdown', label: 'Time remaining', field: 'deadlineAt' },
  ],
  empty: {
    title: 'No agents allocated',
    hint: 'Agents appear here when a connected workflow or chat requests a machine.',
  },
  cadence: { liveMs: 5000, idleMs: 30_000, liveWhen: { field: 'status', in: live } },
};
const record: UiRecordSpec = {
  read: '/v1/fleet/{id}',
  title: 'title',
  state: 'status',
  standing: { verdict: 'status', clause: 'attention', clock: 'updatedAt' },
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
      when: { field: 'intent', in: ['run', 'drain'] },
      guard: {
        title: 'Stop this agent?',
        consequence: 'Any machine it holds is deleted. Work that has not been saved may be lost.',
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
/** Uses the existing collection view; no browser bundle or research dependency. */
export const fleetUiPlugin = {
  name: 'merv-fleet-ui',
  inject: ['fleet', 'scope', 'ui'],
  apply(ctx: Context) {
    ctx.effect(() =>
      ctx.ui.register({
        id: 'fleet',
        // Not in the rail: reached from the Agents and machines page and a machine's sidebar.
        label: 'Fleet requests',
        group: 'hidden',
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
          // Open work and the 50 latest ended allocations.
          return (await ctx.fleet.list(caller, 50)).map(present);
        },
      }),
    );
    // The Running page draws each open machine until a session binds it.
    ctx.effect(() =>
      ctx.ui.contribute(
        fleetRunning(ctx.fleet, (caller) =>
          ctx.scope.require(caller, 'admin').then(
            () => true,
            () => false,
          ),
        ),
      ),
    );
  },
};
export default fleetUiPlugin;
