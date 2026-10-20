import type { Context } from 'cordis';
import {
  keyId,
  type RunningAction,
  type RunningFact,
  type RunningMoney,
  type RunningPhrase,
} from '@merv/contracts';
import { MachineViews } from '@sandboxes/merv-host/view';
import type {} from '@sandboxes/composition';
import type { RunningContribution, RunningRead } from '@merv/ui/types';

interface Machine {
  id: string;
  name: string;
  state: string;
  plugin: string;
  offer: {
    region: string | null;
    resources: { gpu: string | null; gpu_count: number; cpu: number | null; memory_mb: number };
  };
  activity: { verdict: string; clause: string | null; at: string | null };
  lease_expires_at: string | null;
  lease_seconds: number;
  hourly_price: RunningMoney | null;
  cost_so_far: RunningMoney | null;
}
const leased = (m: Machine) => ['provisioning', 'ready', 'unknown'].includes(m.state);
const working = (m: Machine) => ['running', 'starting', 'cancelling'].includes(m.activity.verdict);
const checkMachine = (m: Machine) => m.name.startsWith('merv-check-');
const size = (m: Machine) => {
  const r = m.offer.resources;
  return r.gpu_count
    ? `${r.gpu_count > 1 ? `${r.gpu_count}× ` : ''}${r.gpu ?? 'GPU'}`
    : r.cpu
      ? `CPU · ${r.cpu} vCPU`
      : 'CPU';
};
const standing = (m: Machine): RunningPhrase => {
  const word =
    { deleting: 'Releasing', stopped: 'Released', unreachable: 'Connection lost' }[
      m.activity.verdict
    ] ?? m.activity.verdict.replace(/^./, (s) => s.toUpperCase());
  return [word, ...(m.activity.at ? [' ', { since: m.activity.at }] : [])];
};
const attention = (m: Machine) => {
  if (checkMachine(m)) return undefined;
  const says: RunningPhrase | undefined =
    m.state === 'failed' || m.state === 'unknown'
      ? standing(m)
      : working(m) && m.lease_expires_at && Date.parse(m.lease_expires_at) - Date.now() < 900_000
        ? ['Lease ', { until: m.lease_expires_at }]
        : undefined;
  return says ? { says, who: 'A producer or operator extends or releases it.' } : undefined;
};

export function sandboxesRunning(ctx: Context): RunningContribution {
  const views = new MachineViews({
    registry: ctx.sbxRegistry,
    db: ctx.sbxDb,
    clock: ctx.sbxClock,
    settings: ctx.sbxSettings,
  });
  const cache = new Map<string, { watched: number; rows: Machine[]; at?: string }>();
  ctx.effect(() => {
    let refreshing = false;
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        for (const [projectId, entry] of cache) {
          if (Date.now() - entry.watched > 300_000) {
            cache.delete(projectId);
            continue;
          }
          try {
            const link = await ctx.sbxMerv.linked(projectId);
            const result = link
              ? ((await views.list(link.namespace)) as { sandboxes: Machine[] })
              : { sandboxes: [] };
            entry.rows = result.sandboxes;
            entry.at = new Date().toISOString();
          } catch {
            // Keep the last rows and timestamp so the lane becomes stale.
          }
        }
      } finally {
        refreshing = false;
      }
    }, 15_000);
    timer.unref();
    return () => clearInterval(timer);
  });
  const machines = (read: RunningRead) =>
    read.once('machines', async () => {
      await ctx.scope.require(read.caller, 'read');
      const entry = cache.get(read.caller.projectId) ?? { watched: 0, rows: [] };
      entry.watched = Date.now();
      cache.set(read.caller.projectId, entry);
      return {
        at: entry.at,
        rows: entry.rows.filter(
          (m) =>
            m.state !== 'stopped' &&
            (m.state !== 'failed' ||
              (m.activity.at && Date.now() - Date.parse(m.activity.at) < 3_600_000)),
        ),
      };
    });
  return {
    owner: 'sandboxes',
    kinds: ['sandbox'],
    lanes: ['hardware'],
    nodes: async (read) => {
      const { rows, at } = await machines(read);
      return {
        ...(at ? { asOf: at, freshForMs: 30_000 } : { pending: true as const }),
        nodes: rows.map((m) => ({
          key: `sandbox:${m.id}`,
          lane: 'hardware',
          title: size(m),
          name: m.name,
          lines: [
            standing(m),
            ...(m.hourly_price ? [[{ money: null, rate: m.hourly_price }]] : []),
          ],
          units: {
            count: Math.min(Math.max(m.offer.resources.gpu_count, 1), 64),
            busy: working(m),
          },
          look: m.state === 'provisioning' ? 'dashed' : m.state === 'deleting' ? 'quiet' : 'solid',
          rank: working(m) ? 0 : m.state === 'provisioning' ? 1 : 2,
          attention: attention(m),
        })),
      };
    },
    summary: async (read) => {
      const rates = (await machines(read)).rows
        .filter(leased)
        .flatMap((m) => (m.hourly_price ? [m.hourly_price] : []));
      const currency = rates[0]?.currency;
      return currency && rates.every((r) => r.currency === currency)
        ? {
            lane: 'hardware',
            says: [
              'Sandboxes ',
              {
                money: null,
                rate: {
                  currency,
                  amount: rates.reduce((total, r) => total + Number(r.amount), 0).toFixed(4),
                },
              },
            ],
            actions: [],
          }
        : null;
    },
    panel: async (read, key, absorbedBy) => {
      const m = (await machines(read)).rows.find((row) => row.id === keyId(key));
      if (!m) return null;
      const { caller } = read;
      const absorbed = absorbedBy !== undefined;
      const allowed =
        !absorbed &&
        (await ctx.scope.require(caller, 'write').then(
          () => true,
          () => false,
        ));
      const facts: RunningFact[] = [];
      if (m.hourly_price || m.cost_so_far)
        facts.push({
          label: 'Cost so far',
          value: [{ money: m.cost_so_far, rate: m.hourly_price }],
        });
      if (!absorbed && m.lease_expires_at && leased(m))
        facts.push({
          label: 'Lease',
          value: [{ until: m.lease_expires_at, of: m.lease_seconds }],
        });
      const actions: RunningAction[] = [];
      if (!absorbed && !checkMachine(m)) {
        if (m.state === 'ready')
          actions.push({
            label: 'Extend lease',
            verb: 'extend',
            tool: 'sandboxes.sandbox',
            // Adds an hour to what is left, read by the service: each press adds, and it never shortens.
            input: { action: 'renew', sandbox_id: m.id, extend_seconds: 3600 },
            allowed,
          });
        if (leased(m))
          actions.push({
            label: 'Release machine',
            verb: 'release',
            tool: 'sandboxes.sandbox',
            input: { action: 'delete', sandbox_id: m.id },
            allowed,
            guard: {
              title: 'Release this machine?',
              consequence:
                'Deletes this machine and stops its jobs. Retained job logs stay readable.',
            },
          });
      }
      return {
        header: {
          kind: 'Sandbox',
          title: m.name || size(m),
          says: [...standing(m), ...(m.activity.clause ? [' · ', m.activity.clause] : [])],
          attention: attention(m),
        },
        sections: [
          ...(facts.length
            ? [{ title: 'Now', place: 'activity' as const, kind: 'facts' as const, rows: facts }]
            : []),
          {
            title: 'Machine',
            place: 'machine',
            kind: 'facts',
            rows: [
              {
                label: 'Size',
                value: [
                  size(m),
                  ...(m.offer.resources.memory_mb
                    ? [` · ${m.offer.resources.memory_mb / 1024} GB`]
                    : []),
                ],
              },
              {
                label: 'Provider',
                value: [[m.plugin, m.offer.region].filter(Boolean).join(' · ')],
              },
            ],
          },
        ],
        actions,
        route: `/sandboxes/machines/${encodeURIComponent(m.id)}`,
        live: leased(m) || m.state === 'deleting',
      };
    },
  };
}
